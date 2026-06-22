/**
 * AgentEventService bridge
 *
 * The runtime emits coarse lifecycle telemetry on the {@link EventType} bus
 * (`RUN_STARTED`, `ACTION_STARTED`, `EVALUATOR_STARTED`, …). Separately,
 * {@link AgentEventService} exposes a fully-typed per-run stream taxonomy
 * (`lifecycle | action | evaluator | tool | provider | …`) that the agent HTTP
 * server broadcasts to WS clients as `agent_event` messages.
 *
 * Historically the `AgentEventService` `action` / `evaluator` / `lifecycle`
 * streams were dead — the `emit*` helpers existed but had no call sites, so the
 * WS channel never carried per-turn phase data. This module is the single
 * bridge that maps the {@link EventType} bus → `AgentEventService` streams
 * (option (b) from issue #8813): one place to wire, every existing event lights
 * up for free, and the streams become reusable beyond the chat indicator.
 *
 * The bridge is intentionally defensive: it resolves `AgentEventService`
 * lazily, no-ops when the service is not hosted (core-only tests, headless
 * tools), and never throws back into the hot message loop.
 */

import { logger } from "../logger.ts";
import type {
	ActionEventPayload,
	EvaluatorEventPayload,
	RunEventPayload,
} from "../types/events.ts";
import type { IAgentRuntime } from "../types/index.ts";
import { ServiceType } from "../types/service.ts";
import type { AgentEventService } from "./agentEvent.ts";

/**
 * Resolve the {@link AgentEventService} if it is registered on the runtime.
 *
 * Duck-typed (rather than `instanceof`) so it works across bundle targets and
 * test doubles. Returns `null` when the service is absent so callers no-op.
 */
function resolveAgentEventService(
	runtime: IAgentRuntime,
): AgentEventService | null {
	try {
		const service = runtime.getService(ServiceType.AGENT_EVENT);
		if (
			service &&
			typeof (service as AgentEventService).emitActionStart === "function"
		) {
			return service as AgentEventService;
		}
	} catch {
		// getService may throw on partially-initialized runtimes; treat as absent.
	}
	return null;
}

/**
 * Resolve the run id to correlate a stream event with. Action/evaluator events
 * do not carry their own run id, so we fall back to the runtime's current run.
 */
function resolveRunId(
	runtime: IAgentRuntime,
	payloadRunId?: string,
): string | null {
	if (payloadRunId) {
		return payloadRunId;
	}
	try {
		return runtime.getCurrentRunId?.() ?? null;
	} catch {
		return null;
	}
}

function resolveActionName(payload: ActionEventPayload): string {
	const actions = payload.content?.actions;
	if (Array.isArray(actions) && typeof actions[0] === "string") {
		return actions[0];
	}
	return "unknown";
}

function readContentRunId(payload: ActionEventPayload): string | undefined {
	const runId = (payload.content as Record<string, unknown> | undefined)?.runId;
	return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

function isSuccessfulActionStatus(payload: ActionEventPayload): boolean {
	// `actionStatus` is set to "completed" | "failed" by the action executors.
	const status = (payload.content as Record<string, unknown> | undefined)
		?.actionStatus;
	return status !== "failed";
}

/**
 * Bridge `ACTION_STARTED` → AgentEventService `action` + `lifecycle` streams.
 */
export function bridgeActionStartedToStreams(
	payload: ActionEventPayload,
): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime, readContentRunId(payload));
	if (!runId) {
		return;
	}
	const actionName = resolveActionName(payload);
	try {
		service.emitActionStart(runId, { actionName });
		service.emitLifecycle(runId, { type: "action_start", actionName });
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge ACTION_STARTED to AgentEventService",
		);
	}
}

/**
 * Bridge `ACTION_COMPLETED` → AgentEventService `action` + `lifecycle` streams.
 */
export function bridgeActionCompletedToStreams(
	payload: ActionEventPayload,
): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime, readContentRunId(payload));
	if (!runId) {
		return;
	}
	const actionName = resolveActionName(payload);
	const success = isSuccessfulActionStatus(payload);
	try {
		service.emitActionComplete(runId, { actionName, success });
		service.emitLifecycle(runId, {
			type: "action_end",
			actionName,
			success,
		});
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge ACTION_COMPLETED to AgentEventService",
		);
	}
}

/**
 * Bridge `RUN_STARTED` → AgentEventService `lifecycle` stream.
 */
export function bridgeRunStartedToStreams(payload: RunEventPayload): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime, payload.runId);
	if (!runId) {
		return;
	}
	try {
		service.emitLifecycle(runId, { type: "run_start" });
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge RUN_STARTED to AgentEventService",
		);
	}
}

/**
 * Bridge `RUN_ENDED` → AgentEventService `lifecycle` stream.
 */
export function bridgeRunEndedToStreams(payload: RunEventPayload): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime, payload.runId);
	if (!runId) {
		return;
	}
	const duration =
		typeof payload.duration === "number" ? payload.duration : undefined;
	try {
		service.emitLifecycle(runId, {
			type: "run_end",
			success: payload.status === "completed",
			...(duration !== undefined ? { duration } : {}),
		});
		// Run is over: drop its per-run sequence/context so the bridge does not
		// leak one map entry per turn over the life of the agent. Emitting first
		// keeps the final `run_end` seq monotonic.
		service.clearRunContext(runId);
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge RUN_ENDED to AgentEventService",
		);
	}
}

/**
 * Bridge `EVALUATOR_STARTED` → AgentEventService `evaluator` stream.
 */
export function bridgeEvaluatorStartedToStreams(
	payload: EvaluatorEventPayload,
): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime);
	if (!runId) {
		return;
	}
	try {
		service.emitEvaluatorStart(runId, {
			evaluatorName: payload.evaluatorName,
		});
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge EVALUATOR_STARTED to AgentEventService",
		);
	}
}

/**
 * Bridge `EVALUATOR_COMPLETED` → AgentEventService `evaluator` stream.
 */
export function bridgeEvaluatorCompletedToStreams(
	payload: EvaluatorEventPayload,
): void {
	const runtime = payload.runtime;
	const service = resolveAgentEventService(runtime);
	if (!service) {
		return;
	}
	const runId = resolveRunId(runtime);
	if (!runId) {
		return;
	}
	try {
		service.emitEvaluatorComplete(runId, {
			evaluatorName: payload.evaluatorName,
			validated: payload.completed === true,
		});
	} catch (err) {
		logger.debug(
			{
				src: "agent-event-bridge",
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to bridge EVALUATOR_COMPLETED to AgentEventService",
		);
	}
}
