import type http from "node:http";
import { RouteRequestMeta } from "@elizaos/core";
import { persistConfigEnv } from "@elizaos/agent";
import type { RouteHelpers } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/agent";
import { createIntegrationTelemetrySpan } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  WalletExportRejection as WalletExportRejectionLike,
  WalletExportRequestBody,
} from "@elizaos/core";
import {
  normalizeWalletRpcSelections,
  type WalletConfigUpdateRequest,
  type WalletRpcSelections,
} from "@elizaos/core";
import {
  fetchEvmBalances,
  fetchSolanaBalances,
  fetchSolanaNativeBalanceViaRpc,
  generateWalletForChain,
  getWalletAddresses,
  importWallet,
  setSolanaWalletEnv,
  validatePrivateKey,
  type WalletBalancesResponse,
  type WalletChain,
  type WalletConfigStatus,
} from "./wallet";
import { resolveWalletCapabilityStatus } from "./wallet-capability";
import {
  applyWalletRpcConfigUpdate,
  getStoredWalletRpcSelections,
  resolveWalletNetworkMode,
  resolveWalletRpcReadiness,
} from "./wallet-rpc";

// Rate limiter for wallet export.
// In test/CI mode the limit is relaxed to avoid blocking E2E suites.
const IS_TEST = process.env.NODE_ENV === "test" || !!process.env.VITEST;
const WALLET_EXPORT_MAX_ATTEMPTS = IS_TEST ? 500 : 5;
const WALLET_EXPORT_WINDOW_MS = 15 * 60_000;
const walletExportAttempts = new Map<
  string,
  { count: number; resetAt: number }
>();

function rateLimitWalletExport(req: http.IncomingMessage): boolean {
  const key = req.socket?.remoteAddress ?? "unknown";
  const now = Date.now();
  // Lazy sweep
  if (walletExportAttempts.size > 50) {
    for (const [k, v] of walletExportAttempts) {
      if (now > v.resetAt) walletExportAttempts.delete(k);
    }
  }
  const current = walletExportAttempts.get(key);
  if (!current || now > current.resetAt) {
    walletExportAttempts.set(key, {
      count: 1,
      resetAt: now + WALLET_EXPORT_WINDOW_MS,
    });
    return true;
  }
  if (current.count >= WALLET_EXPORT_MAX_ATTEMPTS) return false;
  current.count += 1;
  return true;
}

const WALLET_CONFIG_COMPAT_KEYS = new Set([
  "ALCHEMY_API_KEY",
  "INFURA_API_KEY",
  "ANKR_API_KEY",
  "ETHEREUM_RPC_URL",
  "BASE_RPC_URL",
  "AVALANCHE_RPC_URL",
  "HELIUS_API_KEY",
  "BIRDEYE_API_KEY",
  "NODEREAL_BSC_RPC_URL",
  "QUICKNODE_BSC_RPC_URL",
  "BSC_RPC_URL",
  "SOLANA_RPC_URL",
]);

type StewardAgentWalletPayload = {
  walletAddress?: string;
  walletAddresses?: { evm?: string; solana?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStewardAgentWalletPayload(
  value: unknown,
): StewardAgentWalletPayload {
  const envelope = isRecord(value) ? value : {};
  const payload = isRecord(envelope.data) ? envelope.data : envelope;
  const walletAddresses = isRecord(payload.walletAddresses)
    ? {
        evm: readStringField(payload.walletAddresses, "evm"),
        solana: readStringField(payload.walletAddresses, "solana"),
      }
    : undefined;
  return {
    walletAddress: readStringField(payload, "walletAddress"),
    walletAddresses,
  };
}

function resolveWalletConfigUpdateRequest(
  body: unknown,
  currentSelections: WalletRpcSelections,
): WalletConfigUpdateRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  if (
    record.selections &&
    typeof record.selections === "object" &&
    !Array.isArray(record.selections)
  ) {
    const walletNetwork =
      record.walletNetwork === "testnet" || record.walletNetwork === "mainnet"
        ? record.walletNetwork
        : undefined;
    const credentials =
      record.credentials &&
      typeof record.credentials === "object" &&
      !Array.isArray(record.credentials)
        ? Object.fromEntries(
            Object.entries(
              record.credentials as Record<string, unknown>,
            ).filter(([, value]) => typeof value === "string"),
          )
        : undefined;

    return {
      selections: normalizeWalletRpcSelections(
        record.selections as Partial<Record<keyof WalletRpcSelections, string>>,
      ),
      walletNetwork,
      credentials: credentials as WalletConfigUpdateRequest["credentials"],
    };
  }

  const compatCredentials = Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) =>
        WALLET_CONFIG_COMPAT_KEYS.has(key) && typeof value === "string",
    ),
  );

  if (Object.keys(compatCredentials).length === 0) {
    return null;
  }

  return {
    selections: currentSelections,
    walletNetwork:
      record.walletNetwork === "testnet" || record.walletNetwork === "mainnet"
        ? record.walletNetwork
        : undefined,
    credentials: compatCredentials as WalletConfigUpdateRequest["credentials"],
  };
}

export interface WalletRouteDependencies {
  getWalletAddresses: typeof getWalletAddresses;
  fetchEvmBalances: typeof fetchEvmBalances;
  fetchSolanaBalances: typeof fetchSolanaBalances;
  fetchSolanaNativeBalanceViaRpc: typeof fetchSolanaNativeBalanceViaRpc;
  validatePrivateKey: typeof validatePrivateKey;
  importWallet: typeof importWallet;
  generateWalletForChain: typeof generateWalletForChain;
}

export const DEFAULT_WALLET_ROUTE_DEPENDENCIES: WalletRouteDependencies = {
  getWalletAddresses,
  fetchEvmBalances,
  fetchSolanaBalances,
  fetchSolanaNativeBalanceViaRpc,
  validatePrivateKey,
  importWallet,
  generateWalletForChain,
};

function persistPrimarySelection(
  config: ElizaConfig,
  chain: WalletChain,
  source: "local" | "cloud",
): void {
  if (!config.wallet) {
    config.wallet = {};
  }
  const wallet = config.wallet;
  const primary = { ...((wallet.primary as Record<string, unknown>) ?? {}) };
  primary[chain] = source;
  wallet.primary = primary as typeof wallet.primary;
  config.wallet = wallet;
}

export interface WalletRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "readJsonBody" | "json" | "error"> {
  config: ElizaConfig;
  saveConfig: (config: ElizaConfig) => void;
  ensureWalletKeysInEnvAndConfig: (config: ElizaConfig) => boolean;
  resolveWalletExportRejection: (
    req: http.IncomingMessage,
    body: WalletExportRequestBody,
  ) => WalletExportRejectionLike | null;
  restartRuntime?: (reason: string) => Promise<boolean>;
  scheduleRuntimeRestart?: (reason: string) => void;
  deps?: WalletRouteDependencies;
  runtime?: AgentRuntime | null;
}

async function triggerWalletRuntimeReload(
  ctx: WalletRouteContext,
  reason: string,
): Promise<boolean> {
  const restarted = ctx.restartRuntime
    ? await ctx.restartRuntime(reason)
    : false;
  if (!restarted) {
    ctx.scheduleRuntimeRestart?.(reason);
  }
  return restarted;
}

const LOCAL_WALLET_SOURCE_ENV_KEYS: Record<WalletChain, string> = {
  evm: "WALLET_SOURCE_EVM",
  solana: "WALLET_SOURCE_SOLANA",
};

export async function handleWalletRoutes(
  ctx: WalletRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    config,
    saveConfig,
    resolveWalletExportRejection,
    readJsonBody,
    json,
    error,
  } = ctx;
  const deps = ctx.deps ?? DEFAULT_WALLET_ROUTE_DEPENDENCIES;

  // GET /api/wallet/addresses
  if (method === "GET" && pathname === "/api/wallet/addresses") {
    json(res, deps.getWalletAddresses());
    return true;
  }

  // GET /api/wallet/balances
  if (method === "GET" && pathname === "/api/wallet/balances") {
    const addresses = deps.getWalletAddresses();
    const rpcReadiness = resolveWalletRpcReadiness(config);
    const alchemyKey = process.env.ALCHEMY_API_KEY?.trim() || null;
    const ankrKey = process.env.ANKR_API_KEY?.trim() || null;
    const heliusKey = process.env.HELIUS_API_KEY?.trim() || null;

    const result: WalletBalancesResponse = { evm: null, solana: null };

    if (addresses.evmAddress && rpcReadiness.evmBalanceReady) {
      const evmBalancesSpan = createIntegrationTelemetrySpan({
        boundary: "wallet",
        operation: "fetch_evm_balances",
      });
      try {
        const chains = await deps.fetchEvmBalances(addresses.evmAddress, {
          alchemyKey,
          ankrKey,
          cloudManagedAccess: rpcReadiness.cloudManagedAccess,
          bscRpcUrls: rpcReadiness.bscRpcUrls,
          ethereumRpcUrls: rpcReadiness.ethereumRpcUrls,
          baseRpcUrls: rpcReadiness.baseRpcUrls,
          avaxRpcUrls: rpcReadiness.avalancheRpcUrls,
          nodeRealBscRpcUrl: process.env.NODEREAL_BSC_RPC_URL,
          quickNodeBscRpcUrl: process.env.QUICKNODE_BSC_RPC_URL,
          bscRpcUrl: process.env.BSC_RPC_URL,
          ethereumRpcUrl: process.env.ETHEREUM_RPC_URL,
          baseRpcUrl: process.env.BASE_RPC_URL,
          avaxRpcUrl: process.env.AVALANCHE_RPC_URL,
        });
        result.evm = { address: addresses.evmAddress, chains };
        evmBalancesSpan.success();
      } catch (err) {
        evmBalancesSpan.failure({ error: err });
        logger.warn(`[wallet] EVM balance fetch failed: ${err}`);
      }
    }

    if (addresses.solanaAddress && rpcReadiness.solanaBalanceReady) {
      const solanaBalancesSpan = createIntegrationTelemetrySpan({
        boundary: "wallet",
        operation: "fetch_solana_balances",
      });
      try {
        const solanaData = heliusKey
          ? await deps.fetchSolanaBalances(addresses.solanaAddress, heliusKey)
          : await deps.fetchSolanaNativeBalanceViaRpc(
              addresses.solanaAddress,
              rpcReadiness.solanaRpcUrls,
            );
        result.solana = { address: addresses.solanaAddress, ...solanaData };
        solanaBalancesSpan.success();
      } catch (err) {
        solanaBalancesSpan.failure({ error: err });
        logger.warn(`[wallet] Solana balance fetch failed: ${err}`);
      }
    }

    json(res, result);
    return true;
  }

  // POST /api/wallet/import
  if (method === "POST" && pathname === "/api/wallet/import") {
    const body = await readJsonBody<{ chain?: string; privateKey?: string }>(
      req,
      res,
    );
    if (!body) return true;

    if (!body.privateKey?.trim()) {
      error(res, "privateKey is required");
      return true;
    }

    let chain: WalletChain;
    if (body.chain === "evm" || body.chain === "solana") {
      chain = body.chain;
    } else if (body.chain) {
      error(
        res,
        `Unsupported chain: ${body.chain}. Must be "evm" or "solana".`,
      );
      return true;
    } else {
      const detection = deps.validatePrivateKey(body.privateKey.trim());
      chain = detection.chain;
    }

    // When steward is configured, warn that keys should be imported via vault
    const stewardWarning = process.env.STEWARD_API_URL?.trim()
      ? "Steward vault is configured. Consider importing keys directly into the vault instead of storing plaintext keys locally."
      : undefined;

    const result = deps.importWallet(chain, body.privateKey.trim());

    if (!result.success) {
      error(res, result.error ?? "Import failed", 422);
      return true;
    }

    if (!config.env) config.env = {};
    const envKey = chain === "evm" ? "EVM_PRIVATE_KEY" : "SOLANA_PRIVATE_KEY";
    (config.env as Record<string, string>)[envKey] = process.env[envKey] ?? "";
    persistPrimarySelection(config, chain, "local");

    let configSaveWarning: string | undefined;
    try {
      saveConfig(config);
    } catch (err) {
      const msg = `Config save failed: ${String(err)}`;
      logger.warn(`[api] ${msg}`);
      configSaveWarning = msg;
    }

    const warnings: string[] = [];
    if (configSaveWarning) warnings.push(configSaveWarning);
    if (stewardWarning) warnings.push(stewardWarning);

    const walletSourceEnvKey = LOCAL_WALLET_SOURCE_ENV_KEYS[chain];
    process.env[walletSourceEnvKey] = "local";
    try {
      await persistConfigEnv(walletSourceEnvKey, "local");
    } catch (err) {
      error(
        res,
        `Failed to persist ${walletSourceEnvKey}: ${String(err)}`,
        500,
      );
      return true;
    }

    const restarted = await triggerWalletRuntimeReload(
      ctx,
      "Wallet configuration updated",
    );

    json(res, {
      ok: true,
      chain,
      address: result.address,
      restarting: restarted,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
    return true;
  }

  // POST /api/wallet/generate
  if (method === "POST" && pathname === "/api/wallet/generate") {
    const body = await readJsonBody<{ chain?: string }>(req, res);
    if (!body) return true;

    const chain = body.chain as string | undefined;
    const validChains: Array<WalletChain | "both"> = ["evm", "solana", "both"];

    if (chain && !validChains.includes(chain as WalletChain | "both")) {
      error(
        res,
        `Unsupported chain: ${chain}. Must be "evm", "solana", or "both".`,
      );
      return true;
    }

    const targetChain = (chain ?? "both") as WalletChain | "both";

    // ── Steward-first: delegate wallet generation to steward ──────────
    const stewardApiUrl = process.env.STEWARD_API_URL?.trim();
    if (stewardApiUrl) {
      try {
        const agentId =
          process.env.STEWARD_AGENT_ID?.trim() ||
          process.env.ELIZA_STEWARD_AGENT_ID?.trim() ||
          null;

        if (!agentId) {
          error(
            res,
            "Steward is configured but no agent ID is set (STEWARD_AGENT_ID).",
            500,
          );
          return true;
        }

        // Build auth headers
        const headers: Record<string, string> = {
          Accept: "application/json",
          "Content-Type": "application/json",
        };
        const bearerToken = process.env.STEWARD_AGENT_TOKEN?.trim();
        const apiKey = process.env.STEWARD_API_KEY?.trim();
        const tenantId = process.env.STEWARD_TENANT_ID?.trim();
        if (bearerToken) {
          headers.Authorization = `Bearer ${bearerToken}`;
        } else if (apiKey) {
          headers["X-Steward-Key"] = apiKey;
        }
        if (tenantId) {
          headers["X-Steward-Tenant"] = tenantId;
        }

        // Check if agent already exists (has wallets)
        let agentEvm: string | null = null;
        let agentSolana: string | null = null;
        let agentExists = false;

        try {
          const agentRes = await fetch(
            `${stewardApiUrl}/agents/${encodeURIComponent(agentId)}`,
            { headers: { ...headers }, signal: AbortSignal.timeout(15_000) },
          );
          if (agentRes.ok) {
            agentExists = true;
            const agent = readStewardAgentWalletPayload(
              await agentRes.json(),
            );
            agentEvm =
              agent?.walletAddresses?.evm?.trim() ||
              agent?.walletAddress?.trim() ||
              null;
            agentSolana = agent?.walletAddresses?.solana?.trim() || null;
          }
        } catch {
          // agent doesn't exist or fetch failed — will try to create
        }

        // If agent doesn't exist, create it (steward auto-generates wallets)
        if (!agentExists) {
          const createRes = await fetch(`${stewardApiUrl}/agents`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: agentId, name: agentId }),
            signal: AbortSignal.timeout(15_000),
          });

          if (!createRes.ok) {
            const errText = await createRes.text().catch(() => "Unknown error");
            error(res, `Steward agent creation failed: ${errText}`, 502);
            return true;
          }

          const created = readStewardAgentWalletPayload(
            await createRes.json(),
          );
          agentEvm =
            created?.walletAddresses?.evm?.trim() ||
            created?.walletAddress?.trim() ||
            null;
          agentSolana = created?.walletAddresses?.solana?.trim() || null;

          logger.info(
            `[wallet] Created steward agent "${agentId}" with wallets`,
          );
        }

        // Cache steward addresses in env for synchronous access
        const generated: Array<{ chain: WalletChain; address: string }> = [];
        if (agentEvm && (targetChain === "both" || targetChain === "evm")) {
          process.env.STEWARD_EVM_ADDRESS = agentEvm;
          generated.push({ chain: "evm", address: agentEvm });
          logger.info(`[wallet] Steward EVM wallet: ${agentEvm}`);
        }
        if (
          agentSolana &&
          (targetChain === "both" || targetChain === "solana")
        ) {
          process.env.STEWARD_SOLANA_ADDRESS = agentSolana;
          generated.push({ chain: "solana", address: agentSolana });
          logger.info(`[wallet] Steward Solana wallet: ${agentSolana}`);
        }

        json(res, {
          ok: true,
          wallets: generated,
          source: "steward",
        });
        return true;
      } catch (err) {
        logger.warn(
          `[wallet] Steward wallet generation failed, falling back to local: ${err}`,
        );
        // Fall through to local generation
      }
    }

    // ── Legacy local key generation (fallback) ────────────────────────
    if (!config.env) config.env = {};

    const generated: Array<{ chain: WalletChain; address: string }> = [];
    const generatedChains: WalletChain[] = [];

    if (targetChain === "both" || targetChain === "evm") {
      const result = deps.generateWalletForChain("evm");
      process.env.EVM_PRIVATE_KEY = result.privateKey;
      (config.env as Record<string, string>).EVM_PRIVATE_KEY =
        result.privateKey;
      persistPrimarySelection(config, "evm", "local");
      generatedChains.push("evm");
      generated.push({ chain: "evm", address: result.address });
      logger.info(`[eliza-api] Generated EVM wallet: ${result.address}`);
    }

    if (targetChain === "both" || targetChain === "solana") {
      const result = deps.generateWalletForChain("solana");
      setSolanaWalletEnv(result.privateKey);
      (config.env as Record<string, string>).SOLANA_PRIVATE_KEY =
        result.privateKey;
      persistPrimarySelection(config, "solana", "local");
      generatedChains.push("solana");
      generated.push({ chain: "solana", address: result.address });
      logger.info(`[eliza-api] Generated Solana wallet: ${result.address}`);
    }

    let configSaveWarning: string | undefined;
    try {
      saveConfig(config);
    } catch (err) {
      const msg = `Config save failed: ${String(err)}`;
      logger.warn(`[api] ${msg}`);
      configSaveWarning = msg;
    }

    for (const chainName of generatedChains) {
      const walletSourceEnvKey = LOCAL_WALLET_SOURCE_ENV_KEYS[chainName];
      process.env[walletSourceEnvKey] = "local";
      try {
        await persistConfigEnv(walletSourceEnvKey, "local");
      } catch (err) {
        error(
          res,
          `Failed to persist ${walletSourceEnvKey}: ${String(err)}`,
          500,
        );
        return true;
      }
    }

    const restarted = await triggerWalletRuntimeReload(
      ctx,
      "Wallet configuration updated",
    );

    json(res, {
      ok: true,
      wallets: generated,
      source: "local",
      restarting: restarted,
      ...(configSaveWarning ? { warnings: [configSaveWarning] } : {}),
    });
    return true;
  }

  // GET /api/wallet/config
  if (method === "GET" && pathname === "/api/wallet/config") {
    const addresses = deps.getWalletAddresses();
    const rpcReadiness = resolveWalletRpcReadiness(config);
    const localSolanaSignerAvailable = Boolean(
      process.env.SOLANA_PRIVATE_KEY?.trim(),
    );
    const capability = resolveWalletCapabilityStatus({
      config,
      runtime: ctx.runtime ?? null,
      getWalletAddresses: deps.getWalletAddresses,
    });
    const alchemyKeySet = Boolean(process.env.ALCHEMY_API_KEY?.trim());
    const ankrKeySet = Boolean(process.env.ANKR_API_KEY?.trim());
    const nodeRealSet = Boolean(process.env.NODEREAL_BSC_RPC_URL?.trim());
    const quickNodeSet = Boolean(process.env.QUICKNODE_BSC_RPC_URL?.trim());
    const configStatus: WalletConfigStatus = {
      selectedRpcProviders: rpcReadiness.selectedRpcProviders,
      walletNetwork: resolveWalletNetworkMode(config),
      legacyCustomChains: rpcReadiness.legacyCustomChains,
      alchemyKeySet,
      infuraKeySet: Boolean(process.env.INFURA_API_KEY?.trim()),
      ankrKeySet,
      nodeRealBscRpcSet: nodeRealSet,
      quickNodeBscRpcSet: quickNodeSet,
      managedBscRpcReady: rpcReadiness.managedBscRpcReady,
      cloudManagedAccess: rpcReadiness.cloudManagedAccess,
      evmBalanceReady: rpcReadiness.evmBalanceReady,
      ethereumBalanceReady:
        alchemyKeySet || rpcReadiness.ethereumRpcUrls.length > 0,
      baseBalanceReady: alchemyKeySet || rpcReadiness.baseRpcUrls.length > 0,
      bscBalanceReady: ankrKeySet || rpcReadiness.bscRpcUrls.length > 0,
      avalancheBalanceReady:
        alchemyKeySet || rpcReadiness.avalancheRpcUrls.length > 0,
      solanaBalanceReady: rpcReadiness.solanaBalanceReady,
      heliusKeySet: Boolean(process.env.HELIUS_API_KEY?.trim()),
      birdeyeKeySet: Boolean(process.env.BIRDEYE_API_KEY?.trim()),
      evmChains: [
        "Ethereum",
        "Base",
        "Arbitrum",
        "Optimism",
        "Polygon",
        "BSC",
        "Avalanche",
      ],
      evmAddress: addresses.evmAddress,
      solanaAddress: addresses.solanaAddress,
      walletSource: capability.walletSource,
      automationMode: capability.automationMode,
      pluginEvmLoaded: capability.pluginEvmLoaded,
      pluginEvmRequired: capability.pluginEvmRequired,
      executionReady: capability.executionReady,
      executionBlockedReason: capability.executionBlockedReason,
      solanaSigningAvailable:
        localSolanaSignerAvailable && Boolean(addresses.solanaAddress),
    };
    json(res, configStatus);
    return true;
  }

  // PUT /api/wallet/config
  if (method === "PUT" && pathname === "/api/wallet/config") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const updateRequest = resolveWalletConfigUpdateRequest(
      body,
      getStoredWalletRpcSelections(config),
    );
    if (!updateRequest) {
      error(res, "Invalid wallet config update");
      return true;
    }

    applyWalletRpcConfigUpdate(config, updateRequest);

    let configSaveWarning: string | undefined;
    try {
      saveConfig(config);
    } catch (err) {
      const msg = `Config save failed: ${String(err)}`;
      logger.warn(`[api] ${msg}`);
      configSaveWarning = msg;
    }

    json(res, {
      ok: true,
      ...(configSaveWarning ? { warnings: [configSaveWarning] } : {}),
    });
    ctx.scheduleRuntimeRestart?.("Wallet configuration updated");
    return true;
  }

  // POST /api/wallet/export
  if (method === "POST" && pathname === "/api/wallet/export") {
    if (!rateLimitWalletExport(req)) {
      error(res, "Too many export attempts. Try again later.", 429);
      return true;
    }

    const body = await readJsonBody<WalletExportRequestBody>(req, res);
    if (!body) return true;

    const rejection = resolveWalletExportRejection(req, body);
    if (rejection) {
      error(res, rejection.reason, rejection.status);
      return true;
    }

    const evmKey = process.env.EVM_PRIVATE_KEY ?? null;
    const solanaKey = process.env.SOLANA_PRIVATE_KEY ?? null;
    const addresses = deps.getWalletAddresses();

    logger.warn(
      `[wallet] Private keys exported via API (ip=${req.socket?.remoteAddress ?? "unknown"})`,
    );

    json(res, {
      evm: evmKey
        ? { privateKey: evmKey, address: addresses.evmAddress }
        : null,
      solana: solanaKey
        ? { privateKey: solanaKey, address: addresses.solanaAddress }
        : null,
    });
    return true;
  }

  return false;
}
