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
