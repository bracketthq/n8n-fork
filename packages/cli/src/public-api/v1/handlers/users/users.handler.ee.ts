import {
	InviteUsersRequestDto,
	ProvisionUserRequestDto,
	GetUserCredentialsRequestDto,
	RoleChangeRequestDto,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { ProjectRelationRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import type express from 'express';
import type { Response } from 'express';

import { InvitationController } from '@/controllers/invitation.controller';
import { UsersController } from '@/controllers/users.controller';
import { EventService } from '@/events/event.service';
import type { UserRequest } from '@/requests';

import { clean, getAllUsersAndCount, getUser } from './users.service.ee';
import {
	apiKeyHasScopeWithGlobalScopeFallback,
	isLicensed,
	validCursor,
	validLicenseWithUserQuota,
} from '../../shared/middlewares/global.middleware';
import { encodeNextCursor } from '../../shared/services/pagination.service';

type Create = AuthenticatedRequest<{}, {}, InviteUsersRequestDto>;
type Provision = AuthenticatedRequest<{}, {}, ProvisionUserRequestDto>;
type GetCredentials = AuthenticatedRequest<{}, {}, {}, GetUserCredentialsRequestDto>;
type Delete = UserRequest.Delete;
type ChangeRole = AuthenticatedRequest<{ id: string }, {}, RoleChangeRequestDto, {}>;

export = {
	getUser: [
		validLicenseWithUserQuota,
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'user:read' }),
		async (req: UserRequest.Get, res: express.Response) => {
			const { includeRole = false } = req.query;
			const { id } = req.params;

			const user = await getUser({ withIdentifier: id, includeRole });

			if (!user) {
				return res.status(404).json({
					message: `Could not find user with id: ${id}`,
				});
			}

			Container.get(EventService).emit('user-retrieved-user', {
				userId: req.user.id,
				publicApi: true,
			});

			return res.json(clean(user, { includeRole }));
		},
	],
	getUsers: [
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'user:list' }),
		validLicenseWithUserQuota,
		validCursor,
		async (req: UserRequest.Get, res: express.Response) => {
			const { offset = 0, limit = 100, includeRole = false, projectId } = req.query;

			const _in = projectId
				? await Container.get(ProjectRelationRepository).findUserIdsByProjectId(projectId)
				: undefined;

			const [users, count] = await getAllUsersAndCount({
				includeRole,
				limit,
				offset,
				in: _in,
			});

			Container.get(EventService).emit('user-retrieved-all-users', {
				userId: req.user.id,
				publicApi: true,
			});

			return res.json({
				data: clean(users, { includeRole }),
				nextCursor: encodeNextCursor({
					offset,
					limit,
					numberOfTotalRecords: count,
				}),
			});
		},
	],
	createUser: [
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'user:create' }),
		async (req: Create, res: Response) => {
			const { data, error } = InviteUsersRequestDto.safeParse(req.body);
			if (error) {
				return res.status(400).json(error.errors[0]);
			}

			const usersInvited = await Container.get(InvitationController).inviteUser(
				req,
				res,
				data as InviteUsersRequestDto,
			);
			return res.status(201).json(usersInvited);
		},
	],
	/**
	 * Public API endpoint for programmatic user provisioning.
	 * Creates users without email invites and returns API key for immediate authentication.
	 * Requires API key with 'user:create' scope.
	 */
	provisionUser: [
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'user:create' }),
		async (req: Provision, res: Response) => {
			// Validate request body
			const { data, error } = ProvisionUserRequestDto.safeParse(req.body);
			if (error) {
				return res.status(400).json(error.errors[0]);
			}

			// Delegate to UsersController for business logic
			const result = await Container.get(UsersController).provisionUser(req, res, data);
			return res.status(201).json(result);
		},
	],
	/**
	 * Public API endpoint for retrieving user credentials.
	 * Supports lookup by email or ID (preferred).
	 *
	 * SECURITY WARNING: Returns FULL unredacted API key.
	 * Requires API key with 'user:read' scope.
	 */
	getUserCredentials: [
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'user:read' }),
		async (req: GetCredentials, res: Response) => {
			// Validate query parameters
			const { data, error } = GetUserCredentialsRequestDto.safeParse(req.query);
			if (error) {
				return res.status(400).json(error.errors[0]);
			}

			try {
				const result = await Container.get(UsersController).getUserCredentials(req, res, data);
				return res.status(200).json(result);
			} catch (err) {
				if (err.name === 'NotFoundError' || err.name === 'BadRequestError') {
					const statusCode = err.name === 'NotFoundError' ? 404 : 400;
					return res.status(statusCode).json({ message: err.message });
				}
				throw err;
			}
		},
	],
	deleteUser: [
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'user:delete' }),
		async (req: Delete, res: Response) => {
			await Container.get(UsersController).deleteUser(req);

			return res.status(204).send();
		},
	],
	changeRole: [
		isLicensed('feat:advancedPermissions'),
		apiKeyHasScopeWithGlobalScopeFallback({ scope: 'user:changeRole' }),
		async (req: ChangeRole, res: Response) => {
			const validation = RoleChangeRequestDto.safeParse(req.body);
			if (validation.error) {
				return res.status(400).json({
					message: validation.error.errors[0],
				});
			}

			await Container.get(UsersController).changeGlobalRole(
				req,
				res,
				validation.data,
				req.params.id,
			);

			return res.status(204).send();
		},
	],
};
