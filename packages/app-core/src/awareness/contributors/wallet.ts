/**
 * Wallet contributor — reports real wallet addresses, chain readiness,
 * signer mode, and trade permissions. Never exposes private keys.
 */

import { getWalletAddresses } from "@elizaos/agent/api/wallet";
import { resolveWalletRpcReadiness } from "@elizaos/agent/api/wallet-rpc";
import { loadElizaConfig } from "@elizaos/agent/config/config";
import type { AwarenessContributor } from "@elizaos/agent/contracts";
import {
  canUseLocalTradeExecution,
  resolveTradePermissionMode,
} from "@elizaos/app-steward/routes/server-wallet-trade";
import type { IAgentRuntime } from "@elizaos/core";

function shorten(address: string | null): string | null {
  if (!address) return null;
  if (address.startsWith("0x") && address.length >= 12) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export const walletContributor: AwarenessContributor = {
  id: "wallet",
  position: 30,
  cacheTtl: 60_000,
  invalidateOn: ["wallet-updated", "config-changed"],
  trusted: true,

  async summary(_runtime: IAgentRuntime): Promise<string> {
    const addrs = getWalletAddresses();
    const hasEvm = Boolean(addrs.evmAddress);
    const hasSol = Boolean(addrs.solanaAddress);

    if (!hasEvm && !hasSol) {
      return "Wallet: not configured";
    }

    const config = loadElizaConfig();
    const tradeMode = resolveTradePermissionMode(config);
    const localSigner = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
    const stewardConfigured = Boolean(process.env.STEWARD_API_URL?.trim());
    const bscRpc = resolveWalletRpcReadiness(config).managedBscRpcReady;

    const parts: string[] = [];
    if (hasEvm) parts.push(`EVM ${shorten(addrs.evmAddress)}`);
    if (hasSol) parts.push(`SOL ${shorten(addrs.solanaAddress)}`);
    if (bscRpc) parts.push("BSC-RPC ready");
    if (localSigner) parts.push("signer");
    else if (stewardConfigured) parts.push("steward-signer");
    parts.push(tradeMode);

    return `Wallet: ${parts.join(" | ")}`;
  },

  async detail(
    _runtime: IAgentRuntime,
    level: "brief" | "full",
  ): Promise<string> {
    const addrs = getWalletAddresses();
    const config = loadElizaConfig();
    const tradeMode = resolveTradePermissionMode(config);
    const localSigner = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
    const stewardConfigured = Boolean(process.env.STEWARD_API_URL?.trim());
    const stewardAgentId =
      process.env.STEWARD_AGENT_ID ?? process.env.ELIZA_STEWARD_AGENT_ID ?? "";
    const bscRpc = resolveWalletRpcReadiness(config).managedBscRpcReady;
    const canUserTrade = canUseLocalTradeExecution(tradeMode, false);
    const canAgentTrade = canUseLocalTradeExecution(tradeMode, true);

    const lines: string[] = ["## Wallet"];
    lines.push(`EVM address: ${addrs.evmAddress ?? "none"}`);
    lines.push(`Solana address: ${addrs.solanaAddress ?? "none"}`);
    lines.push(`Local signer: ${localSigner ? "available" : "not set"}`);
    lines.push(
      `Steward vault: ${stewardConfigured ? `configured${stewardAgentId ? ` (agent: ${stewardAgentId.slice(0, 8)}...)` : ""}` : "not configured"}`,
    );
    lines.push(`Trade permission mode: ${tradeMode}`);
    lines.push(`Can user execute trades: ${canUserTrade}`);
    lines.push(`Can agent auto-trade: ${canAgentTrade}`);

    if (level === "full") {
      lines.push(`BSC RPC configured: ${bscRpc}`);
      lines.push(
        `Alchemy key: ${Boolean(process.env.ALCHEMY_API_KEY?.trim())}`,
      );
      lines.push(`Ankr key: ${Boolean(process.env.ANKR_API_KEY?.trim())}`);
      lines.push(`Helius key: ${Boolean(process.env.HELIUS_API_KEY?.trim())}`);
    }

    return lines.join("\n");
  },
};
