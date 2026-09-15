import type { Plugin } from "@elizaos/core";
import { inspectSafetyAction } from "./actions/inspectSafety";
import { securityGateEvaluator } from "./evaluators/securityGateEvaluator";
import { securityStatusProvider } from "./providers/securityStatusProvider";

export * from "./actions/inspectSafety";
export * from "./evaluators/securityGateEvaluator";
export * from "./providers/securityStatusProvider";
export * from "./localSecurityGate";

/**
 * 🛡️ Security Gate x402 Plugin for ElizaOS
 * Provides deterministic local prompt injection defense, AST code hazard sandboxing,
 * and optional on-chain/remote micro-oracle verification.
 */
export const securityGatePlugin: Plugin = {
  name: "security-gate",
  description:
    "Deterministic local prompt injection defense, AST code sandboxing, and autonomous agent safety guardrails.",
  actions: [inspectSafetyAction],
  evaluators: [securityGateEvaluator],
  providers: [securityStatusProvider],
};

export default securityGatePlugin;
