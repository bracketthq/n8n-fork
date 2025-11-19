import { generateNanoId } from '../../utils/generators';
import type { MigrationContext, ReversibleMigration } from '../migration-types';

/**
 * Migration to create Brackett admin owner user and API key
 * This migration creates a default owner account for Brackett deployment
 */
export class AddBrackettOwnerUser1762329600000 implements ReversibleMigration {
	transaction = false as const;

	async up({ queryRunner, tablePrefix }: MigrationContext) {
		const userId = 'ef9ddb9d-ea94-4244-b182-f72c005a9735';
		const userEmail = 'admin@brackett.ai';
		const firstName = 'Admin';
		const lastName = 'Bracki';
		const projectId = generateNanoId();

		// Check if user already exists
		const existingUser = await queryRunner.query(
			`SELECT id FROM "${tablePrefix}user" WHERE id = ? OR email = ?`,
			[userId, userEmail],
		);

		if (existingUser && existingUser.length > 0) {
			// User already exists, skip migration
			return;
		}

		// Ensure the global:owner role exists in the role table
		const ownerRoleExists = await queryRunner.query(
			`SELECT slug FROM "${tablePrefix}role" WHERE slug = 'global:owner'`,
		);

		if (!ownerRoleExists || ownerRoleExists.length === 0) {
			// Insert the owner role if it doesn't exist
			await queryRunner.query(
				`INSERT INTO "${tablePrefix}role" ("slug", "displayName", "description", "systemRole", "roleType", "createdAt", "updatedAt")
				 VALUES ('global:owner', 'Owner', 'Instance owner', 1, 'global', datetime('now'), datetime('now'))`,
			);
		}

		// Get current timestamp for user activation
		const now = new Date().toISOString();

		// Insert user with roleSlug (note: 'role' column was removed in migration 1750252139170)
		await queryRunner.query(
			`INSERT INTO "${tablePrefix}user" (
				"id",
				"email",
				"firstName",
				"lastName",
				"password",
				"personalizationAnswers",
				"createdAt",
				"updatedAt",
				"settings",
				"disabled",
				"mfaEnabled",
				"mfaSecret",
				"mfaRecoveryCodes",
				"roleSlug"
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				userId,
				userEmail,
				firstName,
				lastName,
				'$2a$10$PHVDMvUA.V5iwCLXjSf9OOqIko3v6X.U/A22yKE0wGFtOwm5dlgWK',
				null,
				now,
				now,
				JSON.stringify({ userActivated: true, userActivatedAt: now }),
				0,
				0,
				null,
				null,
				'global:owner',
			],
		);

		// Create personal project for the user
		const personalProjectName = `${firstName} ${lastName} <${userEmail}>`;
		await queryRunner.query(
			`INSERT INTO "${tablePrefix}project" (
				"id",
				"name",
				"type",
				"createdAt",
				"updatedAt"
			) VALUES (?, ?, ?, ?, ?)`,
			[projectId, personalProjectName, 'personal', now, now],
		);

		// Ensure project:personalOwner role exists
		const personalOwnerRoleExists = await queryRunner.query(
			`SELECT slug FROM "${tablePrefix}role" WHERE slug = 'project:personalOwner'`,
		);

		if (!personalOwnerRoleExists || personalOwnerRoleExists.length === 0) {
			await queryRunner.query(
				`INSERT INTO "${tablePrefix}role" ("slug", "displayName", "description", "systemRole", "roleType", "createdAt", "updatedAt")
				 VALUES ('project:personalOwner', 'Personal project owner', 'Personal project owner', 1, 'project', datetime('now'), datetime('now'))`,
			);
		}

		// Link user to personal project
		await queryRunner.query(
			`INSERT INTO "${tablePrefix}project_relation" (
				"projectId",
				"userId",
				"role",
				"createdAt",
				"updatedAt"
			) VALUES (?, ?, ?, ?, ?)`,
			[projectId, userId, 'project:personalOwner', now, now],
		);

		// Insert API key
		const scopes = [
			'credential:create',
			'credential:delete',
			'credential:move',
			'project:create',
			'project:delete',
			'project:list',
			'project:update',
			'securityAudit:generate',
			'sourceControl:pull',
			'tag:create',
			'tag:delete',
			'tag:list',
			'tag:read',
			'tag:update',
			'user:changeRole',
			'user:create',
			'user:delete',
			'user:enforceMfa',
			'user:list',
			'user:read',
			'variable:create',
			'variable:delete',
			'variable:list',
			'variable:update',
			'workflow:create',
			'workflow:delete',
			'workflow:execute',
			'workflow:list',
			'workflow:move',
			'workflow:read',
			'workflow:update',
			'workflowTags:update',
			'workflowTags:list',
			'workflow:activate',
			'workflow:deactivate',
			'execution:delete',
			'execution:read',
			'execution:retry',
			'execution:list',
		];

		await queryRunner.query(
			`INSERT INTO "${tablePrefix}user_api_keys" (
				"id",
				"userId",
				"label",
				"apiKey",
				"createdAt",
				"updatedAt",
				"scopes",
				"audience"
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				'gdN0nvCO0D6jSqkK',
				userId,
				'Brackett-Admin',
				// This JWT token is signed with JWT_SECRET='brackett-n8n-secret-key-2025'
				// IMPORTANT: Set N8N_USER_MANAGEMENT_JWT_SECRET=brackett-n8n-secret-key-2025
				'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlZjlkZGI5ZC1lYTk0LTQyNDQtYjE4Mi1mNzJjMDA1YTk3MzUiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzYzMjc3NzQwfQ.8WKZqb4s4Une4ggtrXz-ZEOUx2yCKCYYh8lHHo8Jwbs',
				now,
				now,
				JSON.stringify(scopes),
				'public-api',
			],
		);

		// Mark instance owner setup as complete
		// This prevents the setup wizard from showing on UI
		await queryRunner.query(
			`UPDATE "${tablePrefix}settings" SET value = 'true' WHERE key = 'userManagement.isInstanceOwnerSetUp'`,
		);
	}

	async down({ queryRunner, tablePrefix }: MigrationContext) {
		const userId = 'ef9ddb9d-ea94-4244-b182-f72c005a9735';

		// Delete API key
		await queryRunner.query(`DELETE FROM "${tablePrefix}user_api_keys" WHERE "userId" = ?`, [
			userId,
		]);

		// Delete project relations (this will cascade to delete the project due to foreign key)
		await queryRunner.query(`DELETE FROM "${tablePrefix}project_relation" WHERE "userId" = ?`, [
			userId,
		]);

		// Delete personal project
		// Note: We need to get the project ID first since we generated it dynamically
		const personalProject = await queryRunner.query(
			`SELECT p.id FROM "${tablePrefix}project" p
			 INNER JOIN "${tablePrefix}project_relation" pr ON p.id = pr.projectId
			 WHERE pr.userId = ? AND p.type = 'personal'`,
			[userId],
		);
		if (personalProject && personalProject.length > 0) {
			await queryRunner.query(`DELETE FROM "${tablePrefix}project" WHERE "id" = ?`, [
				personalProject[0].id,
			]);
		}

		// Delete user
		await queryRunner.query(`DELETE FROM "${tablePrefix}user" WHERE "id" = ?`, [userId]);

		// Reset owner setup flag
		await queryRunner.query(
			`UPDATE "${tablePrefix}settings" SET value = 'false' WHERE key = 'userManagement.isInstanceOwnerSetUp'`,
		);
	}
}
