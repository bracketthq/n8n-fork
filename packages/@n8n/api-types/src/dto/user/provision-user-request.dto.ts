import xss from 'xss';
import { z } from 'zod';
import { Z } from 'zod-class';

/**
 * XSS validation: Ensures no HTML tags are present in the string
 */
const xssCheck = (value: string) =>
	value ===
	xss(value, {
		whiteList: {}, // no tags are allowed
	});

/**
 * URL validation: Prevents URLs from being used in name fields
 */
const URL_REGEX = /^(https?:\/\/|www\.)|(\.[\p{L}\d-]+)/iu;
const urlCheck = (value: string) => !URL_REGEX.test(value);

/**
 * Schema for validating first/last name fields
 * - Min 1 character
 * - Max 32 characters
 * - No XSS/HTML tags
 * - No URLs
 */
const nameSchema = () =>
	z
		.string()
		.min(1)
		.max(32)
		.refine(xssCheck, {
			message: 'Potentially malicious string',
		})
		.refine(urlCheck, {
			message: 'Potentially malicious string',
		});

/**
 * DTO for provisioning a user programmatically.
 *
 * This endpoint creates users without sending email invitations.
 * The created user will have:
 * - A random password (unknown to anyone)
 * - API-key only access
 * - Global member role
 *
 * @property email - Valid email address (required)
 * @property firstName - User's first name (optional, 1-32 chars, no HTML/URLs)
 * @property lastName - User's last name (optional, 1-32 chars, no HTML/URLs)
 */
export class ProvisionUserRequestDto extends Z.class({
	email: z.string().email(),
	firstName: nameSchema().optional(),
	lastName: nameSchema().optional(),
}) {}
