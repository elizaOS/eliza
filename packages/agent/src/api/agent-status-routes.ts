/**
 * Agent self-status inline route.
 */

import type http from "node:http";
import type { TradePermissionMode } from "@elizaos/contracts";
import type { AgentRuntime } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import type { LocalTradeExecutionOptions } from "@elizaos/plugin-wallet/transactions";
import type { WalletCapabilityStatus } from "./wallet-capability.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AwarenessRegistryLike {
  composeSummary: (runtime: unknown) => Promise<string>;
}

export interface AgentStatusRouteDeps {
  getWalletAddresses: () => {
    evmAddress: string | null;
    solanaAddress: string | null;
  };
  resolveWalletCapabilityStatus: (state: {
    config: ElizaConfig;
    runtime: AgentRuntime | null;
  }) => WalletCapabilityStatus;
  resolveWalletRpcReadiness: (config: ElizaConfig) => {
    managedBscRpcReady: boolean;
  };
  resolveTradePermissionMode: (config: ElizaConfig) => TradePermissionMode;
  canUseLocalTradeExecution: (
    mode: TradePermissionMode,
    isAgentRequest: boolean,
    log?: (message: string) => void,
    opts?: LocalTradeExecutionOptions,
  ) => boolean;
  detectRuntimeModel: (
    runtime: AgentRuntime | null,
    config: ElizaConfig,
  ) => string | undefined;
  resolveProviderFromModel: (model: string) => string | null;
  getAwarenessRegistry: () => AwarenessRegistryLike | null;
}

export interface AgentStatusRouteState {
  config: ElizaConfig;
  runtime: AgentRuntime | null;
  agentState: string;
  agentName: string;
  model?: string;
  startedAt?: number;
  shellEnabled?: boolean;
}

export interface AgentStatusRouteContext {
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: AgentStatusRouteState;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  deps: AgentStatusRouteDeps;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleAgentStatusRoutes(
  ctx: AgentStatusRouteContext,
): Promise<boolean> {
  const { res, method, pathname, state, json, deps } = ctx;

  // ═══════════════════════════════════════════════════════════════════════
  // Agent self-status route
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/agent/self-status") {
    const addrs = deps.getWalletAddresses();
    const capability = deps.resolveWalletCapabilityStatus(state);
    const evmAddress = capability.evmAddress;
    const tradePermissionMode = deps.resolveTradePermissionMode(state.config);
    const walletRpcReadiness = deps.resolveWalletRpcReadiness(state.config);
    const bscRpcReady = walletRpcReadiness.managedBscRpcReady;
    const canLocalTrade = deps.canUseLocalTradeExecution(
      tradePermissionMode,
      false,
    );
    const canAgentAutoTrade = deps.canUseLocalTradeExecution(
      tradePermissionMode,
      true,
      undefined,
      { consumeAgentQuota: false },
    );
    const canTrade = Boolean(evmAddress) && bscRpcReady;
    const automationMode = capability.automationMode;

    let registrySummary: string | null = null;
    const registry = deps.getAwarenessRegistry();
    if (registry && state.runtime) {
      try {
        registrySummary = await registry.composeSummary(state.runtime);
      } catch {
        // Non-fatal
      }
    }

    const resolvedModel =
      state.model ??
      deps.detectRuntimeModel(state.runtime ?? null, state.config) ??
      null;

    const resolvedProvider = resolvedModel
      ? deps.resolveProviderFromModel(resolvedModel)
      : null;

    const pluginNames: string[] = [];
    const aiProviderNames: string[] = [];
    const connectorNames: string[] = [];
    const BROWSER_PLUGIN_IDS = new Set([
      "browser",
      "browserbase",
      "chrome-extension",
    ]);
    const COMPUTER_PLUGIN_IDS = new Set(["computeruse", "computer-use"]);
    const COMPUTER_PLUGIN_PACKAGE_IDS = new Set([
      "@elizaos/plugin-computeruse",
      "@elizaos/plugin-computer-use",
    ]);
    let hasBrowserPlugin = false;
    let hasComputerPlugin = false;

    if (state.runtime && Array.isArray(state.runtime.plugins)) {
      for (const plugin of state.runtime.plugins) {
        const name = typeof plugin.name === "string" ? plugin.name.trim() : "";
        if (!name) continue;
        pluginNames.push(name);
        const lower = name.toLowerCase();
        if (
          lower.includes("openai") ||
          lower.includes("anthropic") ||
          lower.includes("groq") ||
          lower.includes("gemini") ||
          lower.includes("openrouter") ||
          lower.includes("deepseek") ||
          lower.includes("ollama")
        ) {
          aiProviderNames.push(name);
        }
        if (
          lower.includes("discord") ||
          lower.includes("telegram") ||
          lower.includes("twitter") ||
          lower.includes("slack")
        ) {
          connectorNames.push(name);
        }
        if (BROWSER_PLUGIN_IDS.has(lower)) hasBrowserPlugin = true;
        if (
          COMPUTER_PLUGIN_IDS.has(lower) ||
          COMPUTER_PLUGIN_PACKAGE_IDS.has(lower)
        ) {
          hasComputerPlugin = true;
        }
      }
    }

    json(res, {
      generatedAt: new Date().toISOString(),
      state: state.agentState,
      agentName: state.agentName,
      model: resolvedModel,
      provider: resolvedProvider,
      automationMode,
      tradePermissionMode,
      shellEnabled: state.shellEnabled !== false,
      wallet: {
        walletSource: capability.walletSource,
        hasWallet: capability.hasWallet,
        hasEvm: capability.hasEvm,
        hasSolana: Boolean(addrs.solanaAddress),
        evmAddress,
        evmAddressShort:
          evmAddress && evmAddress.length >= 12
            ? `${evmAddress.slice(0, 6)}...${evmAddress.slice(-4)}`
            : evmAddress,
        solanaAddress: addrs.solanaAddress ?? null,
        solanaAddressShort:
          addrs.solanaAddress && addrs.solanaAddress.length >= 12
            ? `${addrs.solanaAddress.slice(0, 4)}...${addrs.solanaAddress.slice(-4)}`
            : (addrs.solanaAddress ?? null),
        localSignerAvailable: capability.localSignerAvailable,
        managedBscRpcReady: bscRpcReady,
        rpcReady: capability.rpcReady,
        pluginEvmLoaded: capability.pluginEvmLoaded,
        pluginEvmRequired: capability.pluginEvmRequired,
        executionReady: capability.executionReady,
        executionBlockedReason: capability.executionBlockedReason,
      },
      plugins: {
        totalActive: pluginNames.length,
        active: pluginNames,
        aiProviders: aiProviderNames,
        connectors: connectorNames,
      },
      capabilities: {
        canTrade,
        canLocalTrade:
          canTrade && capability.localSignerAvailable && canLocalTrade,
        canAutoTrade:
          canTrade && capability.localSignerAvailable && canAgentAutoTrade,
        canUseBrowser: hasBrowserPlugin,
        canUseComputer: hasComputerPlugin,
        canRunTerminal: state.shellEnabled !== false,
        canInstallPlugins: true,
        canConfigurePlugins: true,
        canConfigureConnectors: true,
      },
      ...(registrySummary !== null ? { registrySummary } : {}),
    });
    return true;
  }

  return false;
}
