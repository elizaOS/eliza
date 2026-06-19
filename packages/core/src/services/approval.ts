/**
 * ApprovalService
 *
 * A robust abstraction for task-based approvals in Eliza.
 * Provides a interface for requesting approvals, handling choices,
 * and managing approval workflows.
 *
 * Patterns supported:
 * - Simple confirm/deny (e.g., "Post this tweet?")
 * - Multi-option choices (e.g., "Select deployment target")
 * - Timed approvals with expiration
 * - Approval chains (e.g., "Approve step 1, then step 2")
 */

import { logger } from "../logger.ts";
import type {
	IAgentRuntime,
	Memory,
	State,
	Task,
	TaskWorker,
	UUID,
} from "../types/index.ts";
import { Service, ServiceType } from "../types/service.ts";

/**
 * Options for a single approval choice
 */
export interface ApprovalOption {
	/** Unique identifier for the option */
	name: string;
	/** Human-readable description */
	description?: string;
	/** If true, this option is the default when approval times out */
	isDefault?: boolean;
	/** If true, this option cancels/aborts the task */
	isCancel?: boolean;
}

/**
 * Parameters for creating an approval request
 */
export interface ApprovalRequest {
	/** Unique name for this approval type (used for task worker registration) */
	name: string;
	/** Human-readable description of what's being approved */
	description: string;
	/** Room where the approval request is made */
	roomId: UUID;
	/** Optional entity ID associated with the request */
	entityId?: UUID;
	/** Available options for the approval */
	options: ApprovalOption[];
	/** Additional tags for the task */
	tags?: string[];
	/** Timeout in milliseconds (default: no timeout) */
	timeoutMs?: number;
	/** Default option if timeout occurs (must match an option name) */
	timeoutDefault?: string;
	/** Arbitrary metadata to attach to the task */
	metadata?: Record<string, unknown>;
	/** Callback when an option is selected */
	onSelect?: (
		option: string,
		task: Task,
		runtime: IAgentRuntime,
	) => Promise<void>;
	/** Callback when approval times out */
	onTimeout?: (task: Task, runtime: IAgentRuntime) => Promise<void>;
	/** Roles allowed to make this approval (default: OWNER, ADMIN) */
	allowedRoles?: string[];
}

/**
 * Result of an approval request
 */
export interface ApprovalResult {
	/** The option that was selected */
	selectedOption: string;
	/** Whether the approval was successful (not cancelled/timed out) */
	success: boolean;
	/** Whether the approval timed out */
	timedOut: boolean;
	/** Whether the approval was cancelled */
	cancelled: boolean;
	/** The task ID */
	taskId: UUID;
	/** Entity that made the selection (if known) */
	resolvedBy?: UUID;
	/** Timestamp when resolved */
	resolvedAt: number;
}

/**
 * Pending approval tracker
 */
interface PendingApproval {
	taskId: UUID;
	request: ApprovalRequest;
	createdAt: number;
	expiresAt?: number;
	timeoutHandle?: NodeJS.Timeout;
	resolve: (result: ApprovalResult) => void;
	reject: (error: Error) => void;
}

/**
 * Standard approval options for common patterns
 */
export const STANDARD_OPTIONS = {
	CONFIRM: [
		{ name: "confirm", description: "Confirm and proceed", isDefault: false },
		{ name: "cancel", description: "Cancel the operation", isCancel: true },
	] as ApprovalOption[],

	APPROVE_DENY: [
		{ name: "approve", description: "Approve the request" },
		{ name: "deny", description: "Deny the request", isCancel: true },
	] as ApprovalOption[],

	YES_NO: [
		{ name: "yes", description: "Yes" },
		{ name: "no", description: "No", isCancel: true },
	] as ApprovalOption[],

	ALLOW_ONCE_ALWAYS_DENY: [
		{ name: "allow-once", description: "Allow this one time" },
		{ name: "allow-always", description: "Always allow this" },
		{ name: "deny", description: "Deny the request", isCancel: true },
	] as ApprovalOption[],
} as const;

/**
 * ApprovalService provides a interface for task-based approvals.
 */
export class ApprovalService extends Service {
	static serviceType: string = ServiceType.APPROVAL;
	capabilityDescription = "Manages approval workflows using the task system";

	private pendingApprovals = new Map<UUID, PendingApproval>();
	private registeredWorkers = new Set<string>();

	/**
	 * Start the ApprovalService
	 */
	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new ApprovalService(runtime);
		return service;
	}

	/**
	 * Stop the ApprovalService
	 */
	async stop(): Promise<void> {
		// Resolve all pending approvals with cancelled before clearing
		for (const pending of this.pendingApprovals.values()) {
			if (pending.timeoutHandle) {
				clearTimeout(pending.timeoutHandle);
			}
			pending.resolve({
				selectedOption: "cancel",
				success: false,
				timedOut: false,
				cancelled: true,
				taskId: pending.taskId,
				resolvedAt: Date.now(),
			});
		}
		this.pendingApprovals.clear();
	}

	/**
	 * Create an approval request and wait for a decision.
	 *
	 * @param request - The approval request parameters
	 * @returns Promise that resolves with the approval result
	 *
	 * @example
	 * ```typescript
	 * const result = await approvalService.requestApproval({
	 *   name: 'EXEC_APPROVAL',
	 *   description: 'Execute command: rm -rf /tmp/cache',
	 *   roomId: message.roomId,
	 *   options: STANDARD_OPTIONS.ALLOW_ONCE_ALWAYS_DENY,
	 *   timeoutMs: 120000,
	 *   timeoutDefault: 'deny',
	 *   onSelect: async (option, task, runtime) => {
	 *     if (option === 'allow-always') {
	 *       await addToAllowlist(command);
	 *     }
	 *   },
	 * });
	 *
	 * if (result.success && result.selectedOption !== 'deny') {
	 *   await executeCommand();
	 * }
	 * ```
	 */
	async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
		// Ensure task worker is registered for this approval type
		await this.ensureWorkerRegistered(request);

		// Create the approval task
		const taskId = await this.runtime.createTask({
			name: request.name,
			description: request.description,
			roomId: request.roomId,
			entityId: request.entityId,
			tags: ["AWAITING_CHOICE", "APPROVAL", ...(request.tags ?? [])],
			metadata: {
				options: request.options.map((opt) => ({
					name: opt.name,
					description: opt.description ?? "",
				})),
				approvalRequest: {
					timeoutMs: request.timeoutMs,
					timeoutDefault: request.timeoutDefault,
					allowedRoles: request.allowedRoles ?? ["OWNER", "ADMIN"],
					createdAt: Date.now(),
				},
				...(request.metadata ?? {}),
			},
		});

		logger.info(
			{
				src: "service:approval",
				taskId,
				name: request.name,
				roomId: request.roomId,
				options: request.options.map((o) => o.name),
				timeoutMs: request.timeoutMs,
			},
			"Approval request created",
		);

		// Create pending approval tracker
		return new Promise<ApprovalResult>((resolve, reject) => {
			const now = Date.now();
			const pending: PendingApproval = {
				taskId,
				request,
				createdAt: now,
				resolve,
				reject,
			};

			// Set up timeout if specified
			if (request.timeoutMs && request.timeoutMs > 0) {
				pending.expiresAt = now + request.timeoutMs;
				pending.timeoutHandle = setTimeout(
					() => this.handleTimeout(taskId),
					request.timeoutMs,
				);
			}

			this.pendingApprovals.set(taskId, pending);
		});
	}

	/**
	 * Request approval without waiting (fire and forget with callbacks).
	 * Useful when you don't need to block on the approval result.
	 */
	async requestApprovalAsync(request: ApprovalRequest): Promise<UUID> {
		// Ensure task worker is registered for this approval type
		await this.ensureWorkerRegistered(request);

		// Create the approval task
		const taskId = await this.runtime.createTask({
			name: request.name,
			description: request.description,
			roomId: request.roomId,
			entityId: request.entityId,
			tags: ["AWAITING_CHOICE", "APPROVAL", ...(request.tags ?? [])],
			metadata: {
				options: request.options.map((opt) => ({
					name: opt.name,
					description: opt.description ?? "",
				})),
				approvalRequest: {
					timeoutMs: request.timeoutMs,
					timeoutDefault: request.timeoutDefault,
					allowedRoles: request.allowedRoles ?? ["OWNER", "ADMIN"],
					createdAt: Date.now(),
					isAsync: true,
				},
				onSelectCallback: !!request.onSelect,
				onTimeoutCallback: !!request.onTimeout,
				...(request.metadata ?? {}),
			},
		});

		logger.info(
			{
				src: "service:approval",
				taskId,
				name: request.name,
				roomId: request.roomId,
				async: true,
			},
			"Async approval request created",
		);

		// Store callbacks for async handling
		if (request.onSelect || request.onTimeout) {
			const pending: PendingApproval = {
				taskId,
				request,
				createdAt: Date.now(),
				resolve: () => {},
				reject: () => {},
			};

			if (request.timeoutMs && request.timeoutMs > 0) {
				pending.expiresAt = Date.now() + request.timeoutMs;
				pending.timeoutHandle = setTimeout(
					() => this.handleTimeout(taskId),
					request.timeoutMs,
				);
			}

			this.pendingApprovals.set(taskId, pending);
		}

		return taskId;
	}

	/**
	 * Cancel a pending approval
	 */
	async cancelApproval(taskId: UUID): Promise<void> {
		const pending = this.pendingApprovals.get(taskId);
		if (pending) {
			if (pending.timeoutHandle) {
				clearTimeout(pending.timeoutHandle);
			}

			pending.resolve({
				selectedOption: "cancel",
				success: false,
				timedOut: false,
				cancelled: true,
				taskId,
				resolvedAt: Date.now(),
			});

			this.pendingApprovals.delete(taskId);
		}

		// Delete the task
		await this.runtime.deleteTask(taskId);

		logger.info({ src: "service:approval", taskId }, "Approval cancelled");
	}

	/**
	 * Get all pending approvals for a room
	 */
	async getPendingApprovals(roomId: UUID): Promise<Task[]> {
		const tasks = await this.runtime.getTasks({
			roomId,
			tags: ["AWAITING_CHOICE", "APPROVAL"],
			agentIds: [this.runtime.agentId],
		});
		return tasks;
	}

	/**
	 * Handle timeout for a pending approval
	 */
	private async handleTimeout(taskId: UUID): Promise<void> {
		const pending = this.pendingApprovals.get(taskId);
		if (!pending) return;

		const { request } = pending;

		logger.info(
			{ src: "service:approval", taskId, name: request.name },
			"Approval timed out",
		);

		// Call timeout callback if provided
		const task = await this.runtime.getTask(taskId);
		if (task && request.onTimeout) {
			try {
				await request.onTimeout(task, this.runtime);
			} catch (error) {
				logger.error(
					{ src: "service:approval", taskId, error },
					"Error in timeout callback",
				);
			}
		}

		// Resolve with timeout default or cancel
		const defaultOption = request.timeoutDefault ?? "cancel";
		const isCancel =
			request.options.find((o) => o.name === defaultOption)?.isCancel ?? true;

		pending.resolve({
			selectedOption: defaultOption,
			success: !isCancel,
			timedOut: true,
			cancelled: isCancel,
			taskId,
			resolvedAt: Date.now(),
		});

		this.pendingApprovals.delete(taskId);

		// Delete the task
		await this.runtime.deleteTask(taskId);
	}

	/**
	 * Handle selection from CHOOSE_OPTION action
	 * Called by the task worker when an option is selected
	 */
	async handleSelection(
		taskId: UUID,
		selectedOption: string,
		resolvedBy?: UUID,
	): Promise<void> {
		const pending = this.pendingApprovals.get(taskId);

		// Clear timeout
		if (pending?.timeoutHandle) {
			clearTimeout(pending.timeoutHandle);
		}

		const task = await this.runtime.getTask(taskId);
		if (!task) {
			logger.warn(
				{ src: "service:approval", taskId },
				"Task not found for approval selection",
			);
			return;
		}

		const request = pending?.request;
		const option = request?.options.find((o) => o.name === selectedOption);
		const isCancel =
			option?.isCancel ??
			(selectedOption === "cancel" || selectedOption === "ABORT");

		logger.info(
			{
				src: "service:approval",
				taskId,
				selectedOption,
				resolvedBy,
				isCancel,
			},
			"Approval selection handled",
		);

		// Call onSelect callback if provided
		if (request?.onSelect) {
			try {
				await request.onSelect(selectedOption, task, this.runtime);
			} catch (error) {
				logger.error(
					{ src: "service:approval", taskId, error },
					"Error in onSelect callback",
				);
			}
		}

		// Resolve the pending promise
		if (pending) {
			pending.resolve({
				selectedOption,
				success: !isCancel,
				timedOut: false,
				cancelled: isCancel,
				taskId,
				resolvedBy,
				resolvedAt: Date.now(),
			});

			this.pendingApprovals.delete(taskId);
		}
	}

	/**
	 * Ensure task worker is registered for this approval type
	 */
	private async ensureWorkerRegistered(
		request: ApprovalRequest,
	): Promise<void> {
		if (this.registeredWorkers.has(request.name)) {
			return;
		}

		const worker: TaskWorker = {
			name: request.name,

			canExecute: async (
				runtime: IAgentRuntime,
				message: Memory,
				_state: State,
			): Promise<boolean> => {
				// Get the task to check allowed roles
				const tasks = await runtime.getTasks({
					roomId: message.roomId,
					tags: ["AWAITING_CHOICE", "APPROVAL"],
					agentIds: [runtime.agentId],
				});

				const matchingTask = tasks.find((t) => t.name === request.name);
				if (!matchingTask) return false;

				const allowedRoles = (
					matchingTask.metadata?.approvalRequest as Record<string, unknown>
				)?.allowedRoles as string[] | undefined;

				if (!allowedRoles || allowedRoles.length === 0) {
					return true; // No role restriction
				}

				// Import getUserServerRole dynamically to avoid circular dependency
				const { getUserServerRole } = await import("../roles.ts");
				const room = await runtime.getRoom(message.roomId);

				if (!room?.worldId) {
					return true; // Allow in DMs
				}

				const userRole = await getUserServerRole(
					runtime,
					message.entityId,
					room.worldId,
				);

				return allowedRoles.includes(userRole);
			},

			execute: async (
				runtime: IAgentRuntime,
				options: Record<string, unknown>,
				task: Task,
			) => {
				const selectedOption = options.option as string;

				if (!task.id) {
					logger.error({ src: "service:approval" }, "Task has no ID");
					return undefined;
				}

				await this.handleSelection(
					task.id,
					selectedOption,
					options.resolvedBy as UUID | undefined,
				);

				// Delete the task after handling
				await runtime.deleteTask(task.id);
				return undefined;
			},
		};

		this.runtime.registerTaskWorker(worker);
		this.registeredWorkers.add(request.name);

		logger.debug(
			{ src: "service:approval", name: request.name },
			"Registered approval task worker",
		);
	}
}

/**
 * Helper function to create a simple confirm/deny approval
 */
export async function requestConfirmation(
	runtime: IAgentRuntime,
	params: {
		description: string;
		roomId: UUID;
		entityId?: UUID;
		timeoutMs?: number;
		onConfirm?: (task: Task, runtime: IAgentRuntime) => Promise<void>;
		onCancel?: (task: Task, runtime: IAgentRuntime) => Promise<void>;
	},
): Promise<boolean> {
	const service = runtime.getService(
		ServiceType.APPROVAL,
	) as ApprovalService | null;

	if (!service) {
		logger.warn("ApprovalService not available, auto-denying");
		return false;
	}

	const result = await service.requestApproval({
		name: `CONFIRM_${Date.now()}`,
		description: params.description,
		roomId: params.roomId,
		entityId: params.entityId,
		options: STANDARD_OPTIONS.CONFIRM,
		timeoutMs: params.timeoutMs,
		timeoutDefault: "cancel",
		onSelect: async (option, task, rt) => {
			if (option === "confirm" && params.onConfirm) {
				await params.onConfirm(task, rt);
			} else if (option === "cancel" && params.onCancel) {
				await params.onCancel(task, rt);
			}
		},
	});

	return result.success && result.selectedOption === "confirm";
}

export default ApprovalService;
