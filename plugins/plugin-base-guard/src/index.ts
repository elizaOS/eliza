import { DEFAULT_GUARD_POLICY } from "./constants.js";
import { BaseGuardEngine } from "./engine.js";
import { GuardPolicy, Plugin } from "./types.js";
import { createValidateTransactionAction } from "./actions/validateTransaction.js";
import { createVerifyX402Action } from "./actions/verifyX402.js";
import { createGetPolicyAction } from "./actions/getPolicy.js";
import { createPromptSafetyEvaluator } from "./evaluators/promptSafety.js";
import { createGuardPolicyProvider } from "./providers/guardPolicy.js";

export * from "./types.js";
export * from "./constants.js";
export * from "./engine.js";

/**
 * Creates an ElizaOS BaseGuard plugin instance with customizable policies.
 */
export function createBaseGuardPlugin(customPolicy?: Partial<GuardPolicy>): Plugin {
  const policy: GuardPolicy = {
    ...DEFAULT_GUARD_POLICY,
    ...customPolicy,
  };

  const engine = new BaseGuardEngine(policy);

  return {
    name: "base-guard",
    description: "Fail-closed onchain security firewall, spend ceilings, prompt injection defense, and x402 verification for ElizaOS agents on Base",
    actions: [
      createValidateTransactionAction(engine),
      createVerifyX402Action(engine),
      createGetPolicyAction(engine),
    ],
    evaluators: [
      createPromptSafetyEvaluator(engine),
    ],
    providers: [
      createGuardPolicyProvider(engine),
    ],
  };
}

export const baseGuardPlugin: Plugin = createBaseGuardPlugin();
export default baseGuardPlugin;
