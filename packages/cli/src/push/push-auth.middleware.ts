import { Logger } from '@n8n/backend-common';
import type { AuthenticatedRequest } from '@n8n/db';
import { UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type { NextFunction, Response } from 'express';

import { AuthService } from '@/auth/auth.service';
import { JwtService } from '@/services/jwt.service';

/**
 * Middleware that supports dual authentication for push connections:
 * 1. API Key authentication (X-N8N-API-KEY header)
 * 2. Cookie-based JWT authentication (fallback)
 *
 * This allows both the n8n UI (cookie auth) and external services (API key auth)
 * to receive real-time execution events via WebSocket or SSE.
 */
@Service()
export class PushAuthMiddleware {
	constructor(
		private readonly authService: AuthService,
		private readonly userRepository: UserRepository,
		private readonly jwtService: JwtService,
		private readonly logger: Logger,
	) {}

	/**
	 * Creates middleware that accepts both API key and cookie authentication.
	 * Tries API key first (X-N8N-API-KEY header), falls back to cookies.
	 */
	createPushAuthMiddleware() {
		return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
			// 1. Try API key authentication first
			const apiKey = req.headers['x-n8n-api-key'] as string;

			if (apiKey) {
				this.logger.debug('Push connection attempting API key authentication');

				const result = await this.authenticateWithApiKey(apiKey);

				if (result.success) {
					req.user = result.user!;
					this.logger.debug('Push connection authenticated via API key', {
						userId: result.user!.id,
					});
					next();
					return;
				}

				// API key provided but invalid - reject immediately
				this.logger.warn('Push connection failed: invalid API key');
				res.status(401).json({
					status: 'error',
					message: 'Invalid API key',
				});
				return;
			}

			// 2. Fall back to cookie-based JWT authentication
			this.logger.debug('Push connection attempting cookie authentication');
			const cookieAuth = this.authService.createAuthMiddleware({
				allowSkipMFA: false,
			});

			await cookieAuth(req, res, next);
		};
	}

	/**
	 * Authenticates a user using an API key.
	 * Validates the API key and ensures the user is not disabled.
	 */
	private async authenticateWithApiKey(apiKey: string) {
		try {
			// Get user associated with this API key
			const user = await this.userRepository.findOne({
				where: {
					apiKeys: {
						apiKey,
						audience: 'public-api',
					},
				},
				relations: ['role'],
			});

			if (!user) {
				this.logger.debug('API key not found');
				return { success: false };
			}

			if (user.disabled) {
				this.logger.debug('User account disabled', { userId: user.id });
				return { success: false };
			}

			// Verify JWT signature if not a legacy key
			if (!apiKey.startsWith('n8n_api_')) {
				try {
					this.jwtService.verify(apiKey, {
						issuer: 'n8n',
						audience: 'public-api',
					});
				} catch (error) {
					this.logger.debug('API key JWT verification failed', {
						error: error instanceof Error ? error.message : 'Unknown error',
					});
					return { success: false };
				}
			}

			return { success: true, user };
		} catch (error) {
			this.logger.error('Error during API key authentication', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			return { success: false };
		}
	}
}
