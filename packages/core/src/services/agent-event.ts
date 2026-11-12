/**
 * Synchronous agent-event and heartbeat fan-out with per-run sequencing.
 * Listener isolation keeps one observer from starving its siblings while every
 * observer failure is surfaced through the runtime diagnostic channel.
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
	MessageEventData,
} from "../types/agent-event.ts";
import type { UUID } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.js";
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

function subscribeListener<Listener>(
	listeners: Map<Listener, () => void>,
	listener: Listener,
): () => void {
	const existing = listeners.get(listener);
	if (existing) return existing;
	const unsubscribe = () => {
		if (listeners.get(listener) === unsubscribe) listeners.delete(listener);
	};
	listeners.set(listener, unsubscribe);
	return unsubscribe;
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
	private eventListeners = new Map<AgentEventListener, () => void>();

	/** Heartbeat event listeners */
	private heartbeatListeners = new Map<HeartbeatEventListener, () => void>();

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

		const errors: unknown[] = [];
		for (const listener of this.eventListeners.keys()) {
			try {
				listener(enriched);
			} catch (error) {
				// error-policy:J7 Event observers are diagnostics/stream consumers;
				// report their failure without starving independent listeners.
				errors.push(error);
			}
		}
		// Reporting can emit a new event on this run. Finish fan-out first
		// so observers see the original sequence before its diagnostics.
		for (const error of errors) {
			this.runtime.reportError("AgentEventService.listener", error, {
				stream: enriched.stream,
				runId: enriched.runId,
			});
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
		return subscribeListener(this.eventListeners, listener);
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
		for (const listener of this.heartbeatListeners.keys()) {
			try {
				listener(enriched);
			} catch (error) {
				// error-policy:J7 Heartbeat observers are independent diagnostic
				// consumers; one broken listener must not stop the rest.
				heartbeatErrors++;
				this.runtime.reportError("AgentEventService.heartbeatListener", error, {
					status: enriched.status,
				});
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
		return subscribeListener(this.heartbeatListeners, listener);
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
}

export default AgentEventService;
