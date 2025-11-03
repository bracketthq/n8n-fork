import {
	RoleChangeRequestDto,
	SettingsUpdateRequestDto,
	userDetailSchema,
	userBaseSchema,
	UsersListFilterDto,
	usersListSchema,
	ProvisionUserRequestDto,
	type ProvisionUserResponse,
	GetUserCredentialsRequestDto,
	type GetUserCredentialsResponse,
} from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import type { PublicUser } from '@n8n/db';
import {
	Project,
	User,
	AuthIdentity,
	ProjectRepository,
	SharedCredentialsRepository,
	SharedWorkflowRepository,
	UserRepository,
	ApiKeyRepository,
	AuthenticatedRequest,
	GLOBAL_ADMIN_ROLE,
	GLOBAL_OWNER_ROLE,
} from '@n8n/db';
import {
	GlobalScope,
	Delete,
	Get,
	RestController,
	Patch,
	Post,
	Licensed,
	Body,
	Param,
	Query,
} from '@n8n/decorators';
import { hasGlobalScope, getApiKeyScopesForRole } from '@n8n/permissions';
import { Response } from 'express';

import { AuthService } from '@/auth/auth.service';
import { CredentialsService } from '@/credentials/credentials.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { EventService } from '@/events/event.service';
import { ExternalHooks } from '@/external-hooks';
import { UserRequest } from '@/requests';
import { FolderService } from '@/services/folder.service';
import { JwtService } from '@/services/jwt.service';
import { PasswordUtility } from '@/services/password.utility';
import { ProjectService } from '@/services/project.service.ee';
import { PublicApiKeyService } from '@/services/public-api-key.service';
import { UserService } from '@/services/user.service';
import { WorkflowService } from '@/workflows/workflow.service';

@RestController('/users')
export class UsersController {
	constructor(
		private readonly logger: Logger,
		private readonly externalHooks: ExternalHooks,
		private readonly sharedCredentialsRepository: SharedCredentialsRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly userRepository: UserRepository,
		private readonly authService: AuthService,
		private readonly userService: UserService,
		private readonly projectRepository: ProjectRepository,
		private readonly workflowService: WorkflowService,
		private readonly credentialsService: CredentialsService,
		private readonly projectService: ProjectService,
		private readonly eventService: EventService,
		private readonly folderService: FolderService,
		private readonly passwordUtility: PasswordUtility,
		private readonly publicApiKeyService: PublicApiKeyService,
		private readonly apiKeyRepository: ApiKeyRepository,
		private readonly jwtService: JwtService,
	) {}

	static ERROR_MESSAGES = {
		CHANGE_ROLE: {
			NO_USER: 'Target user not found',
			NO_ADMIN_ON_OWNER: 'Admin cannot change role on global owner',
			NO_OWNER_ON_OWNER: 'Owner cannot change role on global owner',
		},
	} as const;

	private removeSupplementaryFields(
		publicUsers: Array<Partial<PublicUser>>,
		listQueryOptions: UsersListFilterDto,
		currentUser: User,
	) {
		const { select } = listQueryOptions;

		// remove fields added to satisfy query

		if (select !== undefined && !select.includes('id')) {
			for (const user of publicUsers) delete user.id;
		}

		// remove computed fields (unselectable)

		if (select) {
			for (const user of publicUsers) {
				delete user.isOwner;
				delete user.isPending;
				delete user.signInType;
			}
		}

		const usersSeesAllDetails = hasGlobalScope(currentUser, 'user:create');
		return publicUsers.map((user) => {
			return usersSeesAllDetails || user.id === currentUser.id
				? userDetailSchema.parse(user)
				: userBaseSchema.parse(user);
		});
	}

	@Get('/')
	@GlobalScope('user:list')
	async listUsers(
		req: AuthenticatedRequest,
		_res: Response,
		@Query listQueryOptions: UsersListFilterDto,
	) {
		const userQuery = this.userRepository.buildUserQuery(listQueryOptions);

		const response = await userQuery.getManyAndCount();

		const [users, count] = response;

		const withInviteUrl = hasGlobalScope(req.user, 'user:create');

		const publicUsers = await Promise.all(
			users.map(async (u) => {
				const user = await this.userService.toPublic(u, {
					withInviteUrl,
					inviterId: req.user.id,
				});
				if (listQueryOptions.select && !listQueryOptions.select?.includes('role')) {
					delete user.role;
				}
				return {
					...user,
					projectRelations: u.projectRelations?.map((pr) => ({
						id: pr.projectId,
						role: pr.role.slug, // normalize role for frontend
						name: pr.project.name,
					})),
				};
			}),
		);

		return usersListSchema.parse({
			count,
			items: this.removeSupplementaryFields(publicUsers, listQueryOptions, req.user),
		});
	}

	@Get('/:id/password-reset-link')
	@GlobalScope('user:resetPassword')
	async getUserPasswordResetLink(req: UserRequest.PasswordResetLink) {
		const user = await this.userRepository.findOneOrFail({
			where: { id: req.params.id },
			relations: ['role'],
		});
		if (!user) {
			throw new NotFoundError('User not found');
		}

		if (
			req.user.role.slug === GLOBAL_ADMIN_ROLE.slug &&
			user.role.slug === GLOBAL_OWNER_ROLE.slug
		) {
			throw new ForbiddenError('Admin cannot reset password of global owner');
		}

		const link = this.authService.generatePasswordResetUrl(user);
		return { link };
	}

	@Patch('/:id/settings')
	@GlobalScope('user:update')
	async updateUserSettings(
		_req: AuthenticatedRequest,
		_res: Response,
		@Body payload: SettingsUpdateRequestDto,
		@Param('id') id: string,
	) {
		await this.userService.updateSettings(id, payload);

		const user = await this.userRepository.findOneOrFail({
			select: ['settings'],
			where: { id },
		});

		return user.settings;
	}

	/**
	 * Delete a user. Optionally, designate a transferee for their workflows and credentials.
	 */
	@Delete('/:id')
	@GlobalScope('user:delete')
	async deleteUser(req: UserRequest.Delete) {
		const { id: idToDelete } = req.params;

		if (req.user.id === idToDelete) {
			this.logger.debug(
				'Request to delete a user failed because it attempted to delete the requesting user',
				{ userId: req.user.id },
			);
			throw new BadRequestError('Cannot delete your own user');
		}

		const { transferId } = req.query;

		const userToDelete = await this.userRepository.findOne({
			where: { id: idToDelete },
			relations: ['role'],
		});

		if (!userToDelete) {
			throw new NotFoundError(
				'Request to delete a user failed because the user to delete was not found in DB',
			);
		}

		if (userToDelete.role.slug === GLOBAL_OWNER_ROLE.slug) {
			throw new ForbiddenError('Instance owner cannot be deleted.');
		}

		const personalProjectToDelete = await this.projectRepository.getPersonalProjectForUserOrFail(
			userToDelete.id,
		);

		if (transferId === personalProjectToDelete.id) {
			throw new BadRequestError(
				'Request to delete a user failed because the user to delete and the transferee are the same user',
			);
		}

		let transfereeId;

		if (transferId) {
			const transfereeProject = await this.projectRepository.findOneBy({ id: transferId });

			if (!transfereeProject) {
				throw new NotFoundError(
					'Request to delete a user failed because the transferee project was not found in DB',
				);
			}

			const transferee = await this.userRepository.findOneByOrFail({
				projectRelations: {
					projectId: transfereeProject.id,
				},
			});

			transfereeId = transferee.id;

			await this.userService.getManager().transaction(async (trx) => {
				await this.workflowService.transferAll(
					personalProjectToDelete.id,
					transfereeProject.id,
					trx,
				);
				await this.credentialsService.transferAll(
					personalProjectToDelete.id,
					transfereeProject.id,
					trx,
				);

				await this.folderService.transferAllFoldersToProject(
					personalProjectToDelete.id,
					transfereeProject.id,
					trx,
				);
			});

			await this.projectService.clearCredentialCanUseExternalSecretsCache(transfereeProject.id);
		}

		const [ownedSharedWorkflows, ownedSharedCredentials] = await Promise.all([
			this.sharedWorkflowRepository.find({
				select: { workflowId: true },
				where: { projectId: personalProjectToDelete.id, role: 'workflow:owner' },
			}),
			this.sharedCredentialsRepository.find({
				relations: { credentials: true },
				where: { projectId: personalProjectToDelete.id, role: 'credential:owner' },
			}),
		]);

		const ownedCredentials = ownedSharedCredentials.map(({ credentials }) => credentials);

		for (const { workflowId } of ownedSharedWorkflows) {
			await this.workflowService.delete(userToDelete, workflowId, true);
		}

		for (const credential of ownedCredentials) {
			await this.credentialsService.delete(userToDelete, credential.id);
		}

		await this.userService.getManager().transaction(async (trx) => {
			await trx.delete(AuthIdentity, { userId: userToDelete.id });
			await trx.delete(Project, { id: personalProjectToDelete.id });
			await trx.delete(User, { id: userToDelete.id });
		});

		this.eventService.emit('user-deleted', {
			user: req.user,
			publicApi: false,
			targetUserOldStatus: userToDelete.isPending ? 'invited' : 'active',
			targetUserId: idToDelete,
			migrationStrategy: transferId ? 'transfer_data' : 'delete_data',
			migrationUserId: transfereeId,
		});

		await this.externalHooks.run('user.deleted', [await this.userService.toPublic(userToDelete)]);

		return { success: true };
	}

	@Patch('/:id/role')
	@GlobalScope('user:changeRole')
	@Licensed('feat:advancedPermissions')
	async changeGlobalRole(
		req: AuthenticatedRequest,
		_: Response,
		@Body payload: RoleChangeRequestDto,
		@Param('id') id: string,
	) {
		const { NO_ADMIN_ON_OWNER, NO_USER, NO_OWNER_ON_OWNER } =
			UsersController.ERROR_MESSAGES.CHANGE_ROLE;

		const targetUser = await this.userRepository.findOne({
			where: { id },
			relations: ['role'],
		});
		if (targetUser === null) {
			throw new NotFoundError(NO_USER);
		}

		if (
			req.user.role.slug === GLOBAL_ADMIN_ROLE.slug &&
			targetUser.role.slug === GLOBAL_OWNER_ROLE.slug
		) {
			throw new ForbiddenError(NO_ADMIN_ON_OWNER);
		}

		if (
			req.user.role.slug === GLOBAL_OWNER_ROLE.slug &&
			targetUser.role.slug === GLOBAL_OWNER_ROLE.slug
		) {
			throw new ForbiddenError(NO_OWNER_ON_OWNER);
		}

		await this.userService.changeUserRole(req.user, targetUser, payload);

		this.eventService.emit('user-changed-role', {
			userId: req.user.id,
			targetUserId: targetUser.id,
			targetUserNewRole: payload.newRoleName,
			publicApi: false,
		});

		const projects = await this.projectService.getUserOwnedOrAdminProjects(targetUser.id);
		await Promise.all(
			projects.map(
				async (p) => await this.projectService.clearCredentialCanUseExternalSecretsCache(p.id),
			),
		);

		return { success: true };
	}

	/**
	 * Provision a user programmatically without email invite.
	 *
	 * Creates a new user account with:
	 * - A cryptographically secure random password (unknown to anyone, API-only access)
	 * - A personal project (standard n8n user setup)
	 * - An API key with appropriate scopes based on the user's role
	 *
	 * If the user already exists:
	 * - Checks if they already have a provisioned API key
	 * - If not, creates a new API key for them
	 * - If they do, returns an error to prevent duplicate provisioning
	 *
	 * @param req - Authenticated request (requires 'user:create' scope)
	 * @param payload - User data (email is required, firstName/lastName optional)
	 * @returns User ID, email, and API key for immediate use
	 * @throws BadRequestError if user exists with provisioned API key
	 */
	@Post('/provision-user')
	@GlobalScope('user:create')
	async provisionUser(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: ProvisionUserRequestDto,
	): Promise<ProvisionUserResponse> {
		this.logger.debug('User provision request received', {
			requestedBy: req.user.id,
			email: payload.email,
		});

		// Check if user already exists
		const existingUser = await this.userRepository.findOne({
			where: { email: payload.email },
			relations: ['role'],
		});

		if (existingUser) {
			this.logger.debug('User already exists, checking for existing provisioned API key', {
				email: payload.email,
				userId: existingUser.id,
			});

			// Check if user already has a provisioned API key
			const existingKeys = await this.publicApiKeyService.getRedactedApiKeysForUser(existingUser);
			const brackettKey = existingKeys.find((key) => key.label === 'Brackett API Key');

			if (brackettKey) {
				this.logger.warn('Attempted to re-provision user with existing API key', {
					userId: existingUser.id,
					email: existingUser.email,
				});
				throw new BadRequestError(
					'User already exists with a provisioned API key. Please use the existing credentials or delete the user first.',
				);
			}

			// Create new API key for existing user
			this.logger.info('Creating new API key for existing user', {
				userId: existingUser.id,
				email: existingUser.email,
			});

			const apiKeyData = await this.publicApiKeyService.createPublicApiKeyForUser(existingUser, {
				label: 'Brackett API Key',
				expiresAt: null,
				scopes: getApiKeyScopesForRole(existingUser),
			});

			return {
				user_id: existingUser.id,
				email: existingUser.email,
				api_key: apiKeyData.apiKey,
			};
		}

		//
		// User will never know this password - they can only authenticate via API key
		// const randomPassword = crypto.randomBytes(32).toString('base64url');
		// TEMPORARY: Using fixed password for ease of testing
		// TODO: Revert to random password generation before production and uncomment the above changes
		const randomPassword = 'Password@123';
		const hashedPassword = await this.passwordUtility.hash(randomPassword);

		this.logger.info('Creating new provisioned user', {
			email: payload.email,
			requestedBy: req.user.id,
		});

		// Create user with personal project (standard n8n user setup)
		const { user } = await this.userRepository.createUserWithProject({
			email: payload.email,
			password: hashedPassword,
			firstName: payload.firstName || '',
			lastName: payload.lastName || '',
			role: { slug: 'global:member' },
		});

		// Generate API key with appropriate scopes for the user's role
		const apiKeyData = await this.publicApiKeyService.createPublicApiKeyForUser(user, {
			label: 'Brackett API Key',
			expiresAt: null, // Never expires
			scopes: getApiKeyScopesForRole(user),
		});

		// Emit event for audit logging
		this.eventService.emit('user-invited', {
			user: req.user,
			targetUserId: [user.id],
			publicApi: false,
			emailSent: false,
			inviteeRole: 'global:member',
		});

		this.logger.info('User provisioned successfully', {
			userId: user.id,
			email: user.email,
			requestedBy: req.user.id,
		});

		return {
			user_id: user.id,
			email: user.email,
			api_key: apiKeyData.apiKey,
		};
	}

	/**
	 * Get user credentials by email or ID.
	 *
	 * Returns the most recent API key for a user.
	 * If the most recent key is expired, returns 404.
	 *
	 * SECURITY CONSIDERATIONS:
	 * - Returns FULL unredacted API key (highly sensitive)
	 * - All access is logged for audit trail
	 * - Requires 'user:read' scope
	 * - Only returns non-expired keys
	 *
	 * @param req - Authenticated request (requires 'user:read' scope)
	 * @param payload - Contains either email or id
	 * @returns User credentials with full unredacted API key
	 * @throws BadRequestError if neither email nor id provided
	 * @throws NotFoundError if user doesn't exist or has no valid API keys
	 */
	@Get('/credentials')
	@GlobalScope('user:read')
	async getUserCredentials(
		req: AuthenticatedRequest,
		_res: Response,
		@Query payload: GetUserCredentialsRequestDto,
	): Promise<GetUserCredentialsResponse> {
		// Validate that at least one identifier is provided
		if (!payload.email && !payload.id) {
			throw new BadRequestError('Either email or id must be provided');
		}

		const identifier = payload.id || payload.email;
		const identifierType = payload.id ? 'id' : 'email';

		this.logger.debug('User credentials request received', {
			requestedBy: req.user.id,
			identifierType,
			identifier,
		});

		// 1. Find user
		const user = await this.userRepository.findOne({
			where: payload.id ? { id: payload.id } : { email: payload.email },
			relations: ['role'],
		});

		if (!user) {
			this.logger.warn('User not found', {
				identifierType,
				identifier,
				requestedBy: req.user.id,
			});
			throw new NotFoundError(`User with ${identifierType} ${identifier} not found`);
		}

		// 2. Get ONLY the most recent API key
		const latestKey = await this.apiKeyRepository.findOne({
			where: {
				userId: user.id,
				audience: 'public-api',
			},
			order: { createdAt: 'DESC' },
		});

		if (!latestKey) {
			this.logger.warn('User has no API keys', {
				userId: user.id,
				email: user.email,
				requestedBy: req.user.id,
			});
			throw new NotFoundError(`No API keys found for user`);
		}

		// 3. Check if the key is expired
		const decoded = this.jwtService.decode(latestKey.apiKey);
		const now = Math.floor(Date.now() / 1000);

		if (decoded?.exp && decoded.exp <= now) {
			this.logger.warn('Most recent API key is expired', {
				userId: user.id,
				email: user.email,
				expiredAt: decoded.exp,
				requestedBy: req.user.id,
			});
			throw new NotFoundError(`API key for user has expired`);
		}

		// 4. Log access for security audit
		this.logger.warn('SENSITIVE: Full API key retrieved', {
			userId: user.id,
			email: user.email,
			apiKeyLabel: latestKey.label,
			requestedBy: req.user.id,
			lookupMethod: identifierType,
		});

		this.eventService.emit('user-retrieved-user', {
			userId: req.user.id,
			publicApi: false,
		});

		// 5. Return credentials
		return {
			user_id: user.id,
			email: user.email,
			api_key: latestKey.apiKey,
			label: latestKey.label,
			expires_at: decoded?.exp ?? null,
			created_at: latestKey.createdAt.toISOString(),
		};
	}
}
