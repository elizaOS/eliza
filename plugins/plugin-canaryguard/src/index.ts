import { type Plugin } from "@elizaos/core";
import { sanitizeAction } from "./actions/sanitize";
import { promptInjectionEvaluator } from "./evaluators/injection";
import { canaryGuardProvider } from "./providers/status";

export * from "./types";
export * from "./actions/sanitize";
export * from "./evaluators/injection";
export * from "./providers/status";

export const canaryGuardPlugin: Plugin = {
  name: "canaryguard",
  description: "Deterministic prompt-injection firewall & honeypot scrubber for ElizaOS agents on Base mainnet via x402",
  actions: [sanitizeAction],
  evaluators: [promptInjectionEvaluator],
  providers: [canaryGuardProvider],
};

export default canaryGuardPlugin;
