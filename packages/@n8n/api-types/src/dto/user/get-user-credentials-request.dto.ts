import { z } from 'zod';
import { Z } from 'zod-class';

/**
 * DTO for retrieving user credentials by email or ID.
 *
 * Provide EITHER email OR id (not both).
 * - id: Preferred method (faster, more stable)
 * - email: Legacy method (will be deprecated)
 *
 * SECURITY WARNING: This endpoint returns FULL unredacted API keys.
 * Should only be used in secure, server-to-server contexts.
 *
 * @property email - User's email address (legacy method)
 * @property id - User's UUID (preferred method)
 */
export class GetUserCredentialsRequestDto extends Z.class({
	email: z.string().email().optional(),
	id: z.string().uuid().optional(),
}) {}
