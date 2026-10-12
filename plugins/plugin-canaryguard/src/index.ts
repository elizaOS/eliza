import { type Plugin } from "@elizaos/core";
import { sanitizeAction } from "./actions/sanitize";
import { canaryGuardProvider } from "./providers/status";

export * from "./types";
export * from "./engine/rules";
export * from "./engine/state";
export * from "./actions/sanitize";
export * from "./providers/status";

export const canaryGuardPlugin: Plugin = {
  name: "canaryguard",
  description: "Deterministic heuristic detector for prompt injection, concealed Unicode, and wallet drain commands",
  actions: [sanitizeAction],
  providers: [canaryGuardProvider],
};

export default canaryGuardPlugin;
