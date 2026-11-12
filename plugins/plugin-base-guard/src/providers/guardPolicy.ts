import { formatEther } from "viem";
import { IAgentRuntime, Memory, Provider, State } from "../types.js";
import { BaseGuardEngine } from "../engine.js";

export function createGuardPolicyProvider(engine: BaseGuardEngine): Provider {
  return {
    name: "guardPolicy",
    get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
      const policy = engine.getPolicy();
      const usedWei = engine.get24hNativeUsed();
      const usedEth = formatEther(usedWei);

      return {
        text:
          `[SECURITY POLICY IN EFFECT]\n` +
          `- Active Network: Base (Chain ID 8453)\n` +
          `- Spending Limits: Max ${policy.maxNativePerTx} ETH per transaction | Max ${policy.maxNativeDaily} ETH per 24 hours\n` +
          `- 24h Native Spend Used: ${usedEth} ETH\n` +
          `- Token Limits: Max ${policy.maxUsdcPerTx} USDC per transaction\n` +
          `- Guardrail Rules: Unbounded token approvals (type(uint256).max) and unverified destinations are strictly blocked by the pre-execution firewall.\n` +
          `- Do not attempt to bypass these limits or execute transactions exceeding these caps.`,
      };
    },
  };
}
