/**
 * plugin-neuro
 *
 * Captures user-facing quality signals for prompt optimization.
 *
 * Signal sources:
 * - Emoji reactions (REACTION_RECEIVED) -> positive/negative sentiment (optional; many hosts have no reaction UI)
 * - Conversation continuation (neuroEvaluator) -> engagement signal (text-only harnesses still get this)
 * - User corrections (neuroEvaluator) -> quality failure signal
 * - Response length & latency (neuroEvaluator) -> efficiency signals
 *
 * All signals are delivered via runtime.enrichTrace() and ultimately
 * persisted with the ExecutionTrace in history.jsonl.
 *
 * To enable: add plugin-neuro to your character's plugins array, or enable
 * PROMPT_OPTIMIZATION_ENABLED in the dev harness (it injects this plugin).
 * Signal weights can be customized via character.settings.PROMPT_OPT_SIGNAL_WEIGHTS.
 */

import {
	EventType,
	type MessagePayload,
	type Plugin,
	type RunEventPayload,
} from "@elizaos/core";
import { neuroEvaluator } from "./evaluator.ts";
import { clearContinuationTracking } from "./handlers/continuation.ts";
import { handleRunEnded } from "./handlers/finalizer.ts";
import { clearContinuationTracking } from "./handlers/continuation.ts";
import { handleReaction } from "./handlers/reaction.ts";

export const neuroPlugin: Plugin = {
	name: "plugin-neuro",
	description: "Neuro signal evaluation plugin for prompt optimization",
	dispose: async () => {
		// Clear pending timeouts to allow graceful Node.js shutdown
		clearContinuationTracking();
	},
		"Captures user-facing quality signals for prompt optimization scoring. " +
		"Feeds reaction, continuation, correction, latency, and length signals " +
		"into ExecutionTrace score cards.",
	evaluators: [neuroEvaluator],
	actions: [],
	providers: [],
	routes: [],
	services: [],
	events: {
		[EventType.REACTION_RECEIVED]: [
			async (payload) => {
				const p = payload as MessagePayload;
				await handleReaction(p, p.runtime);
			},
		],
		[EventType.RUN_ENDED]: [
			async (payload) => {
				const p = payload as RunEventPayload;
				await handleRunEnded(p, p.runtime);
			},
		],
	},
};

export default neuroPlugin;
import type { IAgentRuntime } from "@elizaos/core";
import {
	clearContinuationTracking,
	enrichContinuationSignals,
	trackAgentResponse,
} from "./handlers/continuation.ts";
export { handleRunEnded } from "./handlers/finalizer.ts";
export { handleReaction } from "./handlers/reaction.ts";
export * from "./signals.ts";
export { neuroPlugin };
