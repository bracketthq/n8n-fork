import { z } from 'zod';
import { Z } from 'zod-class';

/**
 * Trigger data schema for custom trigger execution
 * Allows specifying which trigger to start from and what data to provide
 */
const triggerDataSchema = z.object({
	/** Name of the trigger node to start execution from */
	triggerName: z.string().min(1, 'Trigger name cannot be empty'),

	/** Payload data to inject into the trigger node */
	payload: z.record(z.unknown()),
});

/**
 * Execution options schema
 * Advanced configuration for different execution scenarios
 */
const executeOptionsSchema = z.object({
	/**
	 * Stop execution at this node
	 * Useful for testing specific parts of a workflow
	 */
	destinationNode: z.string().optional(),

	/**
	 * ID of a previous execution to resume from
	 * Used for partial execution with cached data
	 */
	executionId: z.string().optional(),

	/**
	 * Nodes that have been modified since the cached execution
	 * These nodes and their descendants will be re-executed
	 */
	dirtyNodes: z.array(z.string()).optional(),

	/**
	 * Custom trigger data for execution
	 * Allows starting from a specific trigger with test data
	 */
	triggerData: triggerDataSchema.optional(),

	/**
	 * Whether to wait for execution to complete before returning
	 * If true, returns execution results in the response
	 * If false (default), returns execution ID immediately
	 */
	waitForCompletion: z.boolean().optional().default(false),

	/**
	 * Timeout in seconds when waitForCompletion is true
	 * Maximum: 3600 seconds (1 hour)
	 * Default: 300 seconds (5 minutes)
	 */
	timeout: z
		.number()
		.int('Timeout must be an integer')
		.positive('Timeout must be positive')
		.max(3600, 'Timeout cannot exceed 3600 seconds (1 hour)')
		.optional(),

	/**
	 * Push reference for receiving real-time execution events
	 * When provided, execution events will be sent to the WebSocket/SSE connection
	 * with this pushRef identifier. Clients should connect to /rest/push?pushRef={value}
	 * before triggering the execution.
	 */
	pushRef: z.string().optional(),
});

/**
 * Request DTO for workflow execution
 *
 * @example Simple execution
 * ```typescript
 * {
 *   data: { userId: 123, action: "signup" }
 * }
 * ```
 *
 * @example Partial execution
 * ```typescript
 * {
 *   options: {
 *     executionId: "prev-exec-id",
 *     destinationNode: "ProcessData",
 *     dirtyNodes: ["ProcessData"]
 *   }
 * }
 * ```
 *
 * @example Custom trigger
 * ```typescript
 * {
 *   options: {
 *     triggerData: {
 *       triggerName: "Webhook",
 *       payload: { headers: {...}, body: {...} }
 *     }
 *   }
 * }
 * ```
 */
export class WorkflowExecuteDto extends Z.class({
	/**
	 * Input data to inject into the workflow's starting trigger
	 * This will be passed to the first trigger node (Manual Trigger, Webhook, etc.)
	 */
	data: z.record(z.unknown()).optional(),

	/**
	 * Advanced execution options
	 * Provides control over execution behavior
	 */
	options: executeOptionsSchema.optional(),
}) {}

/**
 * Error details in execution response
 */
const executionErrorSchema = z.object({
	/** Error message */
	message: z.string(),

	/** Name of the node where error occurred */
	node: z.string().optional(),

	/** Error stack trace (only in development) */
	stack: z.string().optional(),
});

/**
 * Response DTO for workflow execution
 *
 * @example Immediate response (waitForCompletion: false)
 * ```typescript
 * {
 *   executionId: "abc-123-def"
 * }
 * ```
 *
 * @example Success response (waitForCompletion: true)
 * ```typescript
 * {
 *   executionId: "abc-123-def",
 *   status: "success",
 *   data: {
 *     "Manual Trigger": [{ json: {...} }],
 *     "HTTP Request": [{ json: {...} }]
 *   }
 * }
 * ```
 *
 * @example Error response (waitForCompletion: true)
 * ```typescript
 * {
 *   executionId: "abc-123-def",
 *   status: "error",
 *   error: {
 *     message: "Connection refused",
 *     node: "HTTP Request"
 *   }
 * }
 * ```
 *
 * @example Waiting for webhook
 * ```typescript
 * {
 *   executionId: "abc-123-def",
 *   status: "waiting"
 * }
 * ```
 */
export class WorkflowExecuteResponseDto extends Z.class({
	/** Unique identifier for the execution */
	executionId: z.string(),

	/**
	 * Execution status (only present when waitForCompletion: true)
	 * - success: Workflow completed successfully
	 * - error: Workflow failed with an error
	 * - waiting: Workflow is waiting for external trigger (webhook, form, etc.)
	 */
	status: z.enum(['success', 'error', 'waiting']).optional(),

	/**
	 * Execution results (only present when waitForCompletion: true and status: success)
	 * Contains output data from each executed node
	 * Key: Node name
	 * Value: Array of execution data (usually one item, but can be multiple for loops)
	 */
	data: z.record(z.array(z.object({ json: z.record(z.unknown()) }))).optional(),

	/**
	 * Error details (only present when status: error)
	 */
	error: executionErrorSchema.optional(),
}) {}
