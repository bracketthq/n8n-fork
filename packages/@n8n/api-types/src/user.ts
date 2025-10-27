export type MinimalUser = {
	id: string;
	email: string;
	firstName: string;
	lastName: string;
};

/**
 * Response from the user provisioning endpoint.
 *
 * Contains all credentials needed for the new user to authenticate
 * and start using n8n via the API.
 *
 * SECURITY NOTE: The API key should be transmitted securely to the end user
 * and stored safely. It will not be shown again.
 */
export type ProvisionUserResponse = {
	/** UUID of the created user */
	user_id: string;
	/** Email address of the user */
	email: string;
	/**
	 * JWT API key for authentication.
	 * - Never expires (expiresAt: null)
	 * - Has scopes based on user's role (member = limited scopes)
	 * - This is the ONLY way the user can authenticate
	 */
	api_key: string;
};

/**
 * Response from the getUserCredentials endpoint.
 *
 * Returns the most recent API key for a user.
 *
 * SECURITY WARNING: Contains the FULL unredacted API key.
 * - This should be transmitted over secure channels only
 * - Log all access to this endpoint for audit purposes
 * - The API key has full permissions based on user's role
 */
export type GetUserCredentialsResponse = {
	/** UUID of the user */
	user_id: string;
	/** Email address of the user */
	email: string;
	/**
	 * FULL unredacted JWT API key (most recent non-expired).
	 * This is the complete token that can be used for authentication.
	 */
	api_key: string;
	/** Label of the API key (e.g., "Brackett API Key") */
	label: string;
	/** Unix timestamp when this key expires (null = never) */
	expires_at: number | null;
	/** ISO timestamp when this key was created */
	created_at: string;
};
