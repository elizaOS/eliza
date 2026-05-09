/**
 * Configuration for x402 micropayment system
 * Route-specific pricing is now defined locally in each route definition
 *
 * Payment Verification Methods:
 *
 * 1. Direct Blockchain Proof (X-Payment-Proof header)
 *    - User sends payment transaction on-chain
 *    - Transaction signature is verified against blockchain
 *    - Supports: Solana, Base, Polygon
 *    - Format: base64-encoded JSON with signature and authorization
 *
 * 2. Facilitator Payment ID (X-Payment-Id header)
 *    - Third-party service handles payment
 *    - Service returns payment ID after successful payment
 *    - ID is verified through facilitator API
 *    - Configured via X402_FACILITATOR_URL environment variable
 *    - Example: X402_FACILITATOR_URL=https://facilitator.x402.ai
 *
 * 3. Standard X-Payment / PAYMENT-SIGNATURE (x402-fetch / CDP-style)
 *    - Base64(JSON) or raw JSON: `{ x402Version, accepted, payload }`
 *    - Verified and settled with POST `{ paymentPayload, paymentRequirements }`
 *      to facilitator `/verify` then `/settle`
 *    - Override endpoints with `X402_FACILITATOR_VERIFY_URL` and
 *      `X402_FACILITATOR_SETTLE_URL`; otherwise append `/verify` and `/settle`
 *      to `X402_FACILITATOR_URL`.
 *
 * The facilitator endpoint should implement:
 *   GET /verify/{paymentId}
 *     - 200 OK: Payment is valid (with optional { valid: true } JSON body)
 *     - 404 Not Found: Payment ID doesn't exist
 *     - 410 Gone: Payment already used (prevents replay attacks)
 *
 * Seller-side replay: proof / payment ID keys are atomically reserved in the
 * SQL-backed runtime cache by default (`X402_REPLAY_DURABLE`, see x402 docs),
 * then marked consumed after successful verification. Disable with
 * `X402_REPLAY_DURABLE=0` for in-memory TTL-only behavior (dev / tests).
 */

import { logger } from "@elizaos/core";
import type { X402ScanNetwork } from "./x402-types.js";

/** Networks supported by built-in x402 presets and verification */
export type Network = "BASE" | "SOLANA" | "POLYGON" | "BSC";

/**
 * Built-in networks supported by default
 */
export const BUILT_IN_NETWORKS = ["BASE", "SOLANA", "POLYGON", "BSC"] as const;

// Default network configuration
export const DEFAULT_NETWORK: Network = "SOLANA";

/**
 * Convert our Network type to x402scan-compliant network names
 * @throws {Error} If network is not supported by x402scan
 */
export function toX402Network(network: Network): X402ScanNetwork {
  const networkMap: Partial<Record<Network, X402ScanNetwork>> = {
    BASE: "base",
    SOLANA: "solana",
    POLYGON: "polygon",
    BSC: "bsc",
  };

  const mappedNetwork = networkMap[network];
  if (!mappedNetwork) {
    throw new Error(
      `Network '${network}' is not supported by x402scan. ` +
        `Supported networks: ${BUILT_IN_NETWORKS.join(", ")}`,
    );
  }

  return mappedNetwork;
}

/** Shipped fallbacks — not your treasury; startup validation warns / errors in production. */
export const BUNDLED_EXAMPLE_EVM_PAYOUT =
  "0x066E94e1200aa765d0A6392777D543Aa6Dea606C";
export const BUNDLED_EXAMPLE_SOLANA_PAYOUT =
  "3nMBmufBUBVnk28sTp3NsrSJsdVGTyLZYmsqpMFaUT9J";

export function paymentAddressIsBundledExample(
  network: Network,
  paymentAddress: string,
): boolean {
  const a = paymentAddress.trim();
  if (!a) return false;
  if (network === "SOLANA") return a === BUNDLED_EXAMPLE_SOLANA_PAYOUT;
  if (network === "BASE" || network === "POLYGON" || network === "BSC") {
    return a.toLowerCase() === BUNDLED_EXAMPLE_EVM_PAYOUT.toLowerCase();
  }
  return false;
}

/**
 * Network-specific wallet addresses
 * Uses existing environment variables from your project configuration
 */
export const PAYMENT_ADDRESSES: Partial<Record<Network, string>> = {
  BASE:
    process.env.BASE_PUBLIC_KEY ||
    process.env.PAYMENT_WALLET_BASE ||
    BUNDLED_EXAMPLE_EVM_PAYOUT,
  SOLANA:
    process.env.SOLANA_PUBLIC_KEY ||
    process.env.PAYMENT_WALLET_SOLANA ||
    BUNDLED_EXAMPLE_SOLANA_PAYOUT,
  POLYGON:
    process.env.POLYGON_PUBLIC_KEY || process.env.PAYMENT_WALLET_POLYGON || "",
  BSC:
    process.env.BSC_PUBLIC_KEY ||
    process.env.PAYMENT_WALLET_BSC ||
    BUNDLED_EXAMPLE_EVM_PAYOUT,
};

/**
 * Get the base URL for the current server
 * Used to construct full resource URLs for x402 responses
 */
export function getBaseUrl(): string {
  // Check for explicit base URL setting
  if (process.env.X402_BASE_URL) {
    return process.env.X402_BASE_URL.replace(/\/$/, ""); // Remove trailing slash
  }

  return "https://x402.elizaos.ai";
}

/**
 * Convert a route path to a full resource URL
 */
export function toResourceUrl(path: string): string {
  const baseUrl = getBaseUrl();
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${cleanPath}`;
}

/**
 * Token configuration for Solana
 */
export const SOLANA_TOKENS = {
  USDC: {
    symbol: "USDC",
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  AI16Z: {
    symbol: "ai16z",
    address: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC",
    decimals: 6,
  },
  DEGENAI: {
    symbol: "degenai",
    address: "Gu3LDkn7Vx3bmCzLafYNKcDxv2mH7YN44NJZFXnypump",
    decimals: 6,
  },
  ELIZAOS: {
    symbol: "elizaOS",
    address: "DuMbhu7mvQvqQHGcnikDgb4XegXJRyhUBfdU22uELiZA",
    decimals: 6,
  },
} as const;

/**
 * Token configuration for Base (EVM)
 */
export const BASE_TOKENS = {
  USDC: {
    symbol: "USDC",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
  },
  ELIZAOS: {
    symbol: "elizaOS",
    address: "0xea17Df5Cf6D172224892B5477A16ACb111182478",
    decimals: 18,
  },
} as const;

/**
 * Token configuration for Polygon (EVM)
 */
export const POLYGON_TOKENS = {
  USDC: {
    symbol: "USDC",
    address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    decimals: 6,
  },
} as const;

/**
 * Token configuration for BNB Smart Chain (EVM)
 */
export const BSC_TOKENS = {
  USDC: {
    symbol: "USDC",
    address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals: 18,
  },
} as const;

/**
 * Default asset for each network (used in x402 responses)
 */
export const NETWORK_ASSETS: Partial<Record<Network, string>> = {
  BASE: "USDC", // USDC on Base
  SOLANA: "USDC", // USDC on Solana (default, but also supports ai16z and degenai)
  POLYGON: "USDC", // USDC on Polygon
  BSC: "USDC", // Binance-Peg USDC on BNB Smart Chain
};

/**
 * Get all accepted assets for a network
 * @throws {Error} If network is not supported
 */
export function getNetworkAssets(network: Network): string[] {
  if (network === "SOLANA") {
    return Object.values(SOLANA_TOKENS).map((t) => t.symbol);
  }
  if (network === "BASE") {
    return Object.values(BASE_TOKENS).map((t) => t.symbol);
  }
  if (network === "POLYGON") {
    return Object.values(POLYGON_TOKENS).map((t) => t.symbol);
  }
  if (network === "BSC") {
    return Object.values(BSC_TOKENS).map((t) => t.symbol);
  }

  const defaultAsset = NETWORK_ASSETS[network];
  if (!defaultAsset) {
    throw new Error(
      `Network '${network}' is not configured. ` +
        `Supported networks: ${BUILT_IN_NETWORKS.join(", ")}`,
    );
  }

  return [defaultAsset];
}

// Default/legacy wallet address (uses default network)
export const PAYMENT_RECEIVER_ADDRESS =
  PAYMENT_ADDRESSES[DEFAULT_NETWORK] || "";

/**
 * Named payment config definition - stores individual fields, CAIP-19 constructed on-demand
 */
export interface PaymentConfigDefinition {
  network: Network;
  assetNamespace: string; // e.g., "erc20", "spl-token", "slip44"
  assetReference: string; // e.g., contract address or token mint
  paymentAddress: string; // Recipient address
  symbol: string; // Display symbol (USDC, ETH, etc.)
  chainId?: string; // Optional chain ID for CAIP-2 (e.g., "8453" for Base)
}

/**
 * Payment configuration registry - named configs for easy reference
 */
export const PAYMENT_CONFIGS: Record<string, PaymentConfigDefinition> = {
  base_usdc: {
    network: "BASE",
    assetNamespace: "erc20",
    assetReference: BASE_TOKENS.USDC.address,
    paymentAddress: PAYMENT_ADDRESSES.BASE ?? BUNDLED_EXAMPLE_EVM_PAYOUT,
    symbol: "USDC",
    chainId: "8453",
  },
  solana_usdc: {
    network: "SOLANA",
    assetNamespace: "spl-token",
    assetReference: SOLANA_TOKENS.USDC.address,
    paymentAddress: PAYMENT_ADDRESSES.SOLANA ?? BUNDLED_EXAMPLE_SOLANA_PAYOUT,
    symbol: "USDC",
  },
  polygon_usdc: {
    network: "POLYGON",
    assetNamespace: "erc20",
    assetReference: POLYGON_TOKENS.USDC.address,
    paymentAddress: PAYMENT_ADDRESSES.POLYGON || "",
    symbol: "USDC",
    chainId: "137",
  },
  bsc_usdc: {
    network: "BSC",
    assetNamespace: "erc20",
    assetReference: BSC_TOKENS.USDC.address,
    paymentAddress: PAYMENT_ADDRESSES.BSC ?? BUNDLED_EXAMPLE_EVM_PAYOUT,
    symbol: "USDC",
    chainId: "56",
  },
  base_elizaos: {
    network: "BASE",
    assetNamespace: "erc20",
    assetReference: BASE_TOKENS.ELIZAOS.address,
    paymentAddress: PAYMENT_ADDRESSES.BASE ?? BUNDLED_EXAMPLE_EVM_PAYOUT,
    symbol: "elizaOS",
    chainId: "8453",
  },
  solana_elizaos: {
    network: "SOLANA",
    assetNamespace: "spl-token",
    assetReference: SOLANA_TOKENS.ELIZAOS.address,
    paymentAddress: PAYMENT_ADDRESSES.SOLANA ?? BUNDLED_EXAMPLE_SOLANA_PAYOUT,
    symbol: "elizaOS",
  },
  solana_degenai: {
    network: "SOLANA",
    assetNamespace: "spl-token",
    assetReference: SOLANA_TOKENS.DEGENAI.address,
    paymentAddress: PAYMENT_ADDRESSES.SOLANA ?? BUNDLED_EXAMPLE_SOLANA_PAYOUT,
    symbol: "degenai",
  },
};

/**
 * Construct CAIP-19 asset ID from payment config fields
 */
export function getCAIP19FromConfig(config: PaymentConfigDefinition): string {
  // Build CAIP-2 chain ID: namespace:reference
  const chainNamespace = config.network === "SOLANA" ? "solana" : "eip155";
  const chainReference =
    config.chainId ||
    (config.network === "BASE"
      ? "8453"
      : config.network === "POLYGON"
        ? "137"
        : config.network === "BSC"
          ? "56"
          : "1");
  const chainId = `${chainNamespace}:${chainReference}`;

  // Build asset part: namespace:reference
  const assetId = `${config.assetNamespace}:${config.assetReference}`;

  // Full CAIP-19: chain_id/asset_namespace:asset_reference
  return `${chainId}/${assetId}`;
}

/**
 * Mutable registry for custom payment configs
 * Plugins can register configs via registerX402Config()
 */
const CUSTOM_PAYMENT_CONFIGS: Record<string, PaymentConfigDefinition> = {};

/**
 * Register a custom payment configuration
 * Plugins call this in their init() function
 *
 * A second call with the same `name` (or the same `agentId`+`name` for scoped
 * keys) throws unless `override: true` is set, so two plugins cannot silently
 * replace each other in `CUSTOM_PAYMENT_CONFIGS`.
 *
 * @example
 * ```typescript
 * registerX402Config('base_ai16z', {
 *   network: 'BASE',
 *   assetNamespace: 'erc20',
 *   assetReference: '0x...',
 *   paymentAddress: process.env.BASE_PUBLIC_KEY,
 *   symbol: 'AI16Z',
 *   chainId: '8453'
 * });
 *
 * // Agent-specific override
 * registerX402Config('base_usdc', {...}, { agentId: runtime.agentId });
 * ```
 */
export function registerX402Config(
  name: string,
  config: PaymentConfigDefinition,
  options?: { override?: boolean; agentId?: string },
): void {
  // Prevent accidental override of built-in configs
  if (PAYMENT_CONFIGS[name] && !options?.override) {
    throw new Error(
      `Payment config '${name}' already exists. Use override: true to replace it.`,
    );
  }

  const registryKey = options?.agentId ? `${options.agentId}:${name}` : name;
  if (CUSTOM_PAYMENT_CONFIGS[registryKey] && !options?.override) {
    throw new Error(
      `Payment config '${registryKey}' is already registered. Use override: true to replace it.`,
    );
  }

  CUSTOM_PAYMENT_CONFIGS[registryKey] = config;

  logger.debug(
    { registryKey, symbol: config.symbol, network: config.network },
    "[x402] registered payment config",
  );
}

/**
 * Get payment config - checks custom registry then built-in
 * Supports agent-specific configs via agentId parameter
 */
export function getPaymentConfig(
  name: string,
  agentId?: string,
): PaymentConfigDefinition {
  // Check agent-specific config first
  if (agentId) {
    const agentConfig = CUSTOM_PAYMENT_CONFIGS[`${agentId}:${name}`];
    if (agentConfig) return agentConfig;
  }

  // Check custom global configs
  const customConfig = CUSTOM_PAYMENT_CONFIGS[name];
  if (customConfig) return customConfig;

  // Check built-in configs
  const builtInConfig = PAYMENT_CONFIGS[name];
  if (!builtInConfig) {
    const available = [
      ...Object.keys(PAYMENT_CONFIGS),
      ...Object.keys(CUSTOM_PAYMENT_CONFIGS).filter((k) => !k.includes(":")),
    ];
    throw new Error(
      `Unknown payment config '${name}'. Available: ${available.join(", ")}`,
    );
  }
  return builtInConfig;
}

/**
 * List all available payment configs (built-in + custom)
 * Optionally filter to agent-specific configs
 */
export function listX402Configs(agentId?: string): string[] {
  const configs = new Set([
    ...Object.keys(PAYMENT_CONFIGS),
    ...Object.keys(CUSTOM_PAYMENT_CONFIGS).filter((k) => !k.includes(":")),
  ]);

  if (agentId) {
    for (const k of Object.keys(CUSTOM_PAYMENT_CONFIGS)) {
      if (k.startsWith(`${agentId}:`)) {
        const short = k.split(":")[1];
        if (short) configs.add(short);
      }
    }
  }

  return Array.from(configs).sort();
}

/**
 * Validate payment config name
 */
export function validatePaymentConfigName(name: string): boolean {
  return name in PAYMENT_CONFIGS;
}

// Re-export X402Config from core for convenience
export type { X402Config } from "@elizaos/core";

/**
 * Get the payment address for a specific network
 * @throws {Error} If network is not configured
 */
export function getPaymentAddress(network: Network): string {
  const address = PAYMENT_ADDRESSES[network];
  if (!address) {
    throw new Error(
      `No payment address configured for network '${network}'. ` +
        `Supported networks: ${BUILT_IN_NETWORKS.join(", ")}. ` +
        `Set ${network}_PUBLIC_KEY in your environment.`,
    );
  }
  return address;
}

/**
 * Get all network addresses with metadata
 * Only returns networks that have configured addresses
 */
export function getNetworkAddresses(networks: Network[]): Array<{
  name: Network;
  address: string;
  facilitatorEndpoint?: string;
}> {
  return networks
    .filter(
      (network) =>
        PAYMENT_ADDRESSES[network] !== undefined &&
        PAYMENT_ADDRESSES[network] !== "",
    )
    .map((network) => ({
      name: network,
      address: PAYMENT_ADDRESSES[network] as string,
      // Add facilitator endpoint for EVM chains if configured
      ...((network === "BASE" || network === "POLYGON" || network === "BSC") &&
        process.env.EVM_FACILITATOR && {
          facilitatorEndpoint: process.env.EVM_FACILITATOR,
        }),
    }));
}

/**
 * Approximate USD/token map (float) for dashboards or legacy callers.
 * **Atomic amounts** use exact rational math from the same env defaults — see
 * `atomicAmountForPriceInCents` / `getTokenUsdPerTokenRational` in this file.
 */
export const TOKEN_PRICES_USD: Record<string, number> = {
  USDC: 1.0,
  ai16z: Number.parseFloat(process.env.AI16Z_PRICE_USD || "0.5"),
  degenai: Number.parseFloat(process.env.DEGENAI_PRICE_USD || "0.01"),
  elizaOS: Number.parseFloat(process.env.ELIZAOS_PRICE_USD || "0.05"),
  ETH: 2000.0, // Simplified; override via env/oracle in future
};

/**
 * Get token decimals for an asset
 */
/**
 * Parse a positive USD decimal string (e.g. "1.25", optional leading "$")
 * into an exact positive rational num/den in dollars (not cents).
 */
function usdDecimalStringToRational(raw: string): { num: bigint; den: bigint } {
  const s = raw.replace(/^\$/, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid USD decimal: ${raw}`);
  }
  const [wi, fr = ""] = s.split(".");
  const den = 10n ** BigInt(fr.length);
  const whole = BigInt(wi || "0");
  const frac = fr ? BigInt(fr) : 0n;
  const num = whole * den + frac;
  if (num <= 0n) {
    throw new Error(`USD amount must be positive: ${raw}`);
  }
  return { num, den };
}

function envUsdPerTokenRational(
  envKey: string,
  fallback: string,
): { num: bigint; den: bigint } {
  const v = process.env[envKey]?.trim();
  return usdDecimalStringToRational(v && v.length > 0 ? v : fallback);
}

/** USD (not cents) per 1 full token, as exact rational num/den */
function getTokenUsdPerTokenRational(
  asset: string,
  _network?: Network,
): { num: bigint; den: bigint } {
  const upper = asset.toUpperCase();
  if (upper === "USDC") return { num: 1n, den: 1n };
  if (asset === "elizaOS" || upper === "ELIZAOS") {
    return envUsdPerTokenRational("ELIZAOS_PRICE_USD", "0.05");
  }
  if (upper === "DEGENAI" || asset === "degenai") {
    return envUsdPerTokenRational("DEGENAI_PRICE_USD", "0.01");
  }
  if (upper === "AI16Z" || asset === "ai16z") {
    return envUsdPerTokenRational("AI16Z_PRICE_USD", "0.5");
  }
  if (upper === "ETH") return { num: 2000n, den: 1n };
  return { num: 1n, den: 1n };
}

function getTokenDecimals(asset: string, network?: Network): number {
  // Check network-specific tokens if network is provided
  if (network === "SOLANA") {
    const solanaToken = Object.values(SOLANA_TOKENS).find(
      (t) => t.symbol === asset,
    );
    if (solanaToken) return solanaToken.decimals;
  }
  if (network === "BASE") {
    const baseToken = Object.values(BASE_TOKENS).find(
      (t) => t.symbol === asset,
    );
    if (baseToken) return baseToken.decimals;
  }
  if (network === "POLYGON") {
    const polygonToken = Object.values(POLYGON_TOKENS).find(
      (t) => t.symbol === asset,
    );
    if (polygonToken) return polygonToken.decimals;
  }
  if (network === "BSC") {
    const bscToken = Object.values(BSC_TOKENS).find((t) => t.symbol === asset);
    if (bscToken) return bscToken.decimals;
  }

  // Check all token configs if no network specified
  const solanaToken = Object.values(SOLANA_TOKENS).find(
    (t) => t.symbol === asset,
  );
  if (solanaToken) return solanaToken.decimals;

  const baseToken = Object.values(BASE_TOKENS).find((t) => t.symbol === asset);
  if (baseToken) return baseToken.decimals;

  const polygonToken = Object.values(POLYGON_TOKENS).find(
    (t) => t.symbol === asset,
  );
  if (polygonToken) return polygonToken.decimals;

  const bscToken = Object.values(BSC_TOKENS).find((t) => t.symbol === asset);
  if (bscToken) return bscToken.decimals;

  // Defaults
  if (asset === "USDC") return 6;
  if (asset === "ETH") return 18;

  return 6; // Default to 6 decimals
}

/**
 * Smallest-unit token amount for x402 `maxAmountRequired` and verification,
 * from integer USD cents and a concrete payment config (symbol + network).
 */
export function atomicAmountForPriceInCents(
  priceInCents: number,
  config: PaymentConfigDefinition,
): string {
  if (!Number.isFinite(priceInCents) || priceInCents <= 0) {
    throw new Error("priceInCents must be a positive finite number");
  }
  const cents = BigInt(Math.floor(priceInCents));
  const { num: p, den: q } = getTokenUsdPerTokenRational(
    config.symbol,
    config.network,
  );
  const dec = getTokenDecimals(config.symbol, config.network);
  if (dec < 0 || dec > 120) {
    throw new Error("invalid token decimals for payment config");
  }
  const scale = 10n ** BigInt(dec);
  const numer = cents * q * scale;
  const denom = 100n * p;
  if (denom === 0n) {
    throw new Error("invalid token USD price (zero denominator)");
  }
  return ((numer + denom - 1n) / denom).toString();
}

/**
 * Parse price string (e.g., "$0.10") as a USD **dollar** amount and convert to
 * the asset’s smallest units (ceil), using the same rational pricing as
 * `atomicAmountForPriceInCents` / env overrides (`ELIZAOS_PRICE_USD`, etc.).
 */
export function parsePrice(
  price: string,
  asset: string = "USDC",
  network?: Network,
): string {
  const { num: un, den: ud } = usdDecimalStringToRational(price);
  const { num: p, den: q } = getTokenUsdPerTokenRational(asset, network);
  const dec = getTokenDecimals(asset, network);
  if (dec < 0 || dec > 120) {
    throw new Error("invalid token decimals");
  }
  const scale = 10n ** BigInt(dec);
  const numer = un * q * scale;
  const denom = ud * p;
  if (denom === 0n) {
    throw new Error("invalid token USD price (zero denominator)");
  }
  return ((numer + denom - 1n) / denom).toString();
}

/**
 * Get token address for any network and asset
 */
export function getTokenAddress(
  asset: string,
  network: Network,
): string | undefined {
  if (network === "SOLANA") {
    const token = Object.values(SOLANA_TOKENS).find((t) => t.symbol === asset);
    return token?.address;
  }
  if (network === "BASE") {
    const token = Object.values(BASE_TOKENS).find((t) => t.symbol === asset);
    return token?.address;
  }
  if (network === "POLYGON") {
    const token = Object.values(POLYGON_TOKENS).find((t) => t.symbol === asset);
    return token?.address;
  }
  if (network === "BSC") {
    const token = Object.values(BSC_TOKENS).find((t) => t.symbol === asset);
    return token?.address;
  }
  return undefined;
}

/**
 * Get the asset for a specific network
 * @throws {Error} If network is not configured
 */
export function getNetworkAsset(network: Network): string {
  const asset = NETWORK_ASSETS[network];
  if (!asset) {
    throw new Error(
      `No default asset configured for network '${network}'. ` +
        `Supported networks: ${BUILT_IN_NETWORKS.join(", ")}`,
    );
  }
  return asset;
}

/**
 * Get x402 system health status
 * Useful for monitoring and debugging
 */
export function getX402Health(): {
  networks: Array<{
    network: Network;
    configured: boolean;
    address: string | null;
  }>;
  facilitator: { url: string | null; configured: boolean };
} {
  const networks: Network[] = ["BASE", "SOLANA", "POLYGON", "BSC"];

  return {
    networks: networks.map((network) => ({
      network,
      configured:
        !!PAYMENT_ADDRESSES[network] && PAYMENT_ADDRESSES[network] !== "",
      address: PAYMENT_ADDRESSES[network] || null,
    })),
    facilitator: {
      url: process.env.X402_FACILITATOR_URL || null,
      configured: !!process.env.X402_FACILITATOR_URL,
    },
  };
}
