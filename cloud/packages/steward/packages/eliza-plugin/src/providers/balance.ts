import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { StewardService } from "../services/StewardService.js";

/**
 * stewardBalance — returns on-chain native balance of the Steward-managed wallet.
 *
 * Multi-chain aware: if the agent is configured on multiple chains, the
 * provider returns the balance for the default chain. Specific chain
 * queries can be done via the service directly.
 */
export const balanceProvider: Provider = {
  name: "stewardBalance",
  description: "On-chain balance of the Steward-managed wallet",

  async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> {
    const steward = runtime.getService("steward" as any) as StewardService | null;

    if (!steward?.isConnected()) {
      return { text: "", data: {} };
    }

    try {
      const balance = await steward.getBalance();
      const b = balance.balances;

      return {
        text: `Balance: ${b.nativeFormatted} ${b.symbol} (chain ${b.chainId})`,
        values: {
          balance: b.nativeFormatted,
          balanceRaw: b.native,
          symbol: b.symbol,
          chainId: b.chainId,
          walletAddress: balance.walletAddress,
        },
        data: {
          balance: balance as any,
        },
      };
    } catch {
      return {
        text: "Balance unavailable",
        data: {},
      };
    }
  },
};
