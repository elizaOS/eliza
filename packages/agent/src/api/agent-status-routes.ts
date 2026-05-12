/**
 * Agent self-status and ERC-8004 registry inline routes.
 *
 * Extracted from server.ts to reduce file size.
 */

import type http from "node:http";
import type { ReadJsonBodyOptions } from "@elizaos/core";
import {
  PostRegistryRegisterRequestSchema,
  PostRegistrySyncRequestSchema,
  PostRegistryUpdateUriRequestSchema,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegistryServiceStatic {
  defaultCapabilitiesHash: () => string;
}

interface ElizaMakerRegistryService {
  getStatus(): Promise<Record<string, unknown>>;
  register(options: {
    name: string;
    endpoint: string;
    capabilitiesHash: string;
    tokenURI: string;
  }): Promise<Record<string, unknown>>;
  updateTokenURI(tokenURI: string): Promise<string>;
  syncProfile(options: {
    name: string;
    endpoint: string;
    capabilitiesHash: string;
    tokenURI: string;
  }): Promise<string>;
  getChainId(): Promise<number>;
}

const ELIZAMAKER_REGISTRY_MODULE: string = "@elizaos/app-elizamaker";

async function getElizaMakerRegistryServiceIfAvailable(): Promise<ElizaMakerRegistryService | null> {
  try {
    const loaded = (await import(
      /* @vite-ignore */ ELIZAMAKER_REGISTRY_MODULE
    )) as {
      getElizaMakerRegistryService?: () => ElizaMakerRegistryService | null;
    };
    return loaded.getElizaMakerRegistryService?.() ?? null;
  } catch {
    return null;
  }
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
    const COMPUTER_PLUGIN_PACKAGE_IDS = new Set([
      "@elizaos/plugin-computeruse",
      "@elizaos/plugin-computer-use",
    ]);
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

  // ═══════════════════════════════════════════════════════════════════════
  //  ERC-8004 Registry Routes
  // ═══════════════════════════════════════════════════════════════════════

  if (!pathname.startsWith("/api/registry")) return false;

  const registryService = await getElizaMakerRegistryServiceIfAvailable();

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
    const rawReg = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawReg === null) return true;
    const parsedReg = PostRegistryRegisterRequestSchema.safeParse(rawReg);
    if (!parsedReg.success) {
      error(
        res,
        parsedReg.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedReg.data;

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
    const rawUri = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawUri === null) return true;
    const parsedUri = PostRegistryUpdateUriRequestSchema.safeParse(rawUri);
    if (!parsedUri.success) {
      error(
        res,
        parsedUri.error.issues[0]?.message ?? "tokenURI is required",
        400,
      );
      return true;
    }
    const txHash = await registryService.updateTokenURI(
      parsedUri.data.tokenURI,
    );
    json(res, { ok: true, txHash });
    return true;
  }

  if (method === "POST" && pathname === "/api/registry/sync") {
    if (!registryService) {
      error(res, "Registry service not configured.", 503);
      return true;
    }
    const rawSync = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawSync === null) return true;
    const parsedSync = PostRegistrySyncRequestSchema.safeParse(rawSync);
    if (!parsedSync.success) {
      error(
        res,
        parsedSync.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedSync.data;

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
