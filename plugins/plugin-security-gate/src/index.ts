import type { Plugin } from "@elizaos/core";
import { inspectSafetyAction } from "./actions/inspectSafety.js";
import { securityGateEvaluator } from "./evaluators/securityGateEvaluator.js";
import { securityGatePreHandler } from "./preHandlers/securityGatePreHandler.js";
import { securityStatusProvider } from "./providers/securityStatusProvider.js";

export * from "./actions/inspectSafety.js";
export * from "./evaluators/securityGateEvaluator.js";
export * from "./localSecurityGate.js";
export * from "./preHandlers/securityGatePreHandler.js";
export * from "./providers/securityStatusProvider.js";

/**
 * 🛡️ Security Gate x402 Plugin for ElizaOS
 * Provides deterministic inbound prompt injection defense, dangerous code pattern detection,
 * and autonomous agent safety guardrails.
 */
export const securityGatePlugin: Plugin = {
  name: "security-gate",
  description:
    "Deterministic local prompt injection defense, dangerous code pattern detection, and autonomous agent safety guardrails.",
  actions: [inspectSafetyAction],
  evaluators: [securityGateEvaluator],
  providers: [securityStatusProvider],
  chatPreHandlers: [securityGatePreHandler],
};

export default securityGatePlugin;
