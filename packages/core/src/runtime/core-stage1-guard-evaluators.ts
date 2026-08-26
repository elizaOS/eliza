/**
 * Core post-Stage-1 guard evaluators, always-on deterministic patchers that
 * run AFTER every builtin and plugin-registered response-handler evaluator:
 *
 * 1. `core.stage1_context_fallback` — Stage 1 routed a context id the current
 *    surface does not offer. Silently dropping it stranded requiresTool turns
 *    on their bare ack (live 2026-08-24, room 46a7751d: contexts=["tasks"] +
 *    OWNER_REMINDERS where only simple/general existed; "i'll nudge everyone
 *    in 10 minutes" shipped and nothing ever ran). The guard keeps known ids,
 *    substitutes `general` for an all-unknown planning pick, and pins
 *    requiresTool so the router provably enters the planner with the Stage-1
 *    candidates — the ack is then honored or replaced by an honest reply.
 *
 * 2. `core.stage1_execution_claim_guard` — a simple-path reply promised
 *    imminent tool/background output ("i'll re-run it now", "will post the
 *    output the second it lands") on a turn that routed NO tool work. The
 *    promise is dishonest by construction, so the guard rewrites the reply to
 *    the canonical interim ack and promotes the turn to planning against
 *    `general`, where the planner either does the work or answers honestly.
 *    Opt out with ELIZA_STAGE1_EXECUTION_CLAIM_GUARD=0|false|off.
 */
import type { IAgentRuntime } from "../types/runtime";
import { replyPromisesImminentExecution } from "./execution-claim-guard";
import { SIMPLE_CONTEXT_ID } from "./message-handler";
import type { ResponseHandlerEvaluator } from "./response-handler-evaluators";
import {
	resolveStage1ContextFallback,
	STAGE1_FALLBACK_CONTEXT_ID,
} from "./stage1-context-fallback";

/**
 * Guards run last on purpose: earlier evaluators may rewrite contexts,
 * candidates, or the reply, and the guards must judge the final plan.
 */
const CONTEXT_FALLBACK_PRIORITY = 10_000;
const EXECUTION_CLAIM_PRIORITY = 10_100;

function isExecutionClaimGuardEnabled(runtime: IAgentRuntime): boolean {
	const raw =
		typeof runtime.getSetting === "function"
			? runtime.getSetting("ELIZA_STAGE1_EXECUTION_CLAIM_GUARD")
			: undefined;
	if (raw === undefined || raw === null) return true;
	const normalized = String(raw).trim().toLowerCase();
	return !["0", "false", "no", "off"].includes(normalized);
}

const stage1ContextFallbackEvaluator: ResponseHandlerEvaluator = {
	name: "core.stage1_context_fallback",
	description:
		"Replaces unknown Stage-1 context ids: known ids are kept, and an all-unknown tool-committed selection falls back to general so the planner still runs with the Stage-1 candidates.",
	priority: CONTEXT_FALLBACK_PRIORITY,
	shouldRun: ({ messageHandler, availableContexts }) => {
		if (messageHandler.processMessage !== "RESPOND") return false;
		if (availableContexts.length === 0) return false;
		const available = new Set(
			availableContexts.map((definition) =>
				String(definition.id).trim().toLowerCase(),
			),
		);
		return messageHandler.plan.contexts.some((context) => {
			const id = String(context).trim().toLowerCase();
			return id.length > 0 && id !== SIMPLE_CONTEXT_ID && !available.has(id);
		});
	},
	evaluate: ({ runtime, messageHandler, availableContexts }) => {
		const resolution = resolveStage1ContextFallback({
			selectedContexts: messageHandler.plan.contexts,
			availableContextIds: availableContexts.map((definition) =>
				String(definition.id),
			),
			requiresTool: messageHandler.plan.requiresTool,
			candidateActionCount: (messageHandler.plan.candidateActions ?? []).length,
		});
		if (!resolution.changed) return undefined;
		runtime.logger?.debug?.(
			{
				src: "response-handler-evaluator",
				evaluator: "core.stage1_context_fallback",
				droppedContexts: resolution.droppedUnknownContexts,
				contexts: resolution.contexts,
				fallbackApplied: resolution.fallbackApplied,
			},
			"[stage1] Unknown context id(s) from Stage 1 resolved against the available surface",
		);
		return {
			setContexts: resolution.contexts,
			// A fallback means the plan committed to tool work while every
			// non-simple context it picked was unavailable — pin requiresTool so
			// the router provably plans instead of ending at the ack.
			...(resolution.fallbackApplied ? { requiresTool: true } : {}),
			debug: [
				`dropped unknown context id(s): ${resolution.droppedUnknownContexts.join(", ")}`,
				...(resolution.fallbackApplied
					? [
							`fell back to ${STAGE1_FALLBACK_CONTEXT_ID}: stage-1 committed tool work with no available context`,
						]
					: []),
			],
		};
	},
};

const stage1ExecutionClaimGuardEvaluator: ResponseHandlerEvaluator = {
	name: "core.stage1_execution_claim_guard",
	description:
		"Promotes a simple-path turn whose reply promises imminent tool/background output to planning, replacing the un-honorable promise with the canonical interim ack.",
	priority: EXECUTION_CLAIM_PRIORITY,
	shouldRun: ({ runtime, messageHandler }) => {
		if (messageHandler.processMessage !== "RESPOND") return false;
		if (!isExecutionClaimGuardEnabled(runtime)) return false;
		const plan = messageHandler.plan;
		// Turns that already routed tool work keep their ack — the planner (and
		// its honesty post-passes) owns the promise from here.
		if (plan.requiresTool === true) return false;
		if ((plan.candidateActions ?? []).length > 0) return false;
		if (plan.deterministicToolCall) return false;
		const hasNonSimpleContext = plan.contexts.some((context) => {
			const id = String(context).trim().toLowerCase();
			return id.length > 0 && id !== SIMPLE_CONTEXT_ID;
		});
		if (hasNonSimpleContext) return false;
		return replyPromisesImminentExecution(String(plan.reply ?? ""));
	},
	evaluate: ({ runtime }) => {
		runtime.logger?.debug?.(
			{
				src: "response-handler-evaluator",
				evaluator: "core.stage1_execution_claim_guard",
			},
			"[stage1] Simple-path reply promised imminent execution with no tool routed — promoting to planning",
		);
		return {
			setContexts: [STAGE1_FALLBACK_CONTEXT_ID],
			requiresTool: true,
			// Replace, never clear: the pre-evaluator reply snapshot backs the
			// early-ack fallback, so a cleared reply would resurrect the promise.
			reply: "On it.",
			debug: [
				"simple-path reply promised imminent tool/background output with requiresTool=false and no candidates; promoted to planning so the promise is honored or honestly retracted",
			],
		};
	},
};

/**
 * Always-on core guards appended by `runResponseHandlerEvaluators` after the
 * caller-supplied builtin list and the runtime-registered evaluators.
 */
export const CORE_STAGE1_GUARD_EVALUATORS: readonly ResponseHandlerEvaluator[] =
	[stage1ContextFallbackEvaluator, stage1ExecutionClaimGuardEvaluator];
