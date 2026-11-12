import { DEFAULT_GUARD_POLICY } from "./constants.js";
import { BaseGuardEngine } from "./engine.js";
import { GuardPolicy, Plugin, SecurityVerdict } from "./types.js";
import { createValidateTransactionAction } from "./actions/validateTransaction.js";
import { createVerifyX402Action } from "./actions/verifyX402.js";
import { createGetPolicyAction } from "./actions/getPolicy.js";
import { createPromptSafetyEvaluator } from "./evaluators/promptSafety.js";
import { createGuardPolicyProvider } from "./providers/guardPolicy.js";

export * from "./types.js";
export * from "./constants.js";
export * from "./engine.js";

/**
 * Wraps any EVM wallet provider (viem WalletClient, ethers Signer, or Eliza wallet provider)
 * to intercept and inspect transactions before they are signed or broadcast.
 */
export function createGuardedWallet<T extends Record<string, any>>(
  wallet: T,
  engine: BaseGuardEngine,
  options?: { onBlock?: (verdict: SecurityVerdict) => void }
): T {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      const original = (target as any)[prop];
      if (typeof original !== "function") return Reflect.get(target, prop, receiver);

      if (prop === "sendTransaction" || prop === "send" || prop === "execute") {
        return async (...args: any[]) => {
          const txParam = args[0] || {};
          const to = txParam.to || "";
          const value = txParam.value ? txParam.value.toString() : "0";
          const data = txParam.data || "0x";

          const verdict = engine.evaluateTransaction({ to, value, data });
          if (!verdict.allowed) {
            if (options?.onBlock) options.onBlock(verdict);
            throw new Error(`[BaseGuard FIREWALL BLOCKED]: ${verdict.code} - ${verdict.reason}`);
          }

          return original.apply(target, args);
        };
      }

      if (prop === "request") {
        return async (args: { method: string; params?: any[] }) => {
          if (args?.method === "eth_sendTransaction" && args.params?.[0]) {
            const txParam = args.params[0];
            const to = txParam.to || "";
            const value = txParam.value ? txParam.value.toString() : "0";
            const data = txParam.data || "0x";

            const verdict = engine.evaluateTransaction({ to, value, data });
            if (!verdict.allowed) {
              if (options?.onBlock) options.onBlock(verdict);
              throw new Error(`[BaseGuard FIREWALL BLOCKED]: ${verdict.code} - ${verdict.reason}`);
            }
          }
          return original.apply(target, [args]);
        };
      }

      return original.bind(target);
    },
  });
}

export interface BaseGuardPluginInstance extends Plugin {
  engine: BaseGuardEngine;
  guardWallet: <T extends Record<string, any>>(wallet: T) => T;
}

/**
 * Creates an ElizaOS BaseGuard plugin instance with customizable policies.
 */
export function createBaseGuardPlugin(customPolicy?: Partial<GuardPolicy>): BaseGuardPluginInstance {
  const policy: GuardPolicy = {
    ...DEFAULT_GUARD_POLICY,
    ...customPolicy,
  };

  const engine = new BaseGuardEngine(policy);

  return {
    name: "base-guard",
    description: "Fail-closed onchain security firewall, spend ceilings, prompt injection defense, and x402 verification for ElizaOS agents on Base",
    engine,
    guardWallet: <T extends Record<string, any>>(wallet: T) => createGuardedWallet(wallet, engine),
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

export const baseGuardPlugin: BaseGuardPluginInstance = createBaseGuardPlugin();
export default baseGuardPlugin;

