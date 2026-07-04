/**
 * Plugin factory for elizaOS's always-on message-path security defenses. Its
 * `init` wires two pipeline hooks — incoming-message external-content hardening
 * and should-respond injection-risk stamping — through the plugin lifecycle so
 * `registerPlugin` owns their registration and disposal.
 */
import { registerCoreShouldRespondRiskHook } from "../features/trust/should-respond-risk-gate";
import { registerCoreIncomingMessageSecurityHook } from "../security/incoming-message-security";
import type { Plugin } from "../types/plugin";

export const CORE_SECURITY_HOOKS_PLUGIN_NAME = "core-security-hooks";

/**
 * Core message-path security defenses, registered through the plugin lifecycle
 * so `registerPlugin` owns their bookkeeping and disposal instead of a bespoke
 * lazy import inside `AgentRuntime.initialize`. The two hooks are always-on:
 *
 *  - `core:incoming-message-security` (GHSA-gh63-5vpj-39qp) — external-content
 *    wrapping + sensitive-text scrubbing on the incoming user message.
 *  - `core:should-respond-injection-risk` (#9949) — deterministic RiskFactors
 *    stamping during the parallel-with-should-respond phase.
 *
 * Both `registerCore*Hook` functions call `runtime.registerPipelineHook` from
 * within the plugin `init`.
 */
export function createCoreSecurityHooksPlugin(): Plugin {
	return {
		name: CORE_SECURITY_HOOKS_PLUGIN_NAME,
		description:
			"Always-on core message-path security defenses (external-content hardening + injection-risk stamping).",
		init: (_config, runtime) => {
			registerCoreIncomingMessageSecurityHook(runtime);
			registerCoreShouldRespondRiskHook(runtime);
		},
	};
}
