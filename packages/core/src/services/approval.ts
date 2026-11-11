/**
 * Task-backed approval workflows with explicit choices, role checks, and
 * optional deadlines. Callback failures remain observable and never resolve an
 * approval as successful when its required side effect did not complete.
 */

import { ElizaError } from "../errors.ts";
import { logger } from "../logger.ts";
import { RuntimeRetirement } from "../runtime/retirement.ts";
import type { Memory } from "../types/memory.js";
import {
	PENDING_USER_ACTION_WEIGHT,
	type PendingUserAction,
} from "../types/pending-user-action.js";
import type { UUID } from "../types/primitives.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { Service, ServiceType } from "../types/service.ts";
import type { State } from "../types/state.js";
import type { Task, TaskWorker } from "../types/task.js";

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
	/** A receipt-bearing cancellation exclusively owns this request until storage settles. */
	cancelling?: boolean;
	/** The admitted public result is the synchronous caller's settlement boundary. */
	result?: Promise<ApprovalResult>;
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
 * Typed cancel classification shared by timeout and selection.
 * Only an existing option whose `isCancel` is explicitly true is a cancel.
 * A missing name fail-closes as cancel. Names such as `ABORT` are not special.
 */
function isCancelApprovalOption(
	options: readonly ApprovalOption[] | undefined,
	selectedName: string,
): boolean {
	if (!options) return true;
	const option = options.find((o) => o.name === selectedName);
	return option ? option.isCancel === true : true;
}

/**
 * ApprovalService provides a interface for task-based approvals.
 */
export class ApprovalService extends Service {
	static serviceType: string = ServiceType.APPROVAL;
	capabilityDescription = "Manages approval workflows using the task system";

	private pendingApprovals = new Map<UUID, PendingApproval>();
	private registeredWorkers = new Set<string>();
	private readonly operations = new RuntimeRetirement();
	private stopped = false;

	private requireRunning(): void {
		if (this.stopped) {
			throw new ElizaError("Approval service has stopped", {
				code: "APPROVAL_SERVICE_STOPPED",
			});
		}
	}

	private withAdmission<T>(operation: () => Promise<T>): Promise<T> {
		this.requireRunning();
		return this.operations.run(operation);
	}

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
		this.stopped = true;
		// Resolve all pending approvals with cancelled before clearing
		for (const pending of this.pendingApprovals.values()) {
			// Its admitted cancellation owns settlement through the delete acknowledgement.
			if (pending.cancelling) continue;
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
		// A claimed callback keeps its result; teardown waits for its effects and
		// for admitted task writes to settle before the runtime can close storage.
		await this.operations.drain();
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
	 * name: 'EXEC_APPROVAL',
	 * description: 'Execute command: rm -rf /tmp/cache',
	 * roomId: message.roomId,
	 * options: STANDARD_OPTIONS.ALLOW_ONCE_ALWAYS_DENY,
	 * timeoutMs: 120000,
	 * timeoutDefault: 'deny',
	 * onSelect: async (option, task, runtime) => {
	 * if (option === 'allow-always') {
	 * await addToAllowlist(command);
	 * }
	 * },
	 * });
	 *
	 * if (result.success && result.selectedOption !== 'deny') {
	 * await executeCommand();
	 * }
	 * ```
	 */
	requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
		try {
			const result: Promise<ApprovalResult> = this.withAdmission(async () => {
				const taskId = await this.createApprovalTask(request, false);
				if (this.stopped) {
					await this.runtime.deleteTask(taskId);
					this.requireRunning();
				}

				const decision = new Promise<ApprovalResult>((resolve, reject) => {
					const pending: PendingApproval = {
						result,
						taskId,
						request,
						createdAt: Date.now(),
						resolve,
						reject,
					};
					// error-policy:J1 Timer callbacks are an asynchronous process
					// boundary; reject the waiting caller and report the failure.
					this.armTimeout(pending, "ApprovalService.timeout", (error) =>
						pending.reject(
							error instanceof Error ? error : new Error(String(error)),
						),
					);
					this.pendingApprovals.set(taskId, pending);
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
				return decision;
			});
			return result;
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	 * Request approval without waiting (fire and forget with callbacks).
	 * Useful when you don't need to block on the approval result.
	 */
	async requestApprovalAsync(request: ApprovalRequest): Promise<UUID> {
		return this.withAdmission(async () => {
			const taskId = await this.createApprovalTask(request, true);
			if (this.stopped) {
				await this.runtime.deleteTask(taskId);
				this.requireRunning();
			}

			// Track every live request: callback-free requests still own their deadline.
			const pending: PendingApproval = {
				taskId,
				request,
				createdAt: Date.now(),
				resolve: () => {},
				reject: () => {},
			};
			// error-policy:J1 Fire-and-forget approvals have no awaiting caller,
			// so the diagnostic channel is their observable failure boundary.
			this.armTimeout(pending, "ApprovalService.asyncTimeout");
			this.pendingApprovals.set(taskId, pending);

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

			return taskId;
		});
	}

	/** Register the worker for this approval type, then persist its AWAITING_CHOICE task. */
	private async createApprovalTask(
		request: ApprovalRequest,
		isAsync: boolean,
	): Promise<UUID> {
		await this.ensureWorkerRegistered(request);
		this.requireRunning();
		return this.runtime.createTask({
			name: request.name,
			description: request.description,
			roomId: request.roomId,
			entityId: request.entityId,
			tags: ["AWAITING_CHOICE", "APPROVAL", ...(request.tags ?? [])],
			metadata: {
				...(request.metadata ?? {}),
				options: request.options.map((opt) => ({
					name: opt.name,
					description: opt.description ?? "",
				})),
				approvalRequest: {
					timeoutMs: request.timeoutMs,
					timeoutDefault: request.timeoutDefault,
					allowedRoles: request.allowedRoles ?? ["OWNER", "ADMIN"],
					createdAt: Date.now(),
					...(isAsync ? { isAsync: true } : {}),
				},
				onSelectCallback: !!request.onSelect,
				onTimeoutCallback: !!request.onTimeout,
			},
		});
	}

	/** Arm the request timeout; a failed timeout handler is reported and drops the pending entry. */
	private armTimeout(
		pending: PendingApproval,
		scope: string,
		onError?: (error: unknown) => void,
	): void {
		const { timeoutMs } = pending.request;
		if (pending.expiresAt === undefined) {
			if (!timeoutMs || timeoutMs <= 0) return;
			pending.expiresAt = pending.createdAt + timeoutMs;
		}
		const { taskId } = pending;
		pending.timeoutHandle = setTimeout(
			() => {
				if (this.stopped) return;
				void this.operations.run(() =>
					this.handleTimeout(taskId).catch((error) => {
						this.runtime.reportError(scope, error, { taskId });
						this.pendingApprovals.delete(taskId);
						onError?.(error);
					}),
				);
			},
			Math.max(0, pending.expiresAt - Date.now()),
		);
	}

	/**
	 * Cancel a pending approval
	 */
	async cancelApproval(taskId: UUID): Promise<void> {
		return this.withAdmission(async () => {
			const pending = this.pendingApprovals.get(taskId);
			// A receipt-bearing cancellation already owns this exact request.
			if (pending?.cancelling) {
				throw new ElizaError("Approval cancellation is already in progress", {
					code: "APPROVAL_CALLBACK_UNAVAILABLE",
					context: { taskId },
				});
			}
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
		});
	}

	/** Cancel only a live, unclaimed approval, acknowledging its durable removal
	 * before settling the caller. Claimed or unavailable owners fail closed; the
	 * legacy cancelApproval method remains available for orphan-row cleanup. */
	async cancelPendingApproval(taskId: UUID): Promise<void> {
		return this.withAdmission(async () => {
			const pending = this.pendingApprovals.get(taskId);
			if (!pending || pending.cancelling) {
				throw new ElizaError("Approval callback is no longer available", {
					code: "APPROVAL_CALLBACK_UNAVAILABLE",
					context: { taskId },
				});
			}
			// Keep the exclusive claim on the existing owner. Removing it would
			// allow callback-free persisted selection to bypass the missing owner.
			pending.cancelling = true;
			if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
			try {
				await this.runtime.deleteTask(taskId);
			} catch (error) {
				// error-policy:J2 Failed deletion is not a cancellation receipt.
				// Restore the original caller and absolute deadline for a retry.
				pending.cancelling = false;
				if (this.stopped) {
					pending.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
				} else {
					this.pendingApprovals.set(taskId, pending);
					this.armTimeout(
						pending,
						"ApprovalService.cancelRetryTimeout",
						(cause) =>
							pending.reject(
								cause instanceof Error ? cause : new Error(String(cause)),
							),
					);
				}
				throw error;
			}
			this.pendingApprovals.delete(taskId);
			pending.resolve({
				selectedOption: "cancel",
				success: false,
				timedOut: false,
				cancelled: true,
				taskId,
				resolvedAt: Date.now(),
			});
			await pending.result;
			logger.info(
				{ src: "service:approval", taskId },
				"Approval cancellation confirmed",
			);
		});
	}

	/**
	 * Get all pending approvals for a room
	 */
	async getPendingApprovals(roomId: UUID): Promise<Task[]> {
		return this.withAdmission(() =>
			this.runtime.getTasks({
				roomId,
				tags: ["AWAITING_CHOICE", "APPROVAL"],
				agentIds: [this.runtime.agentId],
			}),
		);
	}

	/**
	 * Get every pending approval across all rooms for this agent. Powers the
	 * canonical "needs your response" surface, which aggregates the
	 * agent's blocked-on-user decisions rather than scoping to one room.
	 */
	async getAllPendingApprovals(): Promise<Task[]> {
		return this.withAdmission(() =>
			this.runtime.getTasks({
				tags: ["AWAITING_CHOICE", "APPROVAL"],
				agentIds: [this.runtime.agentId],
			}),
		);
	}

	/**
	 * List every in-flight approval as a canonical {@link PendingUserAction} — the
	 * shared "the agent is waiting on you" shape that a needs-attention UI, a
	 * provider, and the home-attention ranker all read.
	 *
	 * Unlike {@link getPendingApprovals} (room-scoped raw `Task`s with no caller),
	 * this is agent-wide and pre-normalized, so callers don't reshape per surface.
	 */
	listPendingUserActions(): PendingUserAction[] {
		const actions: PendingUserAction[] = [];
		for (const pending of this.pendingApprovals.values()) {
			actions.push({
				id: pending.taskId,
				kind: "task_approval",
				source: "approval-service",
				title: pending.request.description,
				roomId: pending.request.roomId,
				options: pending.request.options.map((option) => ({
					id: option.name,
					label: option.description ?? option.name,
					...(option.isDefault ? { isDefault: true } : {}),
					...(option.isCancel ? { isCancel: true } : {}),
				})),
				weight: PENDING_USER_ACTION_WEIGHT.task_approval,
				resolution: {
					target: "approval_service",
					requestId: pending.taskId,
				},
				createdAt: pending.createdAt,
				expiresAt: pending.expiresAt ?? null,
			});
		}
		return actions;
	}

	/**
	 * Handle timeout for a pending approval
	 */
	private async handleTimeout(taskId: UUID): Promise<void> {
		const pending = this.pendingApprovals.get(taskId);
		if (!pending || pending.cancelling) return;
		// Take the approval before the first await, so a racing selection or
		// cancel cannot also settle it (quint/ApprovalService.qnt, AtMostOneCallback).
		this.pendingApprovals.delete(taskId);

		const { request } = pending;

		logger.info(
			{ src: "service:approval", taskId, name: request.name },
			"Approval timed out",
		);

		// Call timeout callback if provided
		const task = await this.runtime.getTask(taskId);
		if (!task) {
			throw new ElizaError("Approval task is no longer available for timeout", {
				code: "APPROVAL_TASK_UNAVAILABLE",
				context: { taskId },
			});
		}
		if (request.onTimeout) {
			await request.onTimeout(task, this.runtime);
		}

		// Resolve with timeout default or cancel
		const defaultOption = request.timeoutDefault ?? "cancel";
		const isCancel = isCancelApprovalOption(request.options, defaultOption);

		pending.resolve({
			selectedOption: defaultOption,
			success: !isCancel,
			timedOut: true,
			cancelled: isCancel,
			taskId,
			resolvedAt: Date.now(),
		});

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
		return this.withAdmission(async () => {
			const task = await this.runtime.getTask(taskId);
			if (this.stopped) return;
			if (!task) {
				logger.warn(
					{ src: "service:approval", taskId },
					"Task not found for approval selection",
				);
				return;
			}
			// Take the approval before onSelect runs: a racing timeout, cancel or
			// second selection then finds nothing (quint/ApprovalService.qnt).
			const pending = this.pendingApprovals.get(taskId);
			const persistedRequest = task.metadata?.approvalRequest as
				| Record<string, unknown>
				| undefined;
			const callbackFreeAsync =
				persistedRequest?.isAsync === true &&
				task.metadata?.onSelectCallback === false &&
				task.metadata?.onTimeoutCallback === false;
			// Functions are not durable task data. Never acknowledge an orphaned or
			// already-claimed callback task as if its required effect had completed.
			if (pending?.cancelling || (!pending && !callbackFreeAsync)) {
				throw new ElizaError("Approval callback is no longer available", {
					code: "APPROVAL_CALLBACK_UNAVAILABLE",
					context: { taskId },
				});
			}
			if (pending) {
				this.pendingApprovals.delete(taskId);
				if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
			}

			const request = pending?.request;
			const isCancel = isCancelApprovalOption(request?.options, selectedOption);

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
					// error-policy:J1 the taken approval must still settle its caller.
					pending?.reject(
						error instanceof Error ? error : new Error(String(error)),
					);
					throw error;
				}
			}

			pending?.resolve({
				selectedOption,
				success: !isCancel,
				timedOut: false,
				cancelled: isCancel,
				taskId,
				resolvedBy,
				resolvedAt: Date.now(),
			});
		});
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
				return this.withAdmission(async () => {
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

					//: resolve the sender's role from the message via
					// checkSenderRole, which hashes the room's serverId once through the
					// world lookup. The prior getUserServerRole(runtime, entityId,
					// room.worldId) passed an ALREADY-hashed worldId as serverId, so it
					// double-hashed, found no world, returned NONE, and made every
					// role-restricted approval unapprovable in server rooms.
					const { checkSenderRole } = await import("../roles.ts");
					const room = await runtime.getRoom(message.roomId);

					if (!room?.worldId) {
						return true; // Allow in DMs (no server role to enforce)
					}

					const senderRole = await checkSenderRole(runtime, message);
					return senderRole ? allowedRoles.includes(senderRole.role) : false;
				});
			},

			execute: async (
				runtime: IAgentRuntime,
				options: Record<string, unknown>,
				task: Task,
			) => {
				const selectedOption = options.option as string;
				const taskId = task.id;

				if (!taskId) {
					logger.error({ src: "service:approval" }, "Task has no ID");
					return undefined;
				}

				return this.withAdmission(async () => {
					await this.handleSelection(
						taskId,
						selectedOption,
						options.resolvedBy as UUID | undefined,
					);

					// Delete the task after handling
					await runtime.deleteTask(taskId);
					return undefined;
				});
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
		// One worker name for every confirmation: the worker is registered once
		// per name, choices resolve by task id, and every confirmation shares the
		// same default allowed roles, so a per-call name only leaked workers.
		name: "CONFIRM",
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
