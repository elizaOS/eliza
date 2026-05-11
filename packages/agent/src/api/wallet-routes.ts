import crypto from "node:crypto";
import type http from "node:http";
import type { AgentRuntime, RouteRequestMeta } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  type CloudWalletDescriptor,
  type CloudWalletProvider,
  ElizaCloudClient,
  getOrCreateClientAddressKey,
  normalizeCloudSiteUrl,
  persistCloudWalletCache,
  provisionCloudWalletsBestEffort,
  resolveCloudApiKey,
} from "@elizaos/plugin-elizacloud";
import type {
  RouteHelpers,
  WalletExportRejection as WalletExportRejectionLike,
  WalletExportRequestBody,
} from "@elizaos/shared";
import {
  normalizeWalletRpcSelections,
  type WalletConfigUpdateRequest,
  type WalletRpcSelections,
} from "@elizaos/shared";
import { ethers } from "ethers";
import type { ElizaConfig } from "../config/config.ts";
import { isCloudWalletEnabled } from "../config/feature-flags.ts";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";
import { persistConfigEnv } from "./config-env.ts";
import {
  deriveSolanaAddress,
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
} from "./wallet.ts";
import { resolveWalletCapabilityStatus } from "./wallet-capability.ts";
import {
  applyWalletRpcConfigUpdate,
  getStoredWalletRpcSelections,
  resolveWalletNetworkMode,
  resolveWalletRpcReadiness,
} from "./wallet-rpc.ts";

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

// ── Dual-wallet response shape (Phase 6, gated by ENABLE_CLOUD_WALLET) ────

export type WalletSource = "local" | "cloud";
export type WalletChainKind = "evm" | "solana";
export type WalletProviderKind = "local" | "privy" | "steward";

export interface WalletEntry {
  source: WalletSource;
  chain: WalletChainKind;
  address: string;
  provider: WalletProviderKind;
  primary: boolean;
}

export interface WalletPrimaryMap {
  evm: WalletSource;
  solana: WalletSource;
}

interface CachedCloudWalletDescriptor {
  agentWalletId?: string | null;
  walletAddress?: string | null;
  walletProvider?: string | null;
  balance?: string | number | null;
}

function readCloudWalletCache(
  config: ElizaConfig,
): Partial<Record<WalletChainKind, CachedCloudWalletDescriptor>> {
  const wallet = config.wallet;
  if (!wallet || typeof wallet !== "object") return {};
  const cloud = (wallet as { cloud?: unknown }).cloud;
  if (!cloud || typeof cloud !== "object") return {};
  return cloud as Partial<Record<WalletChainKind, CachedCloudWalletDescriptor>>;
}

function readPrimaryMap(config: ElizaConfig): WalletPrimaryMap {
  const wallet = config.wallet;
  const raw =
    wallet && typeof wallet === "object"
      ? (wallet as { primary?: unknown }).primary
      : undefined;
  const out: WalletPrimaryMap = { evm: "local", solana: "local" };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.evm === "cloud" || record.evm === "local") out.evm = record.evm;
    if (record.solana === "cloud" || record.solana === "local") {
      out.solana = record.solana;
    }
  }
  return out;
}

function coerceCloudProvider(value: unknown): CloudWalletProvider {
  return value === "privy" || value === "steward" ? value : "privy";
}

/**
 * Build the dual-wallet `{ wallets[], primary }` block. Returns `null`
 * when the cloud-wallet flag is off so callers can omit both fields and
 * preserve the pre-flag response shape exactly.
 */
function buildDualWalletShape(
  config: ElizaConfig,
  addresses: { evmAddress: string | null; solanaAddress: string | null },
): { wallets: WalletEntry[]; primary: WalletPrimaryMap } | null {
  if (!isCloudWalletEnabled()) return null;

  const primary = readPrimaryMap(config);
  const wallets: WalletEntry[] = [];

  if (addresses.evmAddress) {
    wallets.push({
      source: "local",
      chain: "evm",
      address: addresses.evmAddress,
      provider: "local",
      primary: primary.evm === "local",
    });
  }
  if (addresses.solanaAddress) {
    wallets.push({
      source: "local",
      chain: "solana",
      address: addresses.solanaAddress,
      provider: "local",
      primary: primary.solana === "local",
    });
  }

  const cloud = readCloudWalletCache(config);
  for (const chain of ["evm", "solana"] as const) {
    const descriptor = cloud[chain];
    const address = descriptor?.walletAddress;
    if (typeof address === "string" && address.length > 0) {
      wallets.push({
        source: "cloud",
        chain,
        address,
        provider: coerceCloudProvider(descriptor?.walletProvider),
        primary: primary[chain] === "cloud",
      });
    }
  }

  return { wallets, primary };
}

function readCloudWalletAddress(
  descriptor: CachedCloudWalletDescriptor | undefined,
): string | null {
  if (typeof descriptor?.walletAddress !== "string") return null;
  const trimmed = descriptor.walletAddress.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readCachedCloudWalletDescriptor(
  config: ElizaConfig,
  chain: WalletChainKind,
): CloudWalletDescriptor | null {
  const descriptor = readCloudWalletCache(config)[chain];
  const walletAddress = readCloudWalletAddress(descriptor);
  if (!walletAddress) return null;
  return {
    agentWalletId:
      typeof descriptor?.agentWalletId === "string" &&
      descriptor.agentWalletId.trim().length > 0
        ? descriptor.agentWalletId
        : `cached-${chain}`,
    walletAddress,
    walletProvider: coerceCloudProvider(descriptor?.walletProvider),
    chainType: chain,
    balance: descriptor?.balance ?? undefined,
  };
}

function readCachedCloudWalletDescriptors(
  config: ElizaConfig,
): Partial<Record<WalletChainKind, CloudWalletDescriptor>> {
  const evm = readCachedCloudWalletDescriptor(config, "evm");
  const solana = readCachedCloudWalletDescriptor(config, "solana");
  return {
    ...(evm ? { evm } : {}),
    ...(solana ? { solana } : {}),
  };
}

function resolvePrimaryWalletAddresses(
  config: ElizaConfig,
  addresses: { evmAddress: string | null; solanaAddress: string | null },
): { evmAddress: string | null; solanaAddress: string | null } {
  const primary = readPrimaryMap(config);
  const cloud = readCloudWalletCache(config);

  return {
    evmAddress:
      primary.evm === "cloud"
        ? readCloudWalletAddress(cloud.evm)
        : addresses.evmAddress,
    solanaAddress:
      primary.solana === "cloud"
        ? readCloudWalletAddress(cloud.solana)
        : addresses.solanaAddress,
  };
}

function persistPrimarySelection(
  config: ElizaConfig,
  chain: WalletChainKind,
  source: WalletSource,
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

type BrowserSolanaCluster = "mainnet" | "devnet" | "testnet";

interface BrowserEvmTransactionRequest {
  broadcast: boolean;
  chainId: number;
  data?: string;
  to: string;
  value: string;
}

interface BrowserSolanaWeb3Module {
  Keypair: {
    fromSeed(seed: Uint8Array): unknown;
  };
  VersionedTransaction: {
    deserialize(bytes: Uint8Array): {
      sign(signers: unknown[]): void;
      serialize(): Uint8Array;
    };
  };
  Transaction: {
    from(bytes: Uint8Array): {
      partialSign(...signers: unknown[]): void;
      serialize(): Uint8Array;
    };
  };
  Connection: new (
    endpoint: string,
    commitment: string,
  ) => {
    sendRawTransaction(bytes: Uint8Array): Promise<string>;
  };
}

const SOLANA_PKCS8_DER_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function normalizeBrowserString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBrowserBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeBrowserHexData(value: unknown): string | undefined {
  const trimmed = normalizeBrowserString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function safeParseBrowserBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(
      `Invalid transaction value: expected an integer or hex string, got "${value}"`,
    );
  }
}

function resolveLocalBrowserEvmWallet(): ethers.Wallet {
  const evmKey = normalizeBrowserString(process.env.EVM_PRIVATE_KEY);
  if (!evmKey) {
    throw new Error("Local EVM wallet signing is unavailable.");
  }
  return new ethers.Wallet(evmKey.startsWith("0x") ? evmKey : `0x${evmKey}`);
}

function base58DecodeBrowser(value: string): Buffer {
  if (!value.length) {
    return Buffer.alloc(0);
  }
  let number = 0n;
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${character}`);
    }
    number = number * 58n + BigInt(index);
  }
  const hex = number.toString(16);
  const bytes = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex");
  let leadingZeroes = 0;
  for (const character of value) {
    if (character !== "1") {
      break;
    }
    leadingZeroes += 1;
  }
  return leadingZeroes
    ? Buffer.concat([Buffer.alloc(leadingZeroes), bytes])
    : bytes;
}

function decodeLocalBrowserSolanaPrivateKey(value: string): Buffer {
  const trimmed = value.trim();
  if (
    trimmed.startsWith("[") &&
    trimmed.endsWith("]") &&
    /^\[\s*\d/.test(trimmed)
  ) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry) => typeof entry === "number")
    ) {
      throw new Error("Invalid Solana private key JSON array.");
    }
    return Buffer.from(parsed);
  }
  return base58DecodeBrowser(trimmed);
}

function resolveLocalBrowserSolanaSeed(): { address: string; seed: Buffer } {
  const solanaKey = normalizeBrowserString(process.env.SOLANA_PRIVATE_KEY);
  if (!solanaKey) {
    throw new Error("Local Solana signing is unavailable.");
  }
  const decoded = decodeLocalBrowserSolanaPrivateKey(solanaKey);
  const seed =
    decoded.length === 64
      ? decoded.subarray(0, 32)
      : decoded.length === 32
        ? decoded
        : null;
  if (!seed) {
    throw new Error(
      `Invalid Solana private key length: expected 32 or 64 bytes, got ${decoded.length}.`,
    );
  }
  return {
    address: deriveSolanaAddress(solanaKey),
    seed,
  };
}

function resolveBrowserSolanaMessageBytes(
  body: Record<string, unknown>,
): Buffer {
  const messageBase64 = normalizeBrowserString(body.messageBase64);
  if (messageBase64) {
    return Buffer.from(messageBase64, "base64");
  }
  const message = normalizeBrowserString(body.message);
  if (!message) {
    throw new Error("message or messageBase64 is required.");
  }
  return Buffer.from(message, "utf8");
}

function resolveBrowserWalletMessagePayload(
  message: string,
): string | Uint8Array {
  const trimmed = message.trim();
  if (
    trimmed.startsWith("0x") &&
    trimmed.length >= 4 &&
    trimmed.length % 2 === 0
  ) {
    try {
      return ethers.getBytes(trimmed);
    } catch {
      return message;
    }
  }
  return message;
}

async function signLocalBrowserWalletMessage(message: string): Promise<{
  mode: "local-key";
  signature: string;
}> {
  const wallet = resolveLocalBrowserEvmWallet();
  return {
    mode: "local-key",
    signature: await wallet.signMessage(
      resolveBrowserWalletMessagePayload(message),
    ),
  };
}

async function signLocalBrowserSolanaMessage(
  body: Record<string, unknown>,
): Promise<{
  address: string;
  mode: "local-key";
  signatureBase64: string;
}> {
  const { address, seed } = resolveLocalBrowserSolanaSeed();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([SOLANA_PKCS8_DER_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const signature = crypto.sign(
    null,
    resolveBrowserSolanaMessageBytes(body),
    privateKey,
  );
  return {
    address,
    mode: "local-key",
    signatureBase64: signature.toString("base64"),
  };
}

function normalizeBrowserSolanaCluster(value: unknown): BrowserSolanaCluster {
  if (value === "devnet" || value === "testnet" || value === "mainnet") {
    return value;
  }
  return "mainnet";
}

function browserSolanaClusterRpcUrl(cluster: BrowserSolanaCluster): string {
  switch (cluster) {
    case "devnet":
      return "https://api.devnet.solana.com";
    case "testnet":
      return "https://api.testnet.solana.com";
    default:
      return "https://api.mainnet-beta.solana.com";
  }
}

async function loadBrowserSolanaWeb3(): Promise<BrowserSolanaWeb3Module> {
  return (await import("@solana/web3.js")) as BrowserSolanaWeb3Module;
}

async function signLocalBrowserSolanaTransaction(
  body: Record<string, unknown>,
): Promise<{
  address: string;
  mode: "local-key";
  signedTransactionBase64: string;
  signature?: string;
  cluster: BrowserSolanaCluster;
}> {
  const transactionBase64 = normalizeBrowserString(body.transactionBase64);
  if (!transactionBase64) {
    throw new Error("transactionBase64 is required.");
  }
  const broadcast = normalizeBrowserBoolean(body.broadcast, false);
  const cluster = normalizeBrowserSolanaCluster(body.cluster);
  const { address, seed } = resolveLocalBrowserSolanaSeed();

  const { Keypair, VersionedTransaction, Transaction, Connection } =
    await loadBrowserSolanaWeb3();
  const keypair = Keypair.fromSeed(new Uint8Array(seed));
  const txBytes = Buffer.from(transactionBase64, "base64");

  let signedBytes: Uint8Array;
  let broadcastSignature: string | undefined;
  try {
    const versioned = VersionedTransaction.deserialize(txBytes);
    versioned.sign([keypair]);
    signedBytes = versioned.serialize();
    if (broadcast) {
      const connection = new Connection(
        browserSolanaClusterRpcUrl(cluster),
        "confirmed",
      );
      broadcastSignature = await connection.sendRawTransaction(signedBytes);
    }
  } catch (_error) {
    const legacy = Transaction.from(txBytes);
    legacy.partialSign(keypair);
    signedBytes = legacy.serialize();
    if (broadcast) {
      const connection = new Connection(
        browserSolanaClusterRpcUrl(cluster),
        "confirmed",
      );
      broadcastSignature = await connection.sendRawTransaction(signedBytes);
    }
  }

  return {
    address,
    mode: "local-key",
    signedTransactionBase64: Buffer.from(signedBytes).toString("base64"),
    ...(broadcastSignature ? { signature: broadcastSignature } : {}),
    cluster,
  };
}

function resolvePreferredBrowserRpcUrl(
  config: ElizaConfig,
  chainId: number,
): string | null {
  const readiness = resolveWalletRpcReadiness(config);
  switch (chainId) {
    case 1:
      return readiness.ethereumRpcUrls[0] ?? null;
    case 56:
    case 97:
      return readiness.bscRpcUrls[0] ?? null;
    case 8453:
      return readiness.baseRpcUrls[0] ?? null;
    case 43114:
      return readiness.avalancheRpcUrls[0] ?? null;
    default:
      return null;
  }
}

async function sendLocalBrowserWalletTransaction(
  config: ElizaConfig,
  request: BrowserEvmTransactionRequest,
): Promise<{
  approved: true;
  mode: "local-key";
  pending: false;
  txHash: string;
}> {
  if (request.broadcast === false) {
    throw new Error(
      "Local browser wallet signing currently requires broadcast=true.",
    );
  }
  const rpcUrl = resolvePreferredBrowserRpcUrl(config, request.chainId);
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for chain ${request.chainId}.`);
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  try {
    const wallet = resolveLocalBrowserEvmWallet().connect(provider);
    const txResponse = await wallet.sendTransaction({
      chainId: request.chainId,
      data: request.data,
      to: request.to,
      value: safeParseBrowserBigInt(request.value),
    });
    return {
      approved: true,
      mode: "local-key",
      pending: false,
      txHash: txResponse.hash,
    };
  } finally {
    provider.destroy();
  }
}

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
    const body = await readJsonBody<{ chain?: string; source?: string }>(
      req,
      res,
    );
    if (!body) return true;

    const chain = body.chain as string | undefined;
    const validChains: Array<WalletChain | "both"> = ["evm", "solana", "both"];
    const requestedSource =
      body.source === "local" || body.source === "steward"
        ? body.source
        : undefined;

    if (chain && !validChains.includes(chain as WalletChain | "both")) {
      error(
        res,
        `Unsupported chain: ${chain}. Must be "evm", "solana", or "both".`,
      );
      return true;
    }
    if (
      typeof body.source === "string" &&
      requestedSource !== "local" &&
      requestedSource !== "steward"
    ) {
      error(
        res,
        `Unsupported source: ${body.source}. Must be "local" or "steward".`,
      );
      return true;
    }

    const targetChain = (chain ?? "both") as WalletChain | "both";

    // ── Steward-first: delegate wallet generation to steward ──────────
    const stewardApiUrl = process.env.STEWARD_API_URL?.trim();
    if (stewardApiUrl && requestedSource !== "local") {
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
            const agentBody = (await agentRes.json()) as {
              data?: {
                walletAddress?: string;
                walletAddresses?: { evm?: string; solana?: string };
              };
              walletAddress?: string;
              walletAddresses?: { evm?: string; solana?: string };
            };
            const agent = agentBody.data ?? agentBody;
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

          const createBody = (await createRes.json()) as {
            ok?: boolean;
            data?: {
              walletAddress?: string;
              walletAddresses?: { evm?: string; solana?: string };
            };
            walletAddress?: string;
            walletAddresses?: { evm?: string; solana?: string };
          };
          const created = createBody.data ?? createBody;
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
    const primary = readPrimaryMap(config);
    const primaryAddresses = resolvePrimaryWalletAddresses(config, addresses);
    const rpcReadiness = resolveWalletRpcReadiness(config);
    const localSolanaSignerAvailable = Boolean(
      process.env.SOLANA_PRIVATE_KEY?.trim(),
    );
    const capability = resolveWalletCapabilityStatus({
      config,
      runtime: ctx.runtime ?? null,
      getWalletAddresses: () => primaryAddresses,
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
      evmAddress: primaryAddresses.evmAddress,
      solanaAddress: primaryAddresses.solanaAddress,
      walletSource: capability.walletSource,
      automationMode: capability.automationMode,
      pluginEvmLoaded: capability.pluginEvmLoaded,
      pluginEvmRequired: capability.pluginEvmRequired,
      executionReady: capability.executionReady,
      executionBlockedReason: capability.executionBlockedReason,
      evmSigningCapability: capability.evmSigningCapability,
      evmSigningReason: capability.evmSigningReason,
      solanaSigningAvailable: primaryAddresses.solanaAddress
        ? localSolanaSignerAvailable || primary.solana === "cloud"
        : false,
    };
    const dual = buildDualWalletShape(config, addresses);
    if (dual) {
      json(res, {
        ...configStatus,
        wallets: dual.wallets,
        primary: dual.primary,
      });
    } else {
      json(res, configStatus);
    }
    return true;
  }

  if (
    method === "POST" &&
    (pathname === "/api/wallet/browser-transaction" ||
      pathname === "/api/wallet/browser-sign-message" ||
      pathname === "/api/wallet/browser-solana-sign-message" ||
      pathname === "/api/wallet/browser-solana-transaction")
  ) {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const hasLocalEvmKey = Boolean(
      normalizeBrowserString(process.env.EVM_PRIVATE_KEY),
    );
    const hasLocalSolanaKey = Boolean(
      normalizeBrowserString(process.env.SOLANA_PRIVATE_KEY),
    );

    if (pathname === "/api/wallet/browser-sign-message") {
      const message = normalizeBrowserString(body.message);
      if (!message) {
        error(res, "message is required.", 400);
        return true;
      }
      if (!hasLocalEvmKey) {
        error(res, "No browser EVM signer is available.", 503);
        return true;
      }
      try {
        json(res, await signLocalBrowserWalletMessage(message));
      } catch (err) {
        error(res, err instanceof Error ? err.message : String(err), 503);
      }
      return true;
    }

    if (pathname === "/api/wallet/browser-solana-sign-message") {
      if (!hasLocalSolanaKey) {
        error(res, "No browser Solana signer is available.", 503);
        return true;
      }
      try {
        json(res, await signLocalBrowserSolanaMessage(body));
      } catch (err) {
        error(res, err instanceof Error ? err.message : String(err), 503);
      }
      return true;
    }

    if (pathname === "/api/wallet/browser-solana-transaction") {
      if (!hasLocalSolanaKey) {
        error(res, "No browser Solana transaction signer is available.", 503);
        return true;
      }
      try {
        json(res, await signLocalBrowserSolanaTransaction(body));
      } catch (err) {
        error(res, err instanceof Error ? err.message : String(err), 503);
      }
      return true;
    }

    if (!hasLocalEvmKey) {
      error(res, "No browser EVM transaction signer is available.", 503);
      return true;
    }

    const request: BrowserEvmTransactionRequest = {
      broadcast: normalizeBrowserBoolean(body.broadcast, true),
      chainId:
        typeof body.chainId === "number" && Number.isFinite(body.chainId)
          ? body.chainId
          : Number.NaN,
      data: normalizeBrowserHexData(body.data),
      to: normalizeBrowserString(body.to) ?? "",
      value: normalizeBrowserString(body.value) ?? "0",
    };

    if (!request.to || !Number.isFinite(request.chainId)) {
      error(res, "to and a valid chainId are required.", 400);
      return true;
    }

    try {
      json(res, await sendLocalBrowserWalletTransaction(config, request));
    } catch (err) {
      error(res, err instanceof Error ? err.message : String(err), 503);
    }
    return true;
  }

  // POST /api/wallet/primary — flag-gated (404 when ENABLE_CLOUD_WALLET is off).
  // Body: { chain: "evm"|"solana", source: "local"|"cloud" }
  if (method === "POST" && pathname === "/api/wallet/primary") {
    if (!isCloudWalletEnabled()) {
      error(res, "Not found", 404);
      return true;
    }
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const chainRaw = typeof body.chain === "string" ? body.chain : "";
    const sourceRaw = typeof body.source === "string" ? body.source : "";
    if (chainRaw !== "evm" && chainRaw !== "solana") {
      error(res, "chain must be 'evm' or 'solana'");
      return true;
    }
    if (sourceRaw !== "local" && sourceRaw !== "cloud") {
      error(res, "source must be 'local' or 'cloud'");
      return true;
    }

    const chain = chainRaw as WalletChainKind;
    const source = sourceRaw as WalletSource;
    const previousPrimary = readPrimaryMap(config)[chain];

    persistPrimarySelection(config, chain, source);

    let configSaveWarning: string | undefined;
    try {
      saveConfig(config);
    } catch (err) {
      configSaveWarning = `Config save failed: ${String(err)}`;
      logger.warn(`[api] ${configSaveWarning}`);
    }

    const envKey =
      chain === "evm" ? "WALLET_SOURCE_EVM" : "WALLET_SOURCE_SOLANA";
    try {
      await persistConfigEnv(envKey, source);
    } catch (err) {
      error(res, `Failed to persist ${envKey}: ${String(err)}`, 500);
      return true;
    }

    const restarted =
      previousPrimary === source
        ? false
        : await triggerWalletRuntimeReload(ctx, "primary-changed");

    json(res, {
      ok: true,
      chain,
      source,
      restarting: restarted,
      ...(configSaveWarning ? { warnings: [configSaveWarning] } : {}),
    });
    return true;
  }

  // POST /api/wallet/refresh-cloud — flag-gated.
  // Re-queries the Eliza Cloud bridge for per-chain wallet descriptors and
  // refreshes `config.wallet.cloud.*`. Provision is best-effort so one bad
  // chain does not discard the other imported wallet(s). This is a refresh
  // operation, so we re-fetch all chains to pick up any upstream changes
  // (address rotation, migration, etc.), not just new chains.
  if (method === "POST" && pathname === "/api/wallet/refresh-cloud") {
    if (!isCloudWalletEnabled()) {
      error(res, "Not found", 404);
      return true;
    }

    const cloud = config.cloud;
    const apiKey = resolveCloudApiKey(config, ctx.runtime) ?? "";
    const baseUrl = cloud?.baseUrl
      ? normalizeCloudSiteUrl(cloud.baseUrl)
      : "https://www.elizacloud.ai";
    if (!apiKey) {
      error(res, "Cloud not linked — sign in to Eliza Cloud first", 400);
      return true;
    }

    const agentEntry = config.agents?.list?.[0];
    const agentId =
      agentEntry?.id ??
      (ctx.runtime as { agentId?: string } | null)?.agentId ??
      null;
    if (!agentId) {
      error(res, "No agent configured", 400);
      return true;
    }

    try {
      const { address: clientAddress } = await getOrCreateClientAddressKey();
      const bridge = new ElizaCloudClient(baseUrl, apiKey);
      const cachedDescriptors = readCachedCloudWalletDescriptors(config);
      const chainsToProvision = (["evm", "solana"] as const).filter(
        (chain) => !cachedDescriptors[chain],
      );
      const descriptors: Partial<
        Record<WalletChainKind, CloudWalletDescriptor>
      > = { ...cachedDescriptors };
      const warnings: string[] = [];
      const previousPrimary = readPrimaryMap(config);
      const previousEvmAddress = readCloudWalletAddress(cachedDescriptors.evm);
      const previousSolanaAddress = readCloudWalletAddress(
        cachedDescriptors.solana,
      );
      if (chainsToProvision.length > 0) {
        const provisionResult = await provisionCloudWalletsBestEffort(bridge, {
          agentId,
          clientAddress,
          chains: chainsToProvision,
        });
        Object.assign(descriptors, provisionResult.descriptors);
        for (const [index, failure] of provisionResult.failures.entries()) {
          const cached = cachedDescriptors[failure.chain];
          if (cached) {
            descriptors[failure.chain] = cached;
            const detail =
              failure.error instanceof Error
                ? failure.error.message
                : String(failure.error);
            warnings.push(
              `Reused cached ${failure.chain} cloud wallet after refresh failed: ${detail}`,
            );
            continue;
          }
          warnings.push(
            provisionResult.warnings[index] ??
              `Cloud ${failure.chain} wallet import failed`,
          );
        }
      }
      if (!descriptors.evm && !descriptors.solana) {
        throw new Error(
          warnings[0] ?? "Failed to provision any cloud wallet descriptors",
        );
      }
      persistCloudWalletCache(config as never, descriptors);

      process.env.ENABLE_CLOUD_WALLET = "1";
      await persistConfigEnv("ENABLE_CLOUD_WALLET", "1");

      const cloudConfig: Record<string, unknown> = { ...(cloud ?? {}) };
      cloudConfig.clientAddressPublicKey = clientAddress;
      config.cloud = cloudConfig as typeof config.cloud;

      if (descriptors.evm?.walletAddress) {
        process.env.ELIZA_CLOUD_EVM_ADDRESS = descriptors.evm.walletAddress;
        await persistConfigEnv(
          "ELIZA_CLOUD_EVM_ADDRESS",
          descriptors.evm.walletAddress,
        );
        process.env.ENABLE_EVM_PLUGIN = "1";
        await persistConfigEnv("ENABLE_EVM_PLUGIN", "1");
        process.env.WALLET_SOURCE_EVM = "cloud";
        await persistConfigEnv("WALLET_SOURCE_EVM", "cloud");
        persistPrimarySelection(config, "evm", "cloud");
      }

      if (descriptors.solana?.walletAddress) {
        process.env.ELIZA_CLOUD_SOLANA_ADDRESS =
          descriptors.solana.walletAddress;
        await persistConfigEnv(
          "ELIZA_CLOUD_SOLANA_ADDRESS",
          descriptors.solana.walletAddress,
        );
        process.env.WALLET_SOURCE_SOLANA = "cloud";
        await persistConfigEnv("WALLET_SOURCE_SOLANA", "cloud");
        persistPrimarySelection(config, "solana", "cloud");
      }

      let configSaveWarning: string | undefined;
      try {
        saveConfig(config);
      } catch (err) {
        configSaveWarning = `Config save failed: ${String(err)}`;
        logger.warn(`[api] ${configSaveWarning}`);
      }

      const responseWarnings = [...warnings];
      if (configSaveWarning) {
        responseWarnings.push(configSaveWarning);
      }

      const nextPrimary = readPrimaryMap(config);
      const nextEvmAddress = descriptors.evm?.walletAddress ?? null;
      const nextSolanaAddress = descriptors.solana?.walletAddress ?? null;
      const walletBindingChanged =
        previousPrimary.evm !== nextPrimary.evm ||
        previousPrimary.solana !== nextPrimary.solana ||
        previousEvmAddress !== nextEvmAddress ||
        previousSolanaAddress !== nextSolanaAddress;
      const restarted = walletBindingChanged
        ? await triggerWalletRuntimeReload(ctx, "cloud-refreshed")
        : false;

      json(res, {
        ok: true,
        restarting: restarted,
        wallets: {
          evm: descriptors.evm
            ? {
                address: descriptors.evm.walletAddress,
                provider: descriptors.evm.walletProvider,
              }
            : null,
          solana: descriptors.solana
            ? {
                address: descriptors.solana.walletAddress,
                provider: descriptors.solana.walletProvider,
              }
            : null,
        },
        ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
      });
    } catch (err) {
      logger.warn(`[api] cloud wallet refresh failed: ${String(err)}`);
      error(res, `Cloud wallet refresh failed: ${String(err)}`, 502);
    }
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

    const selectedProviders = normalizeWalletRpcSelections(
      updateRequest.selections,
    );
    const shouldEnableCloudWallet = Object.values(selectedProviders).every(
      (provider) => provider === "eliza-cloud",
    );

    if (shouldEnableCloudWallet) {
      process.env.ENABLE_CLOUD_WALLET = "1";
      try {
        await persistConfigEnv("ENABLE_CLOUD_WALLET", "1");
      } catch (err) {
        error(
          res,
          `Failed to persist ENABLE_CLOUD_WALLET: ${String(err)}`,
          500,
        );
        return true;
      }
    }

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
    return true;
  }

  // GET /api/wallet/approvals/stream — SSE stub until Steward approval wiring lands.
  if (method === "GET" && pathname === "/api/wallet/approvals/stream") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const writeSse = (event: string, data: Record<string, unknown>) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    writeSse("wallet_approvals", {
      ok: true,
      approvals: [],
      note: "Approval stream placeholder — connect Steward decision bridge when available.",
    });

    const ping = setInterval(() => {
      try {
        writeSse("ping", { t: Date.now() });
      } catch {
        clearInterval(ping);
      }
    }, 15_000);

    req.on("close", () => {
      clearInterval(ping);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    });
    return true;
  }

  const approvalDecision = /^\/api\/wallet\/approvals\/([^/]+)\/decision$/.exec(
    pathname,
  );
  if (method === "POST" && approvalDecision) {
    error(
      res,
      "Wallet approval decisions are not wired to Steward in this build.",
      501,
    );
    return true;
  }

  // POST /api/wallet/export — removed (no plaintext key export from the agent API).
  if (method === "POST" && pathname === "/api/wallet/export") {
    error(
      res,
      "Private key export has been removed. Use Steward or OS-backed custody flows.",
      410,
    );
    return true;
  }

  return false;
}
