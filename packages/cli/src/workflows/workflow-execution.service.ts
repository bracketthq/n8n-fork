import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { Project, User, CreateExecutionPayload } from '@n8n/db';
import { ExecutionRepository, WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type { Response } from 'express';
import { ErrorReporter } from 'n8n-core';
import type {
	IDataObject,
	IDeferredPromise,
	IExecuteData,
	IExecuteResponsePromiseData,
	INode,
	INodeExecutionData,
	IPinData,
	IRunData,
	IRunExecutionData,
	IWorkflowExecuteAdditionalData,
	WorkflowExecuteMode,
	IWorkflowExecutionDataProcess,
	IWorkflowBase,
} from 'n8n-workflow';
import { SubworkflowOperationError, Workflow } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { ExecutionDataService } from '@/executions/execution-data.service';
import { SubworkflowPolicyChecker } from '@/executions/pre-execution-checks';
import type { IWorkflowErrorData } from '@/interfaces';
import { NodeTypes } from '@/node-types';
import { TestWebhooks } from '@/webhooks/test-webhooks';
import * as WorkflowExecuteAdditionalData from '@/workflow-execute-additional-data';
import { WorkflowRunner } from '@/workflow-runner';
import type { WorkflowRequest } from '@/workflows/workflow.request';

@Service()
export class WorkflowExecutionService {
	constructor(
		private readonly logger: Logger,
		private readonly errorReporter: ErrorReporter,
		private readonly executionRepository: ExecutionRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly nodeTypes: NodeTypes,
		private readonly testWebhooks: TestWebhooks,
		private readonly workflowRunner: WorkflowRunner,
		private readonly globalConfig: GlobalConfig,
		private readonly subworkflowPolicyChecker: SubworkflowPolicyChecker,
		private readonly executionDataService: ExecutionDataService,
	) {}

	async runWorkflow(
		workflowData: IWorkflowBase,
		node: INode,
		data: INodeExecutionData[][],
		additionalData: IWorkflowExecuteAdditionalData,
		mode: WorkflowExecuteMode,
		responsePromise?: IDeferredPromise<IExecuteResponsePromiseData>,
	) {
		const nodeExecutionStack: IExecuteData[] = [
			{
				node,
				data: {
					main: data,
				},
				source: null,
			},
		];

		const executionData: IRunExecutionData = {
			startData: {},
			resultData: {
				runData: {},
			},
			executionData: {
				contextData: {},
				metadata: {},
				nodeExecutionStack,
				waitingExecution: {},
				waitingExecutionSource: {},
			},
		};

		// Start the workflow
		const runData: IWorkflowExecutionDataProcess = {
			userId: additionalData.userId,
			executionMode: mode,
			executionData,
			workflowData,
		};

		return await this.workflowRunner.run(runData, true, undefined, undefined, responsePromise);
	}

	private isDestinationNodeATrigger(destinationNode: string, workflow: IWorkflowBase) {
		const node = workflow.nodes.find((n) => n.name === destinationNode);

		if (node === undefined) {
			return false;
		}

		const nodeType = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);

		return nodeType.description.group.includes('trigger');
	}

	async executeManually(
		{
			workflowData,
			runData,
			startNodes,
			destinationNode,
			dirtyNodeNames,
			triggerToStartFrom,
			agentRequest,
		}: WorkflowRequest.ManualRunPayload,
		user: User,
		pushRef?: string,
		streamingEnabled?: boolean,
		httpResponse?: Response,
	) {
		const pinData = workflowData.pinData;
		let pinnedTrigger = this.selectPinnedActivatorStarter(
			workflowData,
			startNodes?.map((nodeData) => nodeData.name),
			pinData,
			destinationNode,
		);

		// TODO: Reverse the order of events, first find out if the execution is
		// partial or full, if it's partial create the execution and run, if it's
		// full get the data first and only then create the execution.
		//
		// If the destination node is a trigger, then per definition this
		// is not a partial execution and thus we can ignore the run data.
		// If we don't do this we'll end up creating an execution, calling the
		// partial execution flow, finding out that we don't have run data to
		// create the execution stack and have to cancel the execution, come back
		// here and either create the runData (e.g. scheduler trigger) or wait for
		// a webhook or event.
		if (destinationNode) {
			if (this.isDestinationNodeATrigger(destinationNode, workflowData)) {
				runData = undefined;
			}
		}

		// if we have a trigger to start from and it's not the pinned trigger
		// ignore the pinned trigger
		if (pinnedTrigger && triggerToStartFrom && pinnedTrigger.name !== triggerToStartFrom.name) {
			pinnedTrigger = null;
		}

		// If webhooks nodes exist and are active we have to wait for till we receive a call
		if (
			pinnedTrigger === null &&
			(runData === undefined ||
				startNodes === undefined ||
				startNodes.length === 0 ||
				destinationNode === undefined)
		) {
			const additionalData = await WorkflowExecuteAdditionalData.getBase({
				userId: user.id,
				workflowId: workflowData.id,
			});

			const needsWebhook = await this.testWebhooks.needsWebhook({
				userId: user.id,
				workflowEntity: workflowData,
				additionalData,
				runData,
				pushRef,
				destinationNode,
				triggerToStartFrom,
			});

			if (needsWebhook) return { waitingForWebhook: true };
		}

		// For manual testing always set to not active
		workflowData.active = false;

		// Start the workflow
		const data: IWorkflowExecutionDataProcess = {
			destinationNode,
			executionMode: 'manual',
			runData,
			pinData,
			pushRef,
			startNodes,
			workflowData,
			userId: user.id,
			dirtyNodeNames,
			triggerToStartFrom,
			agentRequest,
			streamingEnabled,
			httpResponse,
		};

		const hasRunData = (node: INode) => runData !== undefined && !!runData[node.name];

		if (pinnedTrigger && !hasRunData(pinnedTrigger)) {
			data.startNodes = [{ name: pinnedTrigger.name, sourceData: null }];
		}

		/**
		 * Historically, manual executions in scaling mode ran in the main process,
		 * so some execution details were never persisted in the database.
		 *
		 * Currently, manual executions in scaling mode are offloaded to workers,
		 * so we persist all details to give workers full access to them.
		 */
		if (
			this.globalConfig.executions.mode === 'queue' &&
			process.env.OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS === 'true'
		) {
			data.executionData = {
				startData: {
					startNodes: data.startNodes,
					destinationNode,
				},
				resultData: {
					pinData,
					// @ts-expect-error CAT-752
					runData,
				},
				manualData: {
					userId: data.userId,
					dirtyNodeNames,
					triggerToStartFrom,
				},
			};
		}

		const executionId = await this.workflowRunner.run(data);

		return {
			executionId,
		};
	}

	/** Executes an error workflow */
	async executeErrorWorkflow(
		workflowId: string,
		workflowErrorData: IWorkflowErrorData,
		runningProject: Project,
	): Promise<void> {
		// Wrap everything in try/catch to make sure that no errors bubble up and all get caught here
		try {
			const workflowData = await this.workflowRepository.findOneBy({ id: workflowId });
			if (workflowData === null) {
				// The error workflow could not be found
				this.logger.error(
					`Calling Error Workflow for "${workflowErrorData.workflow.id}". Could not find error workflow "${workflowId}"`,
					{ workflowId },
				);
				return;
			}

			const executionMode = 'error';
			const workflowInstance = new Workflow({
				id: workflowId,
				name: workflowData.name,
				nodeTypes: this.nodeTypes,
				nodes: workflowData.nodes,
				connections: workflowData.connections,
				active: workflowData.active,
				staticData: workflowData.staticData,
				settings: workflowData.settings,
			});

			try {
				const failedNode = workflowErrorData.execution?.lastNodeExecuted
					? workflowInstance.getNode(workflowErrorData.execution?.lastNodeExecuted)
					: undefined;
				await this.subworkflowPolicyChecker.check(
					workflowInstance,
					workflowErrorData.workflow.id!,
					failedNode ?? undefined,
				);
			} catch (error) {
				const initialNode = workflowInstance.getStartNode();
				if (initialNode) {
					const errorWorkflowPermissionError = new SubworkflowOperationError(
						`Another workflow: (ID ${workflowErrorData.workflow.id}) tried to invoke this workflow to handle errors.`,
						"Unfortunately current permissions do not allow this. Please check that this workflow's settings allow it to be called by others",
					);

					// Create a fake execution and save it to DB.
					const fakeExecution = this.executionDataService.generateFailedExecutionFromError(
						'error',
						errorWorkflowPermissionError,
						initialNode,
					);

					const fullExecutionData: CreateExecutionPayload = {
						data: fakeExecution.data,
						mode: fakeExecution.mode,
						finished: false,
						stoppedAt: new Date(),
						workflowData,
						waitTill: null,
						status: fakeExecution.status,
						workflowId: workflowData.id,
					};

					await this.executionRepository.createNewExecution(fullExecutionData);
				}
				this.logger.info('Error workflow execution blocked due to subworkflow settings', {
					erroredWorkflowId: workflowErrorData.workflow.id,
					errorWorkflowId: workflowId,
				});
				return;
			}

			let node: INode;
			let workflowStartNode: INode | undefined;
			const { errorTriggerType } = this.globalConfig.nodes;
			for (const nodeName of Object.keys(workflowInstance.nodes)) {
				node = workflowInstance.nodes[nodeName];
				if (node.type === errorTriggerType) {
					workflowStartNode = node;
				}
			}

			if (workflowStartNode === undefined) {
				this.logger.error(
					`Calling Error Workflow for "${workflowErrorData.workflow.id}". Could not find "${errorTriggerType}" in workflow "${workflowId}"`,
				);
				return;
			}

			const parentExecution =
				workflowErrorData.execution?.id && workflowErrorData.workflow?.id
					? {
							executionId: workflowErrorData.execution.id,
							workflowId: workflowErrorData.workflow.id,
						}
					: undefined;

			// Can execute without webhook so go on
			// Initialize the data of the webhook node
			const nodeExecutionStack: IExecuteData[] = [];
			nodeExecutionStack.push({
				node: workflowStartNode,
				data: {
					main: [
						[
							{
								json: workflowErrorData,
							},
						],
					],
				},
				source: null,
				...(parentExecution && {
					metadata: {
						parentExecution,
					},
				}),
			});

			const runExecutionData: IRunExecutionData = {
				startData: {},
				resultData: {
					runData: {},
				},
				executionData: {
					contextData: {},
					metadata: {},
					nodeExecutionStack,
					waitingExecution: {},
					waitingExecutionSource: {},
				},
			};

			const runData: IWorkflowExecutionDataProcess = {
				executionMode,
				executionData: runExecutionData,
				workflowData,
				projectId: runningProject.id,
			};

			await this.workflowRunner.run(runData);
		} catch (error) {
			this.errorReporter.error(error);
			this.logger.error(
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				`Calling Error Workflow for "${workflowErrorData.workflow.id}": "${error.message}"`,
				{ workflowId: workflowErrorData.workflow.id },
			);
		}
	}

	/**
	 * Select the pinned activator node to use as starter for a manual execution.
	 *
	 * In a full manual execution, select the pinned activator that was first added
	 * to the workflow, prioritizing `n8n-nodes-base.webhook` over other activators.
	 *
	 * In a partial manual execution, if the executed node has parent nodes among the
	 * pinned activators, select the pinned activator that was first added to the workflow,
	 * prioritizing `n8n-nodes-base.webhook` over other activators. If the executed node
	 * has no upstream nodes and is itself is a pinned activator, select it.
	 */
	selectPinnedActivatorStarter(
		workflow: IWorkflowBase,
		startNodes?: string[],
		pinData?: IPinData,
		destinationNode?: string,
	) {
		if (!pinData || !startNodes) return null;

		const allPinnedActivators = this.findAllPinnedActivators(workflow, pinData);

		if (allPinnedActivators.length === 0) return null;

		const [firstPinnedActivator] = allPinnedActivators;

		// full manual execution

		if (startNodes?.length === 0) {
			// If there is a destination node, find the pinned activator that is a parent of the destination node
			if (destinationNode) {
				const destinationParents = new Set(
					new Workflow({
						nodes: workflow.nodes,
						connections: workflow.connections,
						active: workflow.active,
						nodeTypes: this.nodeTypes,
					}).getParentNodes(destinationNode),
				);

				const activator = allPinnedActivators.find((a) => destinationParents.has(a.name));

				if (activator) {
					return activator;
				}
			}

			return firstPinnedActivator ?? null;
		}

		// partial manual execution

		/**
		 * If the partial manual execution has 2+ start nodes, we search only the zeroth
		 * start node's parents for a pinned activator. If we had 2+ start nodes without
		 * a common ancestor and so if we end up finding multiple pinned activators, we
		 * would still need to return one to comply with existing usage.
		 */
		const [firstStartNodeName] = startNodes;

		const parentNodeNames = new Workflow({
			nodes: workflow.nodes,
			connections: workflow.connections,
			active: workflow.active,
			nodeTypes: this.nodeTypes,
		}).getParentNodes(firstStartNodeName);

		if (parentNodeNames.length > 0) {
			const parentNodeName = parentNodeNames.find((p) => p === firstPinnedActivator.name);

			return allPinnedActivators.find((pa) => pa.name === parentNodeName) ?? null;
		}

		return allPinnedActivators.find((pa) => pa.name === firstStartNodeName) ?? null;
	}

	private findAllPinnedActivators(workflow: IWorkflowBase, pinData?: IPinData) {
		return workflow.nodes
			.filter(
				(node) =>
					!node.disabled &&
					pinData?.[node.name] &&
					['trigger', 'webhook'].some((suffix) => node.type.toLowerCase().endsWith(suffix)) &&
					node.type !== 'n8n-nodes-base.respondToWebhook',
			)
			.sort((a) => (a.type.endsWith('webhook') ? -1 : 1));
	}

	/**
	 * Execute a workflow with simplified public API
	 * Automatically detects execution type and handles all node types
	 *
	 * @param workflowId - ID of the workflow to execute
	 * @param inputData - Optional data to inject into the workflow
	 * @param options - Execution options (destinationNode, executionId, etc.)
	 * @param user - User executing the workflow
	 * @returns Execution ID and optionally status if waiting for external input
	 */
	async executeWorkflow(
		workflowId: string,
		inputData: Record<string, unknown> | undefined,
		options: {
			destinationNode?: string;
			executionId?: string;
			dirtyNodes?: string[];
			triggerData?: {
				triggerName: string;
				payload: Record<string, unknown>;
			};
		} = {},
		user: User,
	): Promise<{
		executionId: string;
		status?: 'waiting';
	}> {
		this.logger.debug('Executing workflow via public API', {
			workflowId,
			userId: user.id,
			hasData: !!inputData,
			options,
		});

		// Step 1: Load workflow from database
		const workflow = await this.workflowRepository.findOneBy({ id: workflowId });

		if (!workflow) {
			throw new NotFoundError(`Workflow with ID "${workflowId}" not found`);
		}

		// Step 2: Create Workflow instance to analyze structure
		const workflowInstance = new Workflow({
			id: workflow.id,
			name: workflow.name,
			nodes: workflow.nodes,
			connections: workflow.connections,
			active: workflow.active,
			nodeTypes: this.nodeTypes,
			staticData: workflow.staticData,
			settings: workflow.settings,
		});

		// Step 3: Load previous execution data if resuming
		let previousRunData: IRunData | undefined;
		let previousPinData: IPinData | undefined;

		if (options.executionId) {
			this.logger.debug('Loading previous execution for partial run', {
				executionId: options.executionId,
			});

			const previousExecution = await this.executionRepository.findSingleExecution(
				options.executionId,
				{ includeData: true, unflattenData: true },
			);

			if (!previousExecution) {
				throw new NotFoundError(`Execution with ID "${options.executionId}" not found`);
			}

			previousRunData = previousExecution.data?.resultData?.runData;
			previousPinData = workflow.pinData;

			this.logger.debug('Previous execution loaded', {
				executionId: options.executionId,
				nodesWithData: Object.keys(previousRunData || {}).length,
			});
		}

		// Step 4: Determine execution type and build payload
		const payload = this.buildExecutionPayload(
			workflow,
			workflowInstance,
			inputData,
			options,
			previousRunData,
			previousPinData,
		);

		this.logger.debug('Execution payload built', {
			hasTriggerToStartFrom: !!payload.triggerToStartFrom,
			hasRunData: !!payload.runData,
			destinationNode: payload.destinationNode,
			startNodesCount: payload.startNodes?.length || 0,
		});

		// Step 5: Execute workflow
		const result = await this.executeManually(
			payload,
			user,
			undefined, // pushRef
			undefined, // streamingEnabled
			undefined, // httpResponse
		);

		this.logger.debug('Workflow execution started', {
			executionId: result.executionId,
			waitingForWebhook: result.waitingForWebhook,
		});

		// Step 6: Return response
		if (result.waitingForWebhook) {
			return {
				executionId: result.executionId!,
				status: 'waiting',
			};
		}

		return {
			executionId: result.executionId!,
		};
	}

	/**
	 * Build execution payload based on input parameters
	 * This method determines the correct execution path:
	 * - PATH 1: Custom trigger with data (triggerToStartFrom)
	 * - PATH 2: Partial execution (has runData and destinationNode)
	 * - PATH 3: Full execution with input data
	 * - PATH 4: Full execution without input data
	 *
	 * @private
	 */
	private buildExecutionPayload(
		workflow: IWorkflowBase,
		workflowInstance: Workflow,
		inputData: Record<string, unknown> | undefined,
		options: {
			destinationNode?: string;
			dirtyNodes?: string[];
			triggerData?: { triggerName: string; payload: Record<string, unknown> };
		},
		previousRunData?: IRunData,
		previousPinData?: IPinData,
	): WorkflowRequest.ManualRunPayload {
		const payload: WorkflowRequest.ManualRunPayload = {
			workflowData: workflow,
		};

		// CASE 1: Custom trigger data provided
		// User wants to start from a specific trigger with specific data
		if (options.triggerData) {
			this.logger.debug('Building payload: Custom trigger data', {
				triggerName: options.triggerData.triggerName,
			});

			const triggerNode = workflowInstance.getNode(options.triggerData.triggerName);

			if (!triggerNode) {
				throw new BadRequestError(
					`Trigger node "${options.triggerData.triggerName}" not found in workflow`,
				);
			}

			// Set trigger to start from
			payload.triggerToStartFrom = {
				name: triggerNode.name,
			};

			// Set pin data for the trigger node with the custom payload
			payload.workflowData.pinData = {
				...(workflow.pinData || {}),
				[triggerNode.name]: [{ json: options.triggerData.payload as IDataObject }],
			};

			// Set empty startNodes array to signal "full execution with pinned data"
			// executeManually will find the pinned trigger and populate this
			payload.startNodes = [];

			if (options.destinationNode) {
				payload.destinationNode = options.destinationNode;
			}

			return payload;
		}

		// CASE 2: Partial execution (resuming from previous run)
		// User is re-running part of a workflow with cached data
		if (previousRunData && options.destinationNode) {
			this.logger.debug('Building payload: Partial execution', {
				destinationNode: options.destinationNode,
				dirtyNodesCount: options.dirtyNodes?.length || 0,
				cachedNodesCount: Object.keys(previousRunData).length,
			});

			payload.runData = previousRunData;
			payload.destinationNode = options.destinationNode;
			payload.dirtyNodeNames = options.dirtyNodes || [];
			if (previousPinData) {
				payload.workflowData.pinData = previousPinData;
			}

			return payload;
		}

		// CASE 3: Full execution with input data
		// User wants to run the entire workflow with specific input
		if (inputData) {
			this.logger.debug('Building payload: Full execution with input data');

			// Find all activator nodes (triggers, webhooks, etc.)
			// Using the same logic as findAllPinnedActivators but without pinData requirement
			const activatorNodes = workflow.nodes.filter(
				(node) =>
					!node.disabled &&
					['trigger', 'webhook'].some((suffix) => node.type.toLowerCase().endsWith(suffix)) &&
					node.type !== 'n8n-nodes-base.respondToWebhook',
			);

			if (activatorNodes.length === 0) {
				throw new BadRequestError('Workflow has no trigger or webhook nodes');
			}

			// Prioritize Manual Trigger, then Webhook, then first activator
			let startNode = activatorNodes.find((node) => node.type === 'n8n-nodes-base.manualTrigger');

			if (!startNode) {
				startNode = activatorNodes.find((node) => node.type.toLowerCase().includes('webhook'));
			}

			if (!startNode) {
				startNode = activatorNodes[0];
			}

			this.logger.debug('Selected start node', {
				nodeName: startNode.name,
				nodeType: startNode.type,
			});

			// Set trigger to start from
			payload.triggerToStartFrom = {
				name: startNode.name,
			};

			// Set pin data for the trigger node with the input data
			payload.workflowData.pinData = {
				...(workflow.pinData || {}),
				[startNode.name]: [{ json: inputData as IDataObject }],
			};

			// Set empty startNodes array to signal "full execution with pinned data"
			// executeManually will find the pinned trigger and populate this
			payload.startNodes = [];

			if (options.destinationNode) {
				payload.destinationNode = options.destinationNode;
			}

			return payload;
		}

		// CASE 4: Full execution without input data
		// User wants to run the workflow as-is (e.g., scheduled trigger with no input)
		this.logger.debug('Building payload: Full execution without input data', {
			destinationNode: options.destinationNode,
		});

		if (options.destinationNode) {
			payload.destinationNode = options.destinationNode;
		}

		if (previousPinData) {
			payload.workflowData.pinData = previousPinData;
		}

		return payload;
	}
}
