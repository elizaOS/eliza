/**
 * AgentEventService
 *
 * A centralized service for managing agent event streams.
 * Provides event emission, subscription, and run context tracking
 * for agent lifecycle events, tool usage, assistant responses, errors, and heartbeats.
 *
 * This service consolidates event handling that was previously scattered
 * across Otto's agent-events.ts and heartbeat-events.ts.
 *
 * @example
 * ```typescript
 * const eventService = runtime.getService(ServiceType.AGENT_EVENT) as AgentEventService;
 *
 * // Subscribe to events
 * const unsubscribe = eventService.subscribe((event) => {
 *   console.log(`[${event.stream}] ${event.runId}:${event.seq}`, event.data);
 * });
 *
 * // Register run context
 * eventService.registerRunContext('run-123', {
 *   sessionKey: 'session-abc',
 *   verboseLevel: 'verbose',
 * });
 *
 * // Emit events
 * eventService.emit({
 *   runId: 'run-123',
 *   stream: 'lifecycle',
 *   data: { type: 'run_start', stepName: 'process_message' },
 * });
 *
 * // Emit heartbeat
 * eventService.emitHeartbeat({
 *   status: 'ok-token',
 *   to: 'user@example.com',
 *   preview: 'Hello, world!',
 * });
 *
 * // Cleanup
 * unsubscribe();
 * eventService.clearRunContext('run-123');
 * ```
 */

import { logger } from "../logger.ts";
import type {
	ActionEventData,
	AgentEventInput,
	AgentEventListener,
	AgentEventPayload,
	AgentRunContext,
	EvaluatorEventData,
	HeartbeatEventInput,
	HeartbeatEventListener,
	HeartbeatEventPayload,
	HeartbeatIndicatorType,
	HeartbeatStatus,
	MemoryEventData,
	MessageEventData,
	ProviderEventData,
} from "../types/agentEvent.ts";
import type { IAgentRuntime } from "../types/index.ts";
import type { UUID } from "../types/primitives.ts";
import { Service, ServiceType } from "../types/service.ts";

/**
 * Resolve heartbeat status to an indicator type for UI display
 */
export function resolveHeartbeatIndicator(
	status: HeartbeatStatus,
): HeartbeatIndicatorType | undefined {
	switch (status) {
		case "ok-empty":
		case "ok-token":
			return "ok";
		case "sent":
			return "alert";
		case "failed":
			return "error";
		case "skipped":
			return undefined;
		default:
			return undefined;
	}
}

/**
 * AgentEventService provides a interface for agent event streaming.
 * It manages event emission, subscription, and run context tracking.
 */
export class AgentEventService extends Service {
	static serviceType: string = ServiceType.AGENT_EVENT;
	capabilityDescription =
		"Manages agent event streaming for lifecycle, messages, actions, evaluators, providers, memory, tools, and heartbeats";

	/** Per-run sequence counters for monotonic numbering */
	private seqByRun = new Map<string, number>();

	/** Event listeners */
	private eventListeners = new Set<AgentEventListener>();

	/** Heartbeat event listeners */
	private heartbeatListeners = new Set<HeartbeatEventListener>();

	/** Run context by run ID */
	private runContextById = new Map<string, AgentRunContext>();

	/** Last heartbeat event (for UI status) */
	private lastHeartbeat: HeartbeatEventPayload | null = null;

	/**
	 * Start the AgentEventService
	 */
	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new AgentEventService(runtime);
		logger.debug({ src: "service:agent_event" }, "AgentEventService started");
		return service;
	}

	/**
	 * Stop the AgentEventService
	 */
	async stop(): Promise<void> {
		this.eventListeners.clear();
		this.heartbeatListeners.clear();
		this.seqByRun.clear();
		this.runContextById.clear();
		this.lastHeartbeat = null;
		logger.debug({ src: "service:agent_event" }, "AgentEventService stopped");
	}

	/**
	 * Register context for a run (session key, verbose level, etc.)
	 */
	registerRunContext(runId: string, context: AgentRunContext): void {
		if (!runId) {
			return;
		}

		const existing = this.runContextById.get(runId);
		if (!existing) {
			this.runContextById.set(runId, { ...context });
			return;
		}

		// Merge with existing context
		if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
			existing.sessionKey = context.sessionKey;
		}
		if (
			context.verboseLevel &&
			existing.verboseLevel !== context.verboseLevel
		) {
			existing.verboseLevel = context.verboseLevel;
		}
		if (
			context.isHeartbeat !== undefined &&
			existing.isHeartbeat !== context.isHeartbeat
		) {
			existing.isHeartbeat = context.isHeartbeat;
		}
		if (context.agentId && existing.agentId !== context.agentId) {
			existing.agentId = context.agentId;
		}
		if (context.roomId && existing.roomId !== context.roomId) {
			existing.roomId = context.roomId;
		}
	}

	/**
	 * Get run context by ID
	 */
	getRunContext(runId: string): AgentRunContext | undefined {
		return this.runContextById.get(runId);
	}

	/**
	 * Clear run context
	 */
	clearRunContext(runId: string): void {
		this.runContextById.delete(runId);
		this.seqByRun.delete(runId);
	}

	/**
	 * Clear all run contexts (useful for testing)
	 */
	clearAllRunContexts(): void {
		this.runContextById.clear();
		this.seqByRun.clear();
	}

	/**
	 * Emit an agent event
	 */
	emit(event: AgentEventInput): void {
		const nextSeq = (this.seqByRun.get(event.runId) ?? 0) + 1;
		this.seqByRun.set(event.runId, nextSeq);

		const context = this.runContextById.get(event.runId);
		const sessionKey =
			typeof event.sessionKey === "string" && event.sessionKey.trim()
				? event.sessionKey
				: context?.sessionKey;

		const enriched: AgentEventPayload = {
			...event,
			sessionKey,
			seq: nextSeq,
			ts: Date.now(),
		};

		const errors: Array<{ listener: AgentEventListener; error: unknown }> = [];
		for (const listener of this.eventListeners) {
			try {
				listener(enriched);
			} catch (error) {
				errors.push({ listener, error });
				logger.error(
					{
						src: "service:agent_event",
						error,
						stream: enriched.stream,
						runId: enriched.runId,
					},
					"Error in event listener - listener threw exception",
				);
			}
		}

		// If any listeners failed, emit an error event (but only if this isn't already an error event)
		if (errors.length > 0 && event.stream !== "error") {
			this.emit({
				runId: event.runId,
				stream: "error",
				data: {
					type: "warning",
					message: `${errors.length} event listener(s) threw exceptions`,
					code: "LISTENER_ERROR",
					recoverable: true,
				},
				sessionKey: event.sessionKey,
			});
		}
	}

	/**
	 * Subscribe to agent events
	 * @returns Unsubscribe function
	 */
	subscribe(listener: AgentEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	/**
	 * Emit a heartbeat event
	 */
	emitHeartbeat(event: HeartbeatEventInput): void {
		const enriched: HeartbeatEventPayload = {
			ts: Date.now(),
			...event,
			indicatorType:
				event.indicatorType ?? resolveHeartbeatIndicator(event.status),
		};

		this.lastHeartbeat = enriched;

		let heartbeatErrors = 0;
		for (const listener of this.heartbeatListeners) {
			try {
				listener(enriched);
			} catch (error) {
				heartbeatErrors++;
				logger.error(
					{ src: "service:agent_event", error, status: enriched.status },
					"Error in heartbeat listener - listener threw exception",
				);
			}
		}

		if (heartbeatErrors > 0) {
			logger.warn(
				{ src: "service:agent_event", errorCount: heartbeatErrors },
				"Heartbeat event completed with listener errors",
			);
		}
	}

	/**
	 * Subscribe to heartbeat events
	 * @returns Unsubscribe function
	 */
	subscribeHeartbeat(listener: HeartbeatEventListener): () => void {
		this.heartbeatListeners.add(listener);
		return () => this.heartbeatListeners.delete(listener);
	}

	/**
	 * Get the last heartbeat event
	 */
	getLastHeartbeat(): HeartbeatEventPayload | null {
		return this.lastHeartbeat;
	}

	/**
	 * Get current sequence number for a run
	 */
	getCurrentSeq(runId: string): number {
		return this.seqByRun.get(runId) ?? 0;
	}

	/**
	 * Helper: Emit a lifecycle event
	 */
	emitLifecycle(
		runId: string,
		data: {
			type:
				| "run_start"
				| "run_end"
				| "step_start"
				| "step_end"
				| "context_loaded"
				| "action_start"
				| "action_end";
			stepName?: string;
			actionName?: string;
			duration?: number;
			success?: boolean;
			error?: string;
		},
		sessionKey?: string,
	): void {
		this.emit({
			runId,
			stream: "lifecycle",
			data,
			sessionKey,
		});
	}

	/**
	 * Helper: Emit a tool event
	 */
	emitTool(
		runId: string,
		data: {
			type: "tool_call" | "tool_result" | "tool_error";
			toolName: string;
			input?: Record<string, unknown>;
			output?: Record<string, unknown>;
			duration?: number;
			error?: string;
		},
		sessionKey?: string,
	): void {
		this.emit({
			runId,
			stream: "tool",
			data,
			sessionKey,
		});
	}

	/**
	 * Helper: Emit an assistant event
	 */
	emitAssistant(
		runId: string,
		data: {
			type: "message" | "thought" | "plan" | "reflection";
			content: string;
			role?: "assistant" | "user" | "system";
			tokens?: number;
		},
		sessionKey?: string,
	): void {
		this.emit({
			runId,
			stream: "assistant",
			data,
			sessionKey,
		});
	}

	/**
	 * Helper: Emit an error event
	 */
	emitError(
		runId: string,
		data: {
			type: "error" | "warning";
			code?: string;
			message: string;
			stack?: string;
			recoverable?: boolean;
		},
		sessionKey?: string,
	): void {
		this.emit({
			runId,
			stream: "error",
			data,
			sessionKey,
		});
	}

	/**
	 * Helper: Emit a message event (received, sent, queued, failed)
	 */
	emitMessage(
		runId: string,
		data: MessageEventData,
		sessionKey?: string,
	): void {
		this.emit({
			runId,
			stream: "message",
			data,
			sessionKey,
		});
	}

	/**
	 * Convenience: Emit message received event
	 */
	emitMessageReceived(
		runId: string,
		params: {
			messageId?: UUID;
			channel?: string;
			userId?: UUID;
			roomId?: UUID;
			content?: string;
			hasAttachments?: boolean;
		},
		sessionKey?: string,
	): void {
		this.emitMessage(runId, { type: "received", ...params }, sessionKey);
	}

	/**
	 * Convenience: Emit message sent event
	 */
	emitMessageSent(
		runId: string,
		params: {
			messageId?: UUID;
			channel?: string;
			userId?: UUID;
			roomId?: UUID;
			content?: string;
			hasAttachments?: boolean;
			deliveredAt?: number;
		},
		sessionKey?: string,
	): void {
		this.emitMessage(
			runId,
			{ type: "sent", deliveredAt: Date.now(), ...params },
			sessionKey,
		);
	}

	/**
	 * Helper: Emit an action event (start, complete, error, skipped)
	 */
	emitAction(runId: string, data: ActionEventData, sessionKey?: string): void {
		this.emit({
			runId,
			stream: "action",
			data,
			sessionKey,
		});
	}

	/**
	 * Convenience: Emit action start event
	 */
	emitActionStart(
		runId: string,
		params: {
			actionName: string;
			handler?: string;
			input?: Record<string, unknown>;
			memoryId?: UUID;
		},
		sessionKey?: string,
	): void {
		this.emitAction(runId, { type: "start", ...params }, sessionKey);
	}

	/**
	 * Convenience: Emit action complete event
	 */
	emitActionComplete(
		runId: string,
		params: {
			actionName: string;
			handler?: string;
			output?: Record<string, unknown>;
			duration?: number;
			success?: boolean;
			memoryId?: UUID;
		},
		sessionKey?: string,
	): void {
		this.emitAction(runId, { type: "complete", ...params }, sessionKey);
	}

	/**
	 * Convenience: Emit action error event
	 */
	emitActionError(
		runId: string,
		params: {
			actionName: string;
			handler?: string;
			error: string;
			duration?: number;
			memoryId?: UUID;
		},
		sessionKey?: string,
	): void {
		this.emitAction(
			runId,
			{ type: "error", success: false, ...params },
			sessionKey,
		);
	}

	/**
	 * Helper: Emit an evaluator event (start, complete, error, skipped)
	 */
	emitEvaluator(
		runId: string,
		data: EvaluatorEventData,
		sessionKey?: string,
	): void {
		this.emit({
			runId,
			stream: "evaluator",
			data,
			sessionKey,
		});
	}

	/**
	 * Convenience: Emit evaluator start event
	 */
	emitEvaluatorStart(
		runId: string,
		params: {
			evaluatorName: string;
			messageId?: UUID;
		},
		sessionKey?: string,
	): void {
		this.emitEvaluator(runId, { type: "start", ...params }, sessionKey);
	}

	/**
	 * Convenience: Emit evaluator complete event
	 */
	emitEvaluatorComplete(
		runId: string,
		params: {
			evaluatorName: string;
			validated?: boolean;
			result?: unknown;
			duration?: number;
			messageId?: UUID;
		},
		sessionKey?: string,
	): void {
		this.emitEvaluator(runId, { type: "complete", ...params }, sessionKey);
	}

	/**
	 * Helper: Emit a provider event (start, complete, error, cached)
	 */
	emitProvider(
		runId: string,
		data: ProviderEventData,
		sessionKey?: string,
	): void {
		this.emit({
			runId,
			stream: "provider",
			data,
			sessionKey,
		});
	}

	/**
	 * Convenience: Emit provider start event
	 */
	emitProviderStart(
		runId: string,
		params: {
			providerName: string;
		},
		sessionKey?: string,
	): void {
		this.emitProvider(runId, { type: "start", ...params }, sessionKey);
	}

	/**
	 * Convenience: Emit provider complete event
	 */
	emitProviderComplete(
		runId: string,
		params: {
			providerName: string;
			data?: unknown;
			duration?: number;
			fromCache?: boolean;
			tokens?: number;
		},
		sessionKey?: string,
	): void {
		this.emitProvider(runId, { type: "complete", ...params }, sessionKey);
	}

	/**
	 * Helper: Emit a memory event (create, update, delete, search, retrieved)
	 */
	emitMemory(runId: string, data: MemoryEventData, sessionKey?: string): void {
		this.emit({
			runId,
			stream: "memory",
			data,
			sessionKey,
		});
	}

	/**
	 * Convenience: Emit memory create event
	 */
	emitMemoryCreate(
		runId: string,
		params: {
			memoryId: UUID;
			tableName?: string;
			roomId?: UUID;
			preview?: string;
		},
		sessionKey?: string,
	): void {
		this.emitMemory(
			runId,
			{ type: "create", success: true, ...params },
			sessionKey,
		);
	}

	/**
	 * Convenience: Emit memory search event
	 */
	emitMemorySearch(
		runId: string,
		params: {
			tableName?: string;
			roomId?: UUID;
			count?: number;
			duration?: number;
		},
		sessionKey?: string,
	): void {
		this.emitMemory(
			runId,
			{ type: "search", success: true, ...params },
			sessionKey,
		);
	}

	/**
	 * Convenience: Emit memory retrieved event
	 */
	emitMemoryRetrieved(
		runId: string,
		params: {
			memoryId?: UUID;
			tableName?: string;
			roomId?: UUID;
			count?: number;
			preview?: string;
		},
		sessionKey?: string,
	): void {
		this.emitMemory(
			runId,
			{ type: "retrieved", success: true, ...params },
			sessionKey,
		);
	}
}

export default AgentEventService;
