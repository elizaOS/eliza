import type http from "node:http";
import { sendJson, sendJsonError } from "@elizaos/app-core";
import { logger } from "@elizaos/core";
import {
  HYPERLIQUID_ACCOUNT_BLOCKED_REASON,
  HYPERLIQUID_API_BASE,
  HYPERLIQUID_API_WALLET_GUIDANCE,
  HYPERLIQUID_EXECUTION_BLOCKED_REASON,
  HYPERLIQUID_EXECUTION_NOT_IMPLEMENTED_REASON,
  HYPERLIQUID_LOCAL_KEY_GUIDANCE,
  HYPERLIQUID_VAULT_GUIDANCE,
  type HyperliquidAccountSource,
  type HyperliquidApiWalletStatus,
  type HyperliquidCredentialMode,
  type HyperliquidExecutionDisabledResponse,
  type HyperliquidMarket,
  type HyperliquidMarketsResponse,
  type HyperliquidOrder,
  type HyperliquidOrdersResponse,
  type HyperliquidPosition,
  type HyperliquidPositionsResponse,
  type HyperliquidStatusResponse,
} from "./hyperliquid-contracts";

export type HyperliquidFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface HyperliquidRouteState {
  fetchImpl?: HyperliquidFetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

interface HyperliquidConfig {
  apiBaseUrl: string;
  accountAddress: string | null;
  accountSource: HyperliquidAccountSource;
  accountBlockedReason: string | null;
  credentialMode: HyperliquidCredentialMode;
  signerReady: boolean;
  executionReady: boolean;
  executionBlockedReason: string | null;
  vault: {
    configured: boolean;
    ready: boolean;
    address: string | null;
  };
  apiWallet: HyperliquidApiWalletStatus;
}

interface HyperliquidInfoClient {
  getMarkets(): Promise<HyperliquidMarket[]>;
  getPositions(accountAddress: string): Promise<HyperliquidPosition[]>;
  getOpenOrders(accountAddress: string): Promise<HyperliquidOrder[]>;
}

const HEX_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_PRIVATE_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const STEWARD_EVM_ADDRESS_ENV_KEY = "STEWARD_EVM_ADDRESS";
const MANAGED_EVM_ADDRESS_ENV_KEY = "ELIZA_MANAGED_EVM_ADDRESS";

export async function handleHyperliquidRoute(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: HyperliquidRouteState = {},
): Promise<boolean> {
  if (!pathname.startsWith("/api/hyperliquid")) return false;

  const env = state.env ?? process.env;
  const fetchImpl = state.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const now = state.now ?? (() => new Date());
  const config = resolveHyperliquidConfig(env);

  if (method !== "GET") {
    const payload: HyperliquidExecutionDisabledResponse = {
      executionReady: false,
      executionBlockedReason:
        config.executionBlockedReason ?? HYPERLIQUID_EXECUTION_BLOCKED_REASON,
      credentialMode: config.credentialMode,
    };
    sendJson(res, 501, payload);
    return true;
  }

  if (pathname === "/api/hyperliquid/status") {
    const payload: HyperliquidStatusResponse = {
      publicReadReady: Boolean(fetchImpl),
      signerReady: config.signerReady,
      executionReady: config.executionReady,
      executionBlockedReason: config.executionBlockedReason,
      accountAddress: config.accountAddress,
      apiBaseUrl: config.apiBaseUrl,
      credentialMode: config.credentialMode,
      readiness: {
        publicReads: Boolean(fetchImpl),
        accountReads: Boolean(config.accountAddress),
        signer: config.signerReady,
        execution: false,
      },
      account: {
        address: config.accountAddress,
        source: config.accountSource,
        guidance: config.accountBlockedReason,
      },
      vault: {
        ...config.vault,
        guidance: HYPERLIQUID_VAULT_GUIDANCE,
      },
      apiWallet: config.apiWallet,
    };
    sendJson(res, 200, payload);
    return true;
  }

  if (!fetchImpl) {
    sendJsonError(res, 503, "Fetch API is unavailable for Hyperliquid reads");
    return true;
  }

  const client = createHyperliquidInfoClient({
    fetchImpl,
    apiBaseUrl: config.apiBaseUrl,
  });

  if (pathname === "/api/hyperliquid/markets") {
    try {
      const payload: HyperliquidMarketsResponse = {
        markets: await client.getMarkets(),
        source: "hyperliquid-info-meta",
        fetchedAt: now().toISOString(),
      };
      sendJson(res, 200, payload);
    } catch (error) {
      logger.error(
        { error: describeError(error) },
        "[HyperliquidRoutes] Market fetch failed",
      );
      sendJsonError(res, 502, "Hyperliquid market fetch failed");
    }
    return true;
  }

  if (pathname === "/api/hyperliquid/positions") {
    if (!config.accountAddress) {
      const payload: HyperliquidPositionsResponse = {
        accountAddress: null,
        positions: [],
        readBlockedReason: config.accountBlockedReason,
        fetchedAt: null,
      };
      sendJson(res, 200, payload);
      return true;
    }

    try {
      const payload: HyperliquidPositionsResponse = {
        accountAddress: config.accountAddress,
        positions: await client.getPositions(config.accountAddress),
        readBlockedReason: null,
        fetchedAt: now().toISOString(),
      };
      sendJson(res, 200, payload);
    } catch (error) {
      logger.error(
        { error: describeError(error), accountAddress: config.accountAddress },
        "[HyperliquidRoutes] Position fetch failed",
      );
      sendJsonError(res, 502, "Hyperliquid position fetch failed");
    }
    return true;
  }

  if (pathname === "/api/hyperliquid/orders") {
    if (!config.accountAddress) {
      const payload: HyperliquidOrdersResponse = {
        accountAddress: null,
        orders: [],
        readBlockedReason: config.accountBlockedReason,
        fetchedAt: null,
      };
      sendJson(res, 200, payload);
      return true;
    }

    try {
      const payload: HyperliquidOrdersResponse = {
        accountAddress: config.accountAddress,
        orders: await client.getOpenOrders(config.accountAddress),
        readBlockedReason: null,
        fetchedAt: now().toISOString(),
      };
      sendJson(res, 200, payload);
    } catch (error) {
      logger.error(
        { error: describeError(error), accountAddress: config.accountAddress },
        "[HyperliquidRoutes] Order fetch failed",
      );
      sendJsonError(res, 502, "Hyperliquid order fetch failed");
    }
    return true;
  }

  return false;
}

export function createHyperliquidInfoClient({
  fetchImpl,
  apiBaseUrl = HYPERLIQUID_API_BASE,
}: {
  fetchImpl: HyperliquidFetch;
  apiBaseUrl?: string;
}): HyperliquidInfoClient {
  async function infoRequest<T>(body: Record<string, string>): Promise<T> {
    const response = await fetchImpl(`${apiBaseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Hyperliquid Info API ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    return (await response.json()) as T;
  }

  return {
    async getMarkets() {
      const meta = await infoRequest<unknown>({ type: "meta" });
      return parseMarkets(meta);
    },
    async getPositions(accountAddress) {
      const state = await infoRequest<unknown>({
        type: "clearinghouseState",
        user: accountAddress,
      });
      return parsePositions(state);
    },
    async getOpenOrders(accountAddress) {
      const orders = await infoRequest<unknown>({
        type: "openOrders",
        user: accountAddress,
      });
      return parseOrders(orders);
    },
  };
}

function resolveHyperliquidConfig(env: NodeJS.ProcessEnv): HyperliquidConfig {
  const managedVaultAddress = readFirstValidAddress(env, [
    STEWARD_EVM_ADDRESS_ENV_KEY,
    MANAGED_EVM_ADDRESS_ENV_KEY,
  ]);
  const managedVaultConfigured =
    Boolean(managedVaultAddress) ||
    Boolean(readEnvString(env, "STEWARD_API_URL")) ||
    readEnvString(env, "ELIZA_WALLET_BACKEND") === "steward";
  const managedVaultReady = Boolean(managedVaultAddress);
  const rawAccount =
    readEnvString(env, "HYPERLIQUID_ACCOUNT_ADDRESS") ??
    readEnvString(env, "HL_ACCOUNT_ADDRESS");
  const envAccountAddress =
    rawAccount && HEX_ADDRESS_PATTERN.test(rawAccount) ? rawAccount : null;
  const accountAddress = managedVaultAddress ?? envAccountAddress;
  const accountSource: HyperliquidAccountSource = managedVaultAddress
    ? "managed_vault"
    : envAccountAddress
      ? "env_account"
      : "none";
  const accountBlockedReason = accountAddress
    ? null
    : rawAccount
      ? "HYPERLIQUID_ACCOUNT_ADDRESS / HL_ACCOUNT_ADDRESS must be a 0x-prefixed EVM address."
      : HYPERLIQUID_ACCOUNT_BLOCKED_REASON;
  const privateKey = readFirstValidPrivateKey(env, [
    "EVM_PRIVATE_KEY",
    "HYPERLIQUID_PRIVATE_KEY",
    "HL_PRIVATE_KEY",
  ]);
  const localKeyReady = Boolean(privateKey);
  const signerReady = managedVaultReady || localKeyReady;
  const credentialMode = resolveCredentialMode({
    managedVaultReady,
    localKeyReady,
  });
  const apiWalletConfigured = Boolean(
    readFirstValidPrivateKey(env, ["HYPERLIQUID_AGENT_KEY", "HL_AGENT_KEY"]),
  );

  return {
    apiBaseUrl: HYPERLIQUID_API_BASE,
    accountAddress,
    accountSource,
    accountBlockedReason,
    credentialMode,
    signerReady,
    executionReady: false,
    executionBlockedReason: signerReady
      ? HYPERLIQUID_EXECUTION_NOT_IMPLEMENTED_REASON
      : HYPERLIQUID_EXECUTION_BLOCKED_REASON,
    vault: {
      configured: managedVaultConfigured,
      ready: managedVaultReady,
      address: managedVaultAddress,
    },
    apiWallet: {
      configured: apiWalletConfigured,
      guidance: apiWalletConfigured
        ? HYPERLIQUID_API_WALLET_GUIDANCE
        : `${HYPERLIQUID_API_WALLET_GUIDANCE} ${HYPERLIQUID_LOCAL_KEY_GUIDANCE}`,
    },
  };
}

function resolveCredentialMode({
  managedVaultReady,
  localKeyReady,
}: {
  managedVaultReady: boolean;
  localKeyReady: boolean;
}): HyperliquidCredentialMode {
  if (managedVaultReady) return "managed_vault";
  if (localKeyReady) return "local_key";
  return "none";
}

function readFirstValidAddress(
  env: NodeJS.ProcessEnv,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = readEnvString(env, key);
    if (value && HEX_ADDRESS_PATTERN.test(value)) return value;
  }
  return null;
}

function readFirstValidPrivateKey(
  env: NodeJS.ProcessEnv,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = readEnvString(env, key);
    if (value && HEX_PRIVATE_KEY_PATTERN.test(value)) return value;
  }
  return null;
}

function readEnvString(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function parseMarkets(value: unknown): HyperliquidMarket[] {
  const record = asRecord(value, "Hyperliquid meta response");
  const universe = record.universe;
  if (!Array.isArray(universe)) {
    throw new Error("Hyperliquid meta response missing universe");
  }

  return universe.map((entry, index) => {
    const item = asRecord(entry, "Hyperliquid universe entry");
    return {
      name: readRequiredString(item, "name"),
      index,
      szDecimals: readRequiredNumber(item, "szDecimals"),
      maxLeverage: readOptionalNumber(item, "maxLeverage"),
      onlyIsolated: readOptionalBoolean(item, "onlyIsolated") ?? false,
      isDelisted: readOptionalBoolean(item, "isDelisted") ?? false,
    };
  });
}

function parsePositions(value: unknown): HyperliquidPosition[] {
  const record = asRecord(value, "Hyperliquid clearinghouseState response");
  const assetPositions = record.assetPositions;
  if (!Array.isArray(assetPositions)) {
    throw new Error("Hyperliquid clearinghouseState missing assetPositions");
  }

  return assetPositions.map((entry) => {
    const item = asRecord(entry, "Hyperliquid asset position entry");
    const position = asRecord(item.position, "Hyperliquid position");
    const leverage =
      position.leverage === undefined
        ? null
        : asRecord(position.leverage, "Hyperliquid leverage");

    return {
      coin: readRequiredString(position, "coin"),
      size: readRequiredString(position, "szi"),
      entryPx: readOptionalString(position, "entryPx"),
      positionValue: readOptionalString(position, "positionValue"),
      unrealizedPnl: readOptionalString(position, "unrealizedPnl"),
      returnOnEquity: readOptionalString(position, "returnOnEquity"),
      liquidationPx: readOptionalString(position, "liquidationPx"),
      marginUsed: readOptionalString(position, "marginUsed"),
      leverageType: leverage ? readOptionalString(leverage, "type") : null,
      leverageValue: leverage ? readOptionalNumber(leverage, "value") : null,
    };
  });
}

function parseOrders(value: unknown): HyperliquidOrder[] {
  if (!Array.isArray(value)) {
    throw new Error("Hyperliquid openOrders response must be an array");
  }

  return value.map((entry) => {
    const item = asRecord(entry, "Hyperliquid open order");
    return {
      coin: readRequiredString(item, "coin"),
      side: readRequiredString(item, "side"),
      limitPx: readRequiredString(item, "limitPx"),
      size: readRequiredString(item, "sz"),
      oid: readRequiredNumber(item, "oid"),
      timestamp: readRequiredNumber(item, "timestamp"),
      reduceOnly: readOptionalBoolean(item, "reduceOnly") ?? false,
      orderType: readOptionalString(item, "orderType"),
      tif: readOptionalString(item, "tif"),
      cloid: readOptionalString(item, "cloid"),
    };
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return field;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function readRequiredNumber(
  value: Record<string, unknown>,
  key: string,
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`${key} must be a finite number`);
  }
  return field;
}

function readOptionalNumber(
  value: Record<string, unknown>,
  key: string,
): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function readOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | null {
  const field = value[key];
  return typeof field === "boolean" ? field : null;
}

function describeError(error: unknown): { message: string } {
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}
