import { securityGateEvaluator } from "./evaluators/securityGateEvaluator.js";
import { inspectSafetyAction } from "./actions/inspectSafety.js";
import { securityStatusProvider } from "./providers/securityStatusProvider.js";

export * from "./evaluators/securityGateEvaluator.js";
export * from "./actions/inspectSafety.js";
export * from "./providers/securityStatusProvider.js";

/**
 * 🛡️ Security Gate x402 Plugin for ElizaOS
 */
export const securityGatePlugin = {
  name: "security-gate",
  description:
    "Deterministic security inspection, prompt injection defense, AST code sandboxing, and zero-liability provenance for ElizaOS agents.",
  actions: [inspectSafetyAction],
  evaluators: [securityGateEvaluator],
  providers: [securityStatusProvider],
};

export default securityGatePlugin;
