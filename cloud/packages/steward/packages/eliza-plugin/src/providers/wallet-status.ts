import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { PolicyRule } from "@stwd/sdk";
import type { StewardService } from "../services/StewardService.js";

/**
 * Summarize a policy rule into a human-readable one-liner.
 */
function summarizePolicy(policy: PolicyRule): string {
  const cfg = policy.config as Record<string, any>;
  switch (policy.type) {
    case "spending-limit":
      return `Max ${cfg.maxPerTx ?? "?"}/tx, ${cfg.maxPerDay ?? "?"}/day`;
    case "approved-addresses":
      return `${cfg.mode ?? "whitelist"}: ${(cfg.addresses as string[])?.length ?? 0} addresses`;
    case "auto-approve-threshold":
      return `Auto-approve below ${cfg.threshold ?? "?"}`;
    case "rate-limit":
      return `${cfg.maxTxPerHour ?? "?"}/hr, ${cfg.maxTxPerDay ?? "?"}/day`;
    case "time-window":
      return `Restricted hours/days`;
    default:
      return JSON.stringify(cfg);
  }
}

/**
 * stewardWalletStatus — injected into agent context so the LLM knows
 * its wallet address, agent ID, and active policy summary.
 */
export const walletStatusProvider: Provider = {
  name: "stewardWalletStatus",
  description: "Current Steward wallet address, chain, and policy summary",

  async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> {
    const steward = runtime.getService("steward" as any) as StewardService | null;

    if (!steward?.isConnected()) {
      return { text: "", data: {} };
    }

    try {
      const agent = await steward.getAgent();
      let policies: PolicyRule[] = [];
      try {
        policies = await steward.getPolicies();
      } catch {
        // Policies may not be set yet — non-fatal
      }

      const policyText = policies
        .filter((p) => p.enabled)
        .map((p) => `- ${p.type}: ${summarizePolicy(p)}`)
        .join("\n");

      return {
        text: [
          `Steward Wallet: ${agent.walletAddress}`,
          `Agent ID: ${agent.id}`,
          `Active policies:`,
          policyText || "  (none)",
        ].join("\n"),
        values: {
          walletAddress: agent.walletAddress,
          agentId: agent.id,
        },
        data: {
          agent: agent as any,
          policies: policies as any,
        },
      };
    } catch {
      return { text: "", data: {} };
    }
  },
};
