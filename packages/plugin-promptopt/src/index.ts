/**
 * `@elizaos/plugin-promptopt` — default disk hooks + neuro integration.
 *
 * **Why wrap neuro here:** RUN_ENDED finalization, score signals, and DPE trace
 * enrichment were always deployed together with on-disk optimization in this
 * repo; splitting only *core* DPE I/O behind hooks keeps one installable unit
 * for operators while allowing tests to inject mocks at `registerPromptOptimizationHooks`.
 *
 * **Why init runs hooks before neuro `init`:** Hooks must exist before any message
 * loop DPE call; neuro may register evaluators that assume traces can be written.
 * Order is conservative; if that ever conflicts, document the required plugin order.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { createDiskBackedPromptOptimizationHooks } from "./disk-hooks.ts";
import neuroPluginInner, {
	enrichContinuationSignals,
	handleReaction,
	handleRunEnded,
	neuroEvaluator,
	trackAgentResponse,
} from "./neuro/index.ts";

export * from "./optimization/index.ts";

/**
 * Per-runtime hooks instances to avoid cross-runtime interference.
 * Each runtime gets its own hooks object so dispose() on one runtime
 * doesn't affect hooks registered by other runtimes in the same process.
 */
const perRuntimeHooks = new WeakMap<IAgentRuntime, ReturnType<typeof createDiskBackedPromptOptimizationHooks>>();

function getOrCreateHooksForRuntime(runtime: IAgentRuntime): ReturnType<typeof createDiskBackedPromptOptimizationHooks> {
	let hooks = perRuntimeHooks.get(runtime);
	if (!hooks) {
		hooks = createDiskBackedPromptOptimizationHooks();
		perRuntimeHooks.set(runtime, hooks);
	}
	return hooks;
}

function isPromptOptimizationSettingOn(runtime: IAgentRuntime): boolean {
	const setting = runtime.getSetting("PROMPT_OPTIMIZATION_ENABLED");
	if (typeof setting === "boolean") return setting;
	if (typeof setting === "string") {
		const t = setting.trim().toLowerCase();
		return t === "true" || setting.trim() === "1";
	}
	return false;
}

const promptOptPlugin: Plugin = {
	...neuroPluginInner,
	name: "@elizaos/plugin-promptopt",
	description:
		"Prompt optimization disk I/O (DPE hooks), quality signals, and RUN_ENDED trace finalization. " +
		"Registers default hooks when PROMPT_OPTIMIZATION_ENABLED is truthy.",
	init: async (config, runtime) => {
		if (
			isPromptOptimizationSettingOn(runtime) &&
			!runtime.getPromptOptimizationHooks()
		) {
			const hooks = getOrCreateHooksForRuntime(runtime);
			runtime.registerPromptOptimizationHooks(hooks);
		}
		if (neuroPluginInner.init) {
			await neuroPluginInner.init(config, runtime);
		}
	},
	dispose: async (runtime) => {
		const hooks = perRuntimeHooks.get(runtime);
		if (hooks && runtime.getPromptOptimizationHooks() === hooks) {
			runtime.registerPromptOptimizationHooks(null);
			perRuntimeHooks.delete(runtime);
		}
		await neuroPluginInner.dispose?.(runtime);
	},
};

export default promptOptPlugin;
export { promptOptPlugin };
export {
	enrichContinuationSignals,
	handleReaction,
	handleRunEnded,
	neuroEvaluator,
	trackAgentResponse,
} from "./neuro/index.ts";
export { neuroPluginInner as neuroPlugin };
export { createDiskBackedPromptOptimizationHooks } from "./disk-hooks.ts";
