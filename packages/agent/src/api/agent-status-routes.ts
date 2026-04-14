/**
 * Agent self-status, Privy wallet provisioning, and ERC-8004 registry
 * inline routes.
 *
 * Extracted from server.ts to reduce file size.
 */

import type http from "node:http";
import { logger } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.js";
import type { ReadJsonBodyOptions } from "./http-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegistryServiceLike {
  getStatus: () => Promise<Record<string, unknown>>;
  register: (args: {
    name: string;
    endpoint: string;
    capabilitiesHash: string;
    tokenURI: string;
  }) => Promise<unknown>;
  updateTokenURI: (tokenURI: string) => Promise<string>;
  syncProfile: (args: {
    name: string;
    endpoint: string;
    capabilitiesHash: string;
    tokenURI: string;
  }) => Promise<string>;
  getChainId: () => Promise<number>;
}

interface RegistryServiceStatic {
  defaultCapabilitiesHash: () => string;
}

interface AwarenessRegistryLike {
  composeSummary: (runtime: unknown) => Promise<string>;
}

export interface AgentStatusRouteDeps {
  getWalletAddresses: () => {
    evmAddress: string | null;
    solanaAddress: string | null;
  };
  resolveWalletCapabilityStatus: (state: unknown) => {
    walletSource: string;
    hasWallet: boolean;
    hasEvm: boolean;
    evmAddress: string | null;
    localSignerAvailable: boolean;
    rpcReady: boolean;
    pluginEvmLoaded: boolean;
    pluginEvmRequired: boolean;
    executionReady: boolean;
    executionBlockedReason: string | null;
    automationMode: string;
  };
  resolveWalletRpcReadiness: (config: ElizaConfig) => {
    managedBscRpcReady: boolean;
  };
  resolveTradePermissionMode: (config: ElizaConfig) => string;
  canUseLocalTradeExecution: (
    mode: string,
    isAgentRequest: boolean,
    unused?: undefined,
    opts?: { consumeAgentQuota: boolean },
  ) => boolean;
  detectRuntimeModel: (
    runtime: unknown,
    config: ElizaConfig,
  ) => string | undefined;
  resolveProviderFromModel: (model: string) => string | null;
  getGlobalAwarenessRegistry: () => AwarenessRegistryLike | null;
  isPrivyWalletProvisioningEnabled: () => boolean;
  ensurePrivyWalletsForCustomUser: (
    userId: string,
  ) => Promise<Record<string, unknown>>;
  RegistryService: RegistryServiceStatic;
}

export interface AgentStatusRouteState {
  config: ElizaConfig;
  runtime: {
    plugins: Array<{ name: string }>;
    character: { name?: string };
  } | null;
  agentState: string;
  agentName: string;
  model?: string;
  startedAt?: number;
  shellEnabled?: boolean;
  registryService: RegistryServiceLike | null;
}

export interface AgentStatusRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: AgentStatusRouteState;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  deps: AgentStatusRouteDeps;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleAgentStatusRoutes(
  ctx: AgentStatusRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, json, error, readJsonBody, deps } =
    ctx;

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
    const registry = deps.getGlobalAwarenessRegistry();
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
    let hasBrowserPlugin = false;
    let hasComputerPlugin = false;

    if (state.runtime && Array.isArray(state.runtime.plugins)) {
      for (const plugin of state.runtime.plugins) {
        const name = typeof plugin?.name === "string" ? plugin.name.trim() : "";
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
        if (COMPUTER_PLUGIN_IDS.has(lower)) hasComputerPlugin = true;
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

  // ═══════════════════════════════════════════════════════════════════════
  // Privy wallet routes
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/privy/status") {
    const enabled = deps.isPrivyWalletProvisioningEnabled();
    json(res, { enabled, configured: enabled });
    return true;
  }

  if (method === "POST" && pathname === "/api/privy/login") {
    if (!deps.isPrivyWalletProvisioningEnabled()) {
      error(res, "Privy wallet provisioning is not configured.", 503);
      return true;
    }
    const body = await readJsonBody<{ userId?: string }>(req, res);
    if (!body) return true;

    const userId = (body.userId ?? "").trim();
    if (!userId) {
      error(res, "userId is required", 400);
      return true;
    }

    try {
      const result = await deps.ensurePrivyWalletsForCustomUser(userId);
      json(res, { ok: true, ...result });
    } catch (err) {
      logger.error(
        `[api] Privy login failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Privy login failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/privy/logout") {
    json(res, { ok: true });
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ERC-8004 Registry Routes
  // ═══════════════════════════════════════════════════════════════════════

  const { registryService } = state;

  if (method === "GET" && pathname === "/api/registry/status") {
    if (!registryService) {
      json(res, {
        registered: false,
        tokenId: 0,
        agentName: "",
        agentEndpoint: "",
        capabilitiesHash: "",
        isActive: false,
        tokenURI: "",
        walletAddress: "",
        totalAgents: 0,
        configured: false,
      });
      return true;
    }
    const status = await registryService.getStatus();
    json(res, { ...status, configured: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/registry/register") {
    if (!registryService) {
      error(
        res,
        "Registry service not configured. Set registry config and EVM_PRIVATE_KEY.",
        503,
      );
      return true;
    }
    const body = await readJsonBody<{
      name?: string;
      endpoint?: string;
      tokenURI?: string;
    }>(req, res);
    if (!body) return true;

    const agentName = body.name || state.agentName || "Eliza";
    const endpoint = body.endpoint || "";
    const tokenURI = body.tokenURI || "";

    const result = await registryService.register({
      name: agentName,
      endpoint,
      capabilitiesHash: deps.RegistryService.defaultCapabilitiesHash(),
      tokenURI,
    });
    json(res, result);
    return true;
  }

  if (method === "POST" && pathname === "/api/registry/update-uri") {
    if (!registryService) {
      error(res, "Registry service not configured.", 503);
      return true;
    }
    const body = await readJsonBody<{ tokenURI?: string }>(req, res);
    if (!body?.tokenURI) {
      error(res, "tokenURI is required");
      return true;
    }
    const txHash = await registryService.updateTokenURI(body.tokenURI);
    json(res, { ok: true, txHash });
    return true;
  }

  if (method === "POST" && pathname === "/api/registry/sync") {
    if (!registryService) {
      error(res, "Registry service not configured.", 503);
      return true;
    }
    const body = await readJsonBody<{
      name?: string;
      endpoint?: string;
      tokenURI?: string;
    }>(req, res);
    if (!body) return true;

    const agentName = body.name || state.agentName || "Eliza";
    const endpoint = body.endpoint || "";
    const tokenURI = body.tokenURI || "";

    const txHash = await registryService.syncProfile({
      name: agentName,
      endpoint,
      capabilitiesHash: deps.RegistryService.defaultCapabilitiesHash(),
      tokenURI,
    });
    json(res, { ok: true, txHash });
    return true;
  }

  if (method === "GET" && pathname === "/api/registry/config") {
    const registryConfig = state.config.registry;
    let chainId = 1;
    if (registryService) {
      try {
        chainId = await registryService.getChainId();
      } catch {
        // Keep default if chain RPC is unavailable.
      }
    }

    const explorerByChainId: Record<number, string> = {
      1: "https://etherscan.io",
      10: "https://optimistic.etherscan.io",
      137: "https://polygonscan.com",
      8453: "https://basescan.org",
      42161: "https://arbiscan.io",
    };

    json(res, {
      configured: Boolean(registryService),
      chainId,
      registryAddress: registryConfig?.registryAddress ?? null,
      collectionAddress: registryConfig?.collectionAddress ?? null,
      explorerUrl: explorerByChainId[chainId] ?? "",
    });
    return true;
  }

  return false;
}
