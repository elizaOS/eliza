/** Coordinates verified direct-wallet settlement, crediting, invoicing, and durable sweeping. */
import { ElizaError } from "@elizaos/core";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import Decimal from "decimal.js";
import { and, eq, lte, or, sql } from "drizzle-orm";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  isAddress,
  keccak256,
  parseAbiItem,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc } from "viem/chains";
import { type DbTransaction, dbWrite } from "../../db/client";
import {
  canonicalizeCryptoTransactionHash,
  cryptoTransactionHashesEqual,
  isHexTransactionHash,
} from "../../db/crypto-payment-transaction-hash";
import type { CryptoPayment } from "../../db/repositories/crypto-payments";
import { cryptoPayments } from "../../db/schemas/crypto-payments";
import { cryptoSweepOutbox } from "../../db/schemas/crypto-settlement-outbox";
import type { Bindings } from "../../types/cloud-worker-env";
import { ValidationError } from "../api/cloud-worker-errors";
import { PAYMENT_EXPIRATION_MS, validatePaymentAmount } from "../config/crypto";
import { createCryptoCustomerId, createCryptoInvoiceId } from "../constants/invoice-ids";
import { logger, redact } from "../utils/logger";
import { type BnbPriceQuote, getBnbUsdQuote } from "./bnb-price-oracle";
import { creditsService } from "./credits";
import {
  buildDirectWalletPayerProofMessage,
  buildDirectWalletPayerProofTypedData,
  type DirectWalletPayerProofScheme,
  type DirectWalletPayerProofTypedData,
  type DirectWalletPayerProofTypedDataVerifier,
  payerProofSchemeForNetwork,
  verifyDirectWalletPayerProof,
} from "./direct-wallet-payer-proof";
import { invoicesService } from "./invoices";
import { settlementDigest } from "./settlement-digest";

export type DirectWalletNetwork = "base" | "bsc" | "solana";

export type DirectWalletTokenKind = "native" | "bep20" | "erc20" | "spl";

export interface DirectWalletTokenOption {
  symbol: string;
  kind: DirectWalletTokenKind;
  tokenAddress?: Hex;
  tokenMint?: string;
  decimals: number;
}

export interface DirectWalletNetworkConfig {
  network: DirectWalletNetwork;
  displayName: string;
  chainId?: number;
  // Default token for the network — kept for backward-compat with consumers
  // that read a single token per network. The `tokens` field is the
  // multi-token source of truth for networks that support more than one.
  tokenSymbol: string;
  tokenAddress?: Hex;
  tokenMint?: string;
  tokenDecimals: number;
  tokens: DirectWalletTokenOption[];
  receiveAddress: string | null;
  secureAddress: string | null;
  rpcUrl: string;
  enabled: boolean;
}

export type PublicDirectWalletNetworkConfig = Omit<
  DirectWalletNetworkConfig,
  "rpcUrl" | "secureAddress"
>;

interface CreateDirectPaymentParams {
  organizationId: string;
  userId: string;
  // Wallet on the user's account, if any. OAuth-only users will not have one.
  // No longer used to gate payment — kept for parity logging only.
  accountWalletAddress: string | null;
  payerAddress: string;
  amountUsd: number;
  network: DirectWalletNetwork;
  // Optional token symbol for networks with multiple options (currently BSC:
  // BNB / USDT / USDC / U). Defaults to the network's primary token.
  tokenSymbol?: string;
  promoCode?: "bsc";
}

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BSC_USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
// United Stables ($U) — BEP-20, 18 decimals. Verified via BscScan.
const BSC_U_ADDRESS = "0xcE24439F2D9C6a2289F741120FE202248B666666";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const BSC_TOKEN_OPTIONS: DirectWalletTokenOption[] = [
  { symbol: "BNB", kind: "native", decimals: 18 },
  {
    symbol: "USDT",
    kind: "bep20",
    tokenAddress: getAddress(BSC_USDT_ADDRESS),
    decimals: 18,
  },
  {
    symbol: "U",
    kind: "bep20",
    tokenAddress: getAddress(BSC_U_ADDRESS),
    decimals: 18,
  },
];

/**
 * Slippage tolerance applied to native-token (BNB) verification. The locked
 * quote may move slightly between createPayment and the user broadcasting
 * the tx; we accept up to ±200bps (2%) deviation before rejecting. Stables
 * use 0 — there's no oracle to drift, so units must match exactly.
 */
const NATIVE_SLIPPAGE_BPS = 200;

/**
 * Absolute ceiling on the slippage tolerance we will ever apply on the
 * native-coin verify path. The canonical write path only ever stores
 * {@link NATIVE_SLIPPAGE_BPS} (200) for native payments or 0 for stables, so a
 * value above the native tolerance can only come from DB corruption, a tampered
 * metadata row, or a future non-canonical writer — all of which must FAIL
 * CLOSED (refuse to credit) rather than silently widen the band. In particular,
 * 10_000 bps would make the floor 0 and allow a zero-value native transfer to
 * pass verification.
 */
const MAX_DIRECT_SLIPPAGE_BPS = NATIVE_SLIPPAGE_BPS;

/**
 * Thrown when a stored `slippage_bps` metadata value cannot be trusted to
 * gate the native-coin accepted-payment band. Distinct type so the confirm
 * path can attribute the refusal to a corrupt payment record rather than an
 * on-chain/RPC failure.
 */
export class CorruptDirectWalletSlippageError extends Error {
  constructor(rawValue: unknown) {
    super(
      `Direct wallet payment has an invalid slippage_bps metadata value (${String(
        rawValue,
      )}); refusing to verify the payment band. Please create a new payment.`,
    );
    this.name = "CorruptDirectWalletSlippageError";
  }
}

/**
 * Fail-closed boundary for the native-coin slippage band. The old
 * `Number(metadata.slippage_bps ?? 0)` read fed straight into
 * `BigInt(slippageBps)` and the ceiling/floor math in
 * {@link verifyEvmNativePayment}. Two silent failure modes it left open:
 *   1. a large positive value (corrupt/tampered/drifted row) WIDENS the
 *      accepted band without bound -> a gross over/under-payment is credited,
 *      the exact "silently lose the user money" case the ceiling guards; and
 *   2. a fractional / NaN / Infinity value makes `BigInt(...)` throw deep in
 *      verify, crashing a legit confirm instead of failing intelligibly.
 * This parser accepts only a finite, non-negative integer within
 * [0, {@link MAX_DIRECT_SLIPPAGE_BPS}]; everything else throws
 * {@link CorruptDirectWalletSlippageError}. A missing/undefined value is the
 * legitimate stable-token default of 0.
 */
export function parseDirectWalletSlippageBps(rawValue: unknown): number {
  if (rawValue === undefined || rawValue === null) return 0;
  const numeric = typeof rawValue === "number" ? rawValue : Number(rawValue);
  if (
    !Number.isFinite(numeric) ||
    !Number.isInteger(numeric) ||
    numeric < 0 ||
    numeric > MAX_DIRECT_SLIPPAGE_BPS
  ) {
    throw new CorruptDirectWalletSlippageError(rawValue);
  }
  return numeric;
}

/**
 * Dev-only fallback signing key. Clearly non-secret — production must set
 * `CRYPTO_DIRECT_QUOTE_SIGNING_KEY` explicitly. The helper logs loudly if
 * the fallback is used.
 */
const DEV_FALLBACK_QUOTE_SIGNING_KEY = "dev-only-quote-signing-key-do-not-use-in-production";

function isProductionEnv(env: Bindings): boolean {
  const node = String(env.NODE_ENV ?? "").toLowerCase();
  return node === "production" || node === "prod";
}

function resolveQuoteSigningKey(env: Bindings): string {
  const raw = env.CRYPTO_DIRECT_QUOTE_SIGNING_KEY;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (isProductionEnv(env)) {
    throw new Error(
      "CRYPTO_DIRECT_QUOTE_SIGNING_KEY is not configured — refusing to sign quotes in production",
    );
  }
  logger.warn(
    "[DirectWalletPayments] CRYPTO_DIRECT_QUOTE_SIGNING_KEY missing — using DEV fallback. " +
      "Set this env var for any non-dev environment.",
  );
  return DEV_FALLBACK_QUOTE_SIGNING_KEY;
}

export interface QuoteSignatureInput {
  paymentId: string;
  expectedTokenUnits: bigint | string;
  receiveAddress: string;
  chainId: number | null | undefined;
  tokenAddress: string | null | undefined;
  tokenMint: string | null | undefined;
  expiresAt: Date | string;
}

function canonicalQuoteString(input: QuoteSignatureInput): string {
  const expiresAtIso =
    input.expiresAt instanceof Date
      ? input.expiresAt.toISOString()
      : new Date(input.expiresAt).toISOString();
  const units =
    typeof input.expectedTokenUnits === "bigint"
      ? input.expectedTokenUnits.toString()
      : input.expectedTokenUnits;
  const chain = input.chainId ?? "na";
  const token = input.tokenAddress ?? input.tokenMint ?? "native";
  return `${input.paymentId}|${units}|${input.receiveAddress}|${chain}|${token}|${expiresAtIso}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  // btoa is available in Workers and Node 18+ globals
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * HMAC-SHA256 sign a canonical quote string. Works in Cloudflare Workers
 * (Web Crypto) and Node — no Node `crypto` import.
 */
export async function signQuote(
  env: Bindings,
  input: QuoteSignatureInput,
): Promise<{ signature: string; canonicalInput: string }> {
  const canonicalInput = canonicalQuoteString(input);
  const secret = resolveQuoteSigningKey(env);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(canonicalInput));
  return {
    signature: toBase64Url(new Uint8Array(sigBuf)),
    canonicalInput,
  };
}

export async function verifyQuoteSignature(
  env: Bindings,
  input: QuoteSignatureInput,
  expectedSignature: string,
): Promise<boolean> {
  const { signature } = await signQuote(env, input);
  return timingSafeEqualStrings(signature, expectedSignature);
}

const EXPLORER_BASE: Record<DirectWalletNetwork, string> = {
  base: "https://basescan.org/tx/",
  bsc: "https://bscscan.com/tx/",
  solana: "https://solscan.io/tx/",
};

function buildExplorerUrl(
  network: DirectWalletNetwork | null,
  txHash: string | null,
): string | null {
  if (!network || !txHash) return null;
  return `${EXPLORER_BASE[network]}${txHash}`;
}

function resolveBscToken(symbol: string | undefined): DirectWalletTokenOption {
  if (!symbol) return BSC_TOKEN_OPTIONS[1]; // default USDT
  const match = BSC_TOKEN_OPTIONS.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase());
  if (!match) {
    throw new Error(`Unsupported BSC token: ${symbol}`);
  }
  return match;
}

function envString(env: Bindings, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function solanaRpcUrl(env: Bindings): string {
  const configured = envString(env, "CRYPTO_DIRECT_SOLANA_RPC_URL");
  const heliusApiKey = envString(env, "HELIUS_API_KEY");
  if (heliusApiKey && (!configured || configured.includes("api.mainnet-beta.solana.com"))) {
    return `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
  }
  return (
    configured ??
    envString(env, "SOLANA_RPC_URL") ??
    envString(env, "NEXT_PUBLIC_SOLANA_RPC_URL") ??
    "https://api.mainnet-beta.solana.com"
  );
}

function directPaymentConfig(
  env: Bindings,
  network: DirectWalletNetwork,
): DirectWalletNetworkConfig {
  if (network === "base") {
    const receiveAddress = envString(env, "CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS");
    const secureAddress = envString(env, "CRYPTO_DIRECT_BASE_SECURE_ADDRESS");
    const tokenAddress = envString(env, "CRYPTO_DIRECT_BASE_TOKEN_ADDRESS") ?? BASE_USDC_ADDRESS;
    const decimals = Number(envString(env, "CRYPTO_DIRECT_BASE_TOKEN_DECIMALS") ?? 6);
    return {
      network,
      displayName: "Base",
      chainId: base.id,
      tokenSymbol: "USDC",
      tokenAddress: getAddress(tokenAddress),
      tokenDecimals: decimals,
      tokens: [
        {
          symbol: "USDC",
          kind: "erc20",
          tokenAddress: getAddress(tokenAddress),
          decimals,
        },
      ],
      receiveAddress,
      secureAddress,
      rpcUrl:
        envString(env, "CRYPTO_DIRECT_BASE_RPC_URL") ??
        envString(env, "BASE_RPC_URL") ??
        envString(env, "X402_BASE_RPC_URL") ??
        "https://mainnet.base.org",
      enabled: Boolean(receiveAddress && isAddress(receiveAddress)),
    };
  }

  if (network === "bsc") {
    const receiveAddress = envString(env, "CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS");
    const secureAddress = envString(env, "CRYPTO_DIRECT_BSC_SECURE_ADDRESS");
    // Backward-compatibility: CRYPTO_DIRECT_BSC_TOKEN_ADDRESS overrides the
    // default USDT contract in the tokens list, in case an env has been
    // pointed at a non-standard contract.
    const usdtOverride = envString(env, "CRYPTO_DIRECT_BSC_TOKEN_ADDRESS");
    const tokens: DirectWalletTokenOption[] = usdtOverride
      ? BSC_TOKEN_OPTIONS.map((t) =>
          t.symbol === "USDT" ? { ...t, tokenAddress: getAddress(usdtOverride) } : t,
        )
      : BSC_TOKEN_OPTIONS;
    const defaultToken = tokens.find((t) => t.symbol === "USDT") ?? tokens[0];
    return {
      network,
      displayName: "BNB Smart Chain",
      chainId: bsc.id,
      tokenSymbol: defaultToken.symbol,
      tokenAddress: defaultToken.tokenAddress,
      tokenDecimals: defaultToken.decimals,
      tokens,
      receiveAddress,
      secureAddress,
      rpcUrl:
        envString(env, "CRYPTO_DIRECT_BSC_RPC_URL") ??
        envString(env, "BSC_RPC_URL") ??
        envString(env, "X402_BSC_RPC_URL") ??
        "https://bsc-dataseed.binance.org",
      enabled: Boolean(receiveAddress && isAddress(receiveAddress)),
    };
  }

  const receiveAddress = envString(env, "CRYPTO_DIRECT_SOLANA_RECEIVE_ADDRESS");
  const secureAddress = envString(env, "CRYPTO_DIRECT_SOLANA_SECURE_ADDRESS");
  const mint = envString(env, "CRYPTO_DIRECT_SOLANA_TOKEN_MINT") ?? SOLANA_USDC_MINT;
  const decimals = Number(envString(env, "CRYPTO_DIRECT_SOLANA_TOKEN_DECIMALS") ?? 6);
  return {
    network,
    displayName: "Solana",
    tokenSymbol: "USDC",
    tokenMint: mint,
    tokenDecimals: decimals,
    tokens: [{ symbol: "USDC", kind: "spl", tokenMint: mint, decimals }],
    receiveAddress,
    secureAddress,
    rpcUrl: solanaRpcUrl(env),
    enabled: Boolean(receiveAddress),
  };
}

function disabledDirectPaymentConfig(
  network: DirectWalletNetwork,
  error: unknown,
): DirectWalletNetworkConfig {
  logger.warn("[Direct Crypto Payments] Invalid network config", {
    network,
    error: error instanceof Error ? error.message : String(error),
  });
  if (network === "solana") {
    return {
      network,
      displayName: "Solana",
      tokenSymbol: "USDC",
      tokenMint: SOLANA_USDC_MINT,
      tokenDecimals: 6,
      tokens: [{ symbol: "USDC", kind: "spl", tokenMint: SOLANA_USDC_MINT, decimals: 6 }],
      receiveAddress: null,
      secureAddress: null,
      rpcUrl: "https://api.mainnet-beta.solana.com",
      enabled: false,
    };
  }
  const isBase = network === "base";
  return {
    network,
    displayName: isBase ? "Base" : "BNB Smart Chain",
    chainId: isBase ? base.id : bsc.id,
    tokenSymbol: isBase ? "USDC" : "USDT",
    tokenAddress: getAddress(isBase ? BASE_USDC_ADDRESS : BSC_USDT_ADDRESS),
    tokenDecimals: isBase ? 6 : 18,
    tokens: isBase
      ? [
          {
            symbol: "USDC",
            kind: "erc20",
            tokenAddress: getAddress(BASE_USDC_ADDRESS),
            decimals: 6,
          },
        ]
      : BSC_TOKEN_OPTIONS,
    receiveAddress: null,
    secureAddress: null,
    rpcUrl: isBase ? "https://mainnet.base.org" : "https://bsc-dataseed.binance.org",
    enabled: false,
  };
}

function publicDirectPaymentConfig(
  env: Bindings,
  network: DirectWalletNetwork,
): DirectWalletNetworkConfig {
  try {
    return directPaymentConfig(env, network);
  } catch (error) {
    // error-policy:J4 public configuration exposes this network as disabled.
    return disabledDirectPaymentConfig(network, error);
  }
}

function sanitizeDirectPaymentConfig(
  cfg: DirectWalletNetworkConfig,
): PublicDirectWalletNetworkConfig {
  const { rpcUrl: _rpcUrl, secureAddress: _secureAddress, ...publicConfig } = cfg;
  return publicConfig;
}

function requireConfigured(cfg: DirectWalletNetworkConfig): void {
  if (!cfg.enabled || !cfg.receiveAddress) {
    throw new Error(`${cfg.displayName} direct crypto payments are not configured`);
  }
}

function normalizeEvmAddress(address: string): string {
  if (!isAddress(address)) throw new Error("Invalid EVM wallet address");
  return getAddress(address).toLowerCase();
}

function normalizeSolanaAddress(address: string): string {
  return new PublicKey(address).toBase58();
}

function normalizePayer(network: DirectWalletNetwork, address: string): string {
  return network === "solana" ? normalizeSolanaAddress(address) : normalizeEvmAddress(address);
}

function unitsForUsd(amountUsd: Decimal, decimals: number): bigint {
  return BigInt(amountUsd.mul(new Decimal(10).pow(decimals)).toFixed(0));
}

function formatUnitsAsTokenAmount(units: bigint, decimals: number): string {
  const baseUnits = new Decimal(10).pow(decimals);
  return new Decimal(units.toString()).div(baseUnits).toFixed(decimals);
}

function metadataOf(payment: CryptoPayment): Record<string, unknown> {
  return payment.metadata && typeof payment.metadata === "object" ? payment.metadata : {};
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function payerProofTypedDataOf(
  metadata: Record<string, unknown>,
): DirectWalletPayerProofTypedData | null {
  const typedData = objectOf(metadata.payer_proof_typed_data);
  const domain = objectOf(typedData?.domain);
  const message = objectOf(typedData?.message);
  if (!typedData || !domain || !message) return null;
  if (
    domain.name !== "Eliza Cloud Direct Wallet" ||
    domain.version !== "1" ||
    typedData.primaryType !== "DirectWalletPayment"
  ) {
    return null;
  }
  const network = message.network;
  if (network !== "base" && network !== "bsc") return null;
  const chainId = Number(domain.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  const payerAddress = String(message.payerAddress ?? "");
  const receiveAddress = String(message.receiveAddress ?? "");
  if (!isAddress(payerAddress) || !isAddress(receiveAddress)) return null;
  return {
    domain: {
      name: "Eliza Cloud Direct Wallet",
      version: "1",
      chainId,
    },
    types: {
      DirectWalletPayment: [
        { name: "paymentId", type: "string" },
        { name: "organizationId", type: "string" },
        { name: "userId", type: "string" },
        { name: "network", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "payerAddress", type: "address" },
        { name: "receiveAddress", type: "address" },
        { name: "tokenSymbol", type: "string" },
        { name: "tokenReference", type: "string" },
        { name: "amountUnits", type: "uint256" },
        { name: "nonce", type: "string" },
        { name: "expiresAt", type: "string" },
      ],
    },
    primaryType: "DirectWalletPayment",
    message: {
      paymentId: String(message.paymentId ?? ""),
      organizationId: String(message.organizationId ?? ""),
      userId: String(message.userId ?? ""),
      network,
      chainId: String(message.chainId ?? ""),
      payerAddress: getAddress(payerAddress),
      receiveAddress: getAddress(receiveAddress),
      tokenSymbol: String(message.tokenSymbol ?? ""),
      tokenReference: String(message.tokenReference ?? ""),
      amountUnits: String(message.amountUnits ?? ""),
      nonce: String(message.nonce ?? ""),
      expiresAt: String(message.expiresAt ?? ""),
    },
  };
}

export function parseDirectWalletMetadataNumber(params: {
  paymentId: string;
  field: string;
  value: unknown;
  defaultValue?: number;
  integer?: boolean;
  max?: number;
}): number {
  const value = params.value ?? params.defaultValue;
  const parsed =
    (typeof value === "number" || typeof value === "string") && String(value).trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    (params.integer && !Number.isInteger(parsed)) ||
    (params.max !== undefined && parsed > params.max)
  ) {
    throw new ElizaError("Direct wallet payment has corrupt numeric metadata", {
      code: "DIRECT_WALLET_CORRUPT_NUMERIC_METADATA",
      context: { paymentId: params.paymentId, field: params.field },
      severity: "fatal",
    });
  }
  return parsed;
}

function directMetadata(payment: CryptoPayment): {
  metadata: Record<string, unknown>;
  network: DirectWalletNetwork;
  payerAddress: string;
  tokenSymbol: string;
  tokenKind: DirectWalletTokenKind;
  tokenAddress: Hex | null;
  tokenMint: string | null;
  tokenDecimals: number;
  expectedTokenUnits: bigint;
  bonusCredits: number;
  slippageBps: number;
  payerProofMessage: string;
  payerProofTypedData: DirectWalletPayerProofTypedData | null;
  payerProofScheme: DirectWalletPayerProofScheme;
  payerProofExpiresAt: string;
} {
  const metadata = metadataOf(payment);
  if (metadata.kind !== "direct_wallet_credit_purchase") {
    throw new Error("Payment is not a direct wallet payment");
  }
  const network = metadata.direct_network;
  if (network !== "base" && network !== "bsc" && network !== "solana") {
    throw new Error("Payment has invalid direct network metadata");
  }
  const rawTokenKind = String(metadata.token_kind ?? "");
  const tokenKind: DirectWalletTokenKind =
    rawTokenKind === "native" ||
    rawTokenKind === "bep20" ||
    rawTokenKind === "erc20" ||
    rawTokenKind === "spl"
      ? rawTokenKind
      : network === "solana"
        ? "spl"
        : network === "base"
          ? "erc20"
          : "bep20";
  const rawTokenAddress = metadata.token_address;
  return {
    metadata,
    network,
    payerAddress: String(metadata.payer_wallet_address ?? ""),
    tokenSymbol: String(metadata.token_symbol ?? ""),
    tokenKind,
    tokenAddress:
      typeof rawTokenAddress === "string" && rawTokenAddress.startsWith("0x")
        ? (rawTokenAddress as Hex)
        : null,
    tokenMint: typeof metadata.token_mint === "string" ? metadata.token_mint : null,
    tokenDecimals: parseDirectWalletMetadataNumber({
      paymentId: payment.id,
      field: "token_decimals",
      value: metadata.token_decimals,
      integer: true,
      max: 255,
    }),
    expectedTokenUnits: BigInt(String(metadata.expected_token_units ?? "0")),
    bonusCredits: parseDirectWalletMetadataNumber({
      paymentId: payment.id,
      field: "bonus_credits",
      value: metadata.bonus_credits,
      defaultValue: 0,
    }),
    slippageBps: parseDirectWalletSlippageBps(metadata.slippage_bps),
    payerProofMessage: String(metadata.payer_proof_message ?? ""),
    payerProofTypedData: payerProofTypedDataOf(metadata),
    payerProofScheme:
      metadata.payer_proof_scheme === "solana-ed25519"
        ? "solana-ed25519"
        : payerProofSchemeForNetwork(network),
    payerProofExpiresAt: String(metadata.payer_proof_expires_at ?? ""),
  };
}

function evmPayerProofVerifier(
  cfg: DirectWalletNetworkConfig,
): DirectWalletPayerProofTypedDataVerifier {
  const client = createPublicClient({
    chain: cfg.network === "base" ? base : bsc,
    transport: http(cfg.rpcUrl),
  });
  return async (params) => await client.verifyTypedData(params);
}

/**
 * Distinct, greppable marker for payments created before the current
 * payer-proof challenge shipped. Such rows lack `payer_proof_message` (or,
 * for EVM, `payer_proof_typed_data`) in metadata, so they can never pass
 * verification — attach/confirm fail closed with this code so ops can
 * identify orphaned legacy deposits and reconcile them manually (verify the
 * on-chain sender by hand, then credit via admin tooling).
 */
export const LEGACY_PAYMENT_MISSING_PAYER_PROOF = "LEGACY_PAYMENT_MISSING_PAYER_PROOF";

function throwLegacyPaymentMissingProof(params: {
  paymentId: string;
  network: DirectWalletNetwork;
  missing: "challenge" | "typed-data";
}): never {
  logger.error(
    "[DirectWalletPayments] Payment predates the payer-proof challenge — failing closed. " +
      "Legacy deposit must be reconciled manually.",
    {
      code: LEGACY_PAYMENT_MISSING_PAYER_PROOF,
      paymentId: redact.paymentId(params.paymentId),
      network: params.network,
      missing: params.missing,
    },
  );
  throw new Error(
    `${LEGACY_PAYMENT_MISSING_PAYER_PROOF}: this payment was created before the current ` +
      "payer-proof challenge existed and cannot be verified automatically. Create a new " +
      "payment; the legacy deposit must be reconciled manually by support.",
  );
}

async function verifyPayerProofOrThrow(params: {
  paymentId: string;
  direct: ReturnType<typeof directMetadata>;
  signature: string | undefined;
  cfg?: DirectWalletNetworkConfig;
}): Promise<Record<string, unknown> | null> {
  const { direct, signature, cfg } = params;
  if (
    typeof direct.metadata.payer_proof_verified_at === "string" &&
    typeof direct.metadata.payer_proof_address === "string"
  ) {
    if (
      direct.metadata.payer_proof_address === normalizePayer(direct.network, direct.payerAddress) &&
      direct.metadata.payer_proof_scheme === direct.payerProofScheme
    ) {
      return null;
    }
    throw new Error("Payer wallet proof metadata mismatch");
  }
  if (!direct.payerProofMessage) {
    throwLegacyPaymentMissingProof({
      paymentId: params.paymentId,
      network: direct.network,
      missing: "challenge",
    });
  }
  if (direct.network !== "solana" && !direct.payerProofTypedData) {
    // Rows from the short-lived personal-sign era carry a message but no
    // EIP-712 payload uses the same compatibility shape and manual-reconcile path.
    throwLegacyPaymentMissingProof({
      paymentId: params.paymentId,
      network: direct.network,
      missing: "typed-data",
    });
  }
  if (!signature?.trim()) {
    throw ValidationError("Payer wallet signature required");
  }
  const proofExpiryMs = Date.parse(direct.payerProofExpiresAt);
  if (Number.isFinite(proofExpiryMs) && proofExpiryMs < Date.now()) {
    throw ValidationError("Payer wallet signature challenge expired");
  }

  if (direct.network !== "solana" && !cfg) {
    throw new Error("Payer wallet EIP-712 verifier unavailable");
  }

  const valid = await verifyDirectWalletPayerProof({
    network: direct.network,
    payerAddress: direct.payerAddress,
    message: direct.payerProofMessage,
    typedData: direct.payerProofTypedData ?? undefined,
    signature: signature.trim(),
    verifyEvmTypedData:
      direct.network === "solana" || !cfg ? undefined : evmPayerProofVerifier(cfg),
  });
  if (!valid) {
    throw ValidationError("Invalid payer wallet signature");
  }

  return {
    payer_proof_verified_at: new Date().toISOString(),
    payer_proof_address: normalizePayer(direct.network, direct.payerAddress),
    payer_proof_scheme: direct.payerProofScheme,
    payer_proof_nonce_burned_at: new Date().toISOString(),
  };
}

async function verifyEvmTokenPayment(params: {
  cfg: DirectWalletNetworkConfig;
  tokenAddress: Hex;
  payerAddress: string;
  txHash: string;
  expectedUnits: bigint;
}): Promise<{ blockNumber: string; receivedUnits: bigint }> {
  if (!params.cfg.chainId || !params.cfg.receiveAddress) {
    throw new Error("Invalid EVM direct payment configuration");
  }

  const client = createPublicClient({
    chain: params.cfg.network === "base" ? base : bsc,
    transport: http(params.cfg.rpcUrl),
  });
  const receipt = await client.getTransactionReceipt({
    hash: params.txHash as Hex,
  });
  if (receipt.status !== "success") throw new Error("Transaction failed");

  // The authoritative payer binding for token payments is the Transfer event:
  // the configured token contract must have emitted Transfer(payer →
  // treasury) for at least the expected amount. We deliberately do NOT
  // require tx.from == payer or tx.to == tokenAddress here — for a Safe
  // execTransaction tx.from is the relayer and tx.to is the Safe, and for an
  // ERC-4337 op tx.from is the bundler and tx.to is the EntryPoint. The
  // event's `from` is the account whose balance decreased, which is exactly
  // the proven payer wallet, regardless of who carried the transaction.
  const receiveAddress = normalizeEvmAddress(params.cfg.receiveAddress);
  const payerAddress = normalizeEvmAddress(params.payerAddress);
  const tokenAddressLc = params.tokenAddress.toLowerCase();
  const events = parseEventLogs({
    abi: [TRANSFER_EVENT],
    logs: receipt.logs,
    strict: false,
  });
  const receivedUnits = events.reduce((total, event) => {
    if (!event.args.from || !event.args.to || event.args.value === undefined) {
      return total;
    }
    if (
      event.address.toLowerCase() === tokenAddressLc &&
      event.args.from.toLowerCase() === payerAddress &&
      event.args.to.toLowerCase() === receiveAddress
    ) {
      return total + event.args.value;
    }
    return total;
  }, 0n);

  if (receivedUnits < params.expectedUnits) {
    throw new Error("Transaction amount is lower than the expected payment");
  }

  return { blockNumber: receipt.blockNumber.toString(), receivedUnits };
}

async function verifyEvmNativePayment(params: {
  cfg: DirectWalletNetworkConfig;
  payerAddress: string;
  txHash: string;
  expectedUnits: bigint;
  slippageBps?: number;
}): Promise<{ blockNumber: string; receivedUnits: bigint }> {
  if (!params.cfg.chainId || !params.cfg.receiveAddress) {
    throw new Error("Invalid EVM direct payment configuration");
  }
  const client = createPublicClient({
    chain: params.cfg.network === "base" ? base : bsc,
    transport: http(params.cfg.rpcUrl),
  });
  const receipt = await client.getTransactionReceipt({
    hash: params.txHash as Hex,
  });
  if (receipt.status !== "success") throw new Error("Transaction failed");

  // Native value transfers carry no Transfer event, so the ONLY on-chain
  // payer binding available without trace APIs is tx.from. Require it to be
  // the proven payer wallet — otherwise the payer proof proves nothing: an
  // attacker could sign the challenge with their own key and attach someone
  // else's native deposit of matching value (the #10903 theft, re-opened).
  //
  // Consequence (deliberate, fail-closed): contract-wallet native transfers
  // are NOT creditable on this path. A Safe/4337 native send has tx.from =
  // relayer/bundler and tx.to = Safe/EntryPoint, so the value source cannot
  // be bound to the proven payer from the outer transaction alone. Contract
  // wallets must pay via the token path, where the Transfer event binds the
  // value source, or use an exchange/deposit-address flow if one ships
  // later. CEX hot-wallet withdrawals are rejected for the same reason —
  // the sender is not the proven payer.
  const tx = await client.getTransaction({ hash: params.txHash as Hex });
  if (tx.from.toLowerCase() !== normalizeEvmAddress(params.payerAddress)) {
    throw new Error(
      "Transaction sender does not match the proven payer wallet. Native-coin payments must " +
        "be sent directly from the wallet that signed the payment challenge — smart-contract " +
        "wallets and exchange withdrawals are not supported for native transfers; pay with a " +
        "token (USDT/USDC) instead.",
    );
  }
  if (!tx.to || tx.to.toLowerCase() !== normalizeEvmAddress(params.cfg.receiveAddress)) {
    throw new Error("Transaction recipient does not match the receive address");
  }
  // Apply slippage tolerance to BOTH floor and ceiling for native-token
  // payments. The locked quote may drift between createPayment and broadcast,
  // so we accept tx.value in [expected*(1-bps), expected*(1+bps)]. The
  // ceiling protects against accidental gross overpayments — e.g. a user
  // typoing 10 BNB instead of 0.01 BNB. Credits are locked at create time
  // (payment.credits_to_add), so an unbounded overpayment would silently
  // lose the user money with no extra credit. Better to reject and force a
  // fresh quote. For stables (slippageBps=0), tx.value must equal
  // expectedUnits exactly.
  const slippageBps = BigInt(params.slippageBps ?? 0);
  const floor =
    slippageBps > 0n
      ? (params.expectedUnits * (10_000n - slippageBps)) / 10_000n
      : params.expectedUnits;
  const ceiling =
    slippageBps > 0n
      ? (params.expectedUnits * (10_000n + slippageBps)) / 10_000n
      : params.expectedUnits;
  if (tx.value < floor) {
    throw new Error(
      `Transaction amount ${tx.value} is below the expected floor ${floor} (expected ${params.expectedUnits}, slippage ${slippageBps} bps)`,
    );
  }
  if (tx.value > ceiling) {
    throw new Error(
      `Transaction amount ${tx.value} is above the expected ceiling ${ceiling} (expected ${params.expectedUnits}, slippage ${slippageBps} bps). Refusing to credit a gross overpayment — please request a refund or create a new payment.`,
    );
  }
  return {
    blockNumber: receipt.blockNumber.toString(),
    receivedUnits: tx.value,
  };
}

async function verifySolanaTokenPayment(params: {
  cfg: DirectWalletNetworkConfig;
  payerAddress: string;
  txHash: string;
  expectedUnits: bigint;
}): Promise<{ blockNumber: string; receivedUnits: bigint }> {
  if (!params.cfg.tokenMint || !params.cfg.receiveAddress) {
    throw new Error("Invalid Solana direct payment configuration");
  }

  const connection = new Connection(params.cfg.rpcUrl, "confirmed");
  let tx = await connection.getParsedTransaction(params.txHash, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  for (let attempt = 0; !tx && attempt < 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    tx = await connection.getParsedTransaction(params.txHash, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  }
  if (!tx) {
    // Not on chain from this RPC's view — mempool propagation, a lagging
    // node, or a dropped tx. Phrased to match the cron's not-found
    // classification so it retries (and only fails after the retry budget)
    // instead of terminally failing a possibly-paid deposit on attempt 1.
    throw new Error("Transaction not found on Solana — it may not be confirmed yet");
  }
  if (!tx.meta) {
    // The RPC returned the tx without meta, so balances can't be verified
    // yet. Deliberately does NOT match the not-found bucket: a persistently
    // meta-less tx exists on chain and must keep retrying, not be declared
    // dropped.
    throw new Error("Transaction metadata unavailable from RPC");
  }
  if (tx.meta.err) {
    // On chain and failed — deterministic and terminal.
    throw new Error("Transaction was not confirmed successfully");
  }

  const mint = params.cfg.tokenMint;
  const receiver = normalizeSolanaAddress(params.cfg.receiveAddress);
  const payer = normalizeSolanaAddress(params.payerAddress);

  // Independently verify that the receiving ATA's on-chain owner field is the
  // configured treasury wallet. This is additive to the token-delta check
  // below: it guards against `cfg.receiveAddress` being misconfigured to a
  // wallet whose derived ATA is somehow controlled by a different account.
  const receiverPubkey = new PublicKey(receiver);
  const mintPubkey = new PublicKey(mint);
  const receiverAta = getAssociatedTokenAddressSync(mintPubkey, receiverPubkey);
  const receiverAtaAccount = await getAccount(connection, receiverAta);
  if (receiverAtaAccount.owner.toBase58() !== receiverPubkey.toBase58()) {
    logger.error("[DirectWalletPayments] Receiving ATA owner mismatch", {
      expectedOwner: receiverPubkey.toBase58(),
      actualOwner: receiverAtaAccount.owner.toBase58(),
      ata: receiverAta.toBase58(),
      mint,
    });
    throw new Error("Receiving ATA owner does not match configured treasury wallet");
  }

  const before = new Map<string, bigint>();
  for (const bal of tx.meta.preTokenBalances ?? []) {
    if (bal.mint === mint && bal.owner) {
      before.set(bal.owner, BigInt(bal.uiTokenAmount.amount));
    }
  }
  const after = new Map<string, bigint>();
  for (const bal of tx.meta.postTokenBalances ?? []) {
    if (bal.mint === mint && bal.owner) {
      after.set(bal.owner, BigInt(bal.uiTokenAmount.amount));
    }
  }

  const receiverDelta = (after.get(receiver) ?? 0n) - (before.get(receiver) ?? 0n);
  const payerDelta = (after.get(payer) ?? 0n) - (before.get(payer) ?? 0n);

  if (receiverDelta < params.expectedUnits || payerDelta > -params.expectedUnits) {
    throw new Error("Transaction does not transfer enough USDC from the account wallet");
  }

  return {
    blockNumber: String(tx.slot),
    receivedUnits: receiverDelta,
  };
}

function evmPrivateKey(env: Bindings, network: DirectWalletNetwork): Hex | null {
  const key =
    envString(env, `CRYPTO_DIRECT_${network.toUpperCase()}_PRIVATE_KEY`) ??
    envString(env, "CRYPTO_DIRECT_EVM_PRIVATE_KEY");
  if (!key) return null;
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

type PreparedSweepMetadata =
  | {
      network: "base" | "bsc";
      sweepTo: string;
      nonce: string;
    }
  | {
      network: "solana";
      sweepTo: string;
      blockhash: string;
      lastValidBlockHeight: number;
    };

interface PreparedSweep {
  rawTransaction: string;
  transactionHash: string;
  metadata: PreparedSweepMetadata;
}

async function prepareEvmSweep(params: {
  env: Bindings;
  cfg: DirectWalletNetworkConfig;
  tokenAddress: Hex | null;
  tokenDecimals: number;
  units: bigint;
  sweepTo: string;
}): Promise<PreparedSweep | null> {
  if (!params.tokenAddress) return null;
  const privateKey = evmPrivateKey(params.env, params.cfg.network);
  if (!privateKey) return null;

  const account = privateKeyToAccount(privateKey);
  if (
    !params.cfg.receiveAddress ||
    normalizeEvmAddress(account.address) !== normalizeEvmAddress(params.cfg.receiveAddress)
  ) {
    throw new Error("Configured EVM sweep key does not match the receive wallet");
  }
  const wallet = createWalletClient({
    account,
    chain: params.cfg.network === "base" ? base : bsc,
    transport: http(params.cfg.rpcUrl),
  });
  const request = await wallet.prepareTransactionRequest({
    to: params.tokenAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(params.sweepTo), params.units],
    }),
  });
  if (request.nonce === undefined) {
    throw new Error("Prepared EVM sweep is missing its explicit nonce");
  }
  const rawTransaction = await account.signTransaction(
    request as Parameters<typeof account.signTransaction>[0],
  );
  return {
    rawTransaction,
    transactionHash: keccak256(rawTransaction),
    metadata: {
      network: params.cfg.network === "base" ? "base" : "bsc",
      sweepTo: params.sweepTo,
      nonce: String(request.nonce),
    },
  };
}

async function submitPreparedEvmSweep(
  cfg: DirectWalletNetworkConfig,
  prepared: PreparedSweep,
): Promise<void> {
  const client = createPublicClient({
    chain: cfg.network === "base" ? base : bsc,
    transport: http(cfg.rpcUrl),
  });
  try {
    const existing = await client.getTransaction({
      hash: prepared.transactionHash as Hex,
    });
    if (existing.hash.toLowerCase() === prepared.transactionHash.toLowerCase()) return;
  } catch {
    // error-policy:J4 Absence or a transient lookup error is safe because the
    // dispatcher resends the exact same signed bytes and therefore the same hash.
  }
  const submitted = await client.sendRawTransaction({
    serializedTransaction: prepared.rawTransaction as Hex,
  });
  if (submitted.toLowerCase() !== prepared.transactionHash.toLowerCase()) {
    throw new Error("EVM provider returned a different sweep transaction hash");
  }
}

function solanaKeypairFromEnv(env: Bindings): Keypair | null {
  const raw = envString(env, "CRYPTO_DIRECT_SOLANA_PRIVATE_KEY");
  if (!raw) return null;
  if (raw.trim().startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function prepareSolanaSweep(params: {
  env: Bindings;
  cfg: DirectWalletNetworkConfig;
  units: bigint;
  sweepTo: string;
  tokenMint: string;
  tokenDecimals: number;
}): Promise<PreparedSweep | null> {
  const payer = solanaKeypairFromEnv(params.env);
  if (!payer) return null;
  if (
    !params.cfg.receiveAddress ||
    payer.publicKey.toBase58() !== normalizeSolanaAddress(params.cfg.receiveAddress)
  ) {
    throw new Error("Configured Solana sweep key does not match the receive wallet");
  }

  const connection = new Connection(params.cfg.rpcUrl, "confirmed");
  const mint = new PublicKey(params.tokenMint);
  const fromAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const secureOwner = new PublicKey(params.sweepTo);
  const toAta = getAssociatedTokenAddressSync(mint, secureOwner);
  const tx = new Transaction();
  const toInfo = await connection.getAccountInfo(toAta);
  if (!toInfo) {
    tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, toAta, secureOwner, mint));
  }
  tx.add(
    createTransferCheckedInstruction(
      fromAta,
      mint,
      toAta,
      payer.publicKey,
      params.units,
      params.tokenDecimals,
    ),
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  if (!tx.signature) throw new Error("Solana sweep transaction has no signature");
  return {
    rawTransaction: bytesToBase64(tx.serialize()),
    transactionHash: bs58.encode(tx.signature),
    metadata: {
      network: "solana",
      sweepTo: params.sweepTo,
      blockhash,
      lastValidBlockHeight,
    },
  };
}

export type SolanaSweepRecovery = "landed" | "resend" | "reprepare";

export function classifySolanaSweepRecovery(params: {
  signatureStatus: { err: unknown } | null;
  currentBlockHeight: number;
  lastValidBlockHeight: number;
}): SolanaSweepRecovery {
  if (params.signatureStatus) {
    if (params.signatureStatus.err) {
      throw new Error("Solana sweep transaction failed on chain");
    }
    return "landed";
  }
  return params.currentBlockHeight > params.lastValidBlockHeight ? "reprepare" : "resend";
}

async function submitPreparedSolanaSweep(
  cfg: DirectWalletNetworkConfig,
  prepared: PreparedSweep,
): Promise<"landed" | "reprepare"> {
  if (prepared.metadata.network !== "solana") {
    throw new Error("Prepared Solana sweep metadata is invalid");
  }
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const existing = await connection.getSignatureStatus(prepared.transactionHash, {
    searchTransactionHistory: true,
  });
  if (existing.value) {
    const recovery = classifySolanaSweepRecovery({
      signatureStatus: existing.value,
      currentBlockHeight: 0,
      lastValidBlockHeight: prepared.metadata.lastValidBlockHeight,
    });
    if (recovery !== "landed") throw new Error("Solana signature status is inconsistent");
    return "landed";
  }
  const recovery = classifySolanaSweepRecovery({
    signatureStatus: null,
    currentBlockHeight: await connection.getBlockHeight("confirmed"),
    lastValidBlockHeight: prepared.metadata.lastValidBlockHeight,
  });
  if (recovery === "landed") return "landed";
  if (recovery === "reprepare") return "reprepare";
  const submitted = await connection.sendRawTransaction(base64ToBytes(prepared.rawTransaction), {
    maxRetries: 0,
    skipPreflight: false,
  });
  if (submitted !== prepared.transactionHash) {
    throw new Error("Solana provider returned a different sweep transaction signature");
  }
  await connection.confirmTransaction(
    {
      signature: submitted,
      blockhash: prepared.metadata.blockhash,
      lastValidBlockHeight: prepared.metadata.lastValidBlockHeight,
    },
    "confirmed",
  );
  return "landed";
}

interface DirectSweepPayload {
  paymentId: string;
  network: DirectWalletNetwork;
  tokenKind: DirectWalletTokenKind;
  tokenAddress: Hex | null;
  tokenMint: string | null;
  tokenDecimals: number;
  receivedUnits: string;
  sweepTo: string | null;
}

function directSweepPayload(value: unknown): DirectSweepPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Crypto sweep outbox payload is not an object");
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.paymentId !== "string" ||
    (payload.network !== "base" && payload.network !== "bsc" && payload.network !== "solana") ||
    (payload.tokenKind !== "native" &&
      payload.tokenKind !== "bep20" &&
      payload.tokenKind !== "erc20" &&
      payload.tokenKind !== "spl") ||
    (payload.tokenAddress !== null && typeof payload.tokenAddress !== "string") ||
    (payload.tokenMint !== null && typeof payload.tokenMint !== "string") ||
    typeof payload.tokenDecimals !== "number" ||
    !Number.isInteger(payload.tokenDecimals) ||
    typeof payload.receivedUnits !== "string" ||
    !/^\d+$/.test(payload.receivedUnits) ||
    (payload.sweepTo !== null && typeof payload.sweepTo !== "string")
  ) {
    throw new Error("Crypto sweep outbox payload is malformed");
  }
  return payload as unknown as DirectSweepPayload;
}

function preparedSweepFromRow(value: {
  prepared_transaction: string | null;
  sweep_transaction_hash: string | null;
  prepared_metadata: Record<string, unknown> | null;
}): PreparedSweep | null {
  if (
    value.prepared_transaction === null &&
    value.sweep_transaction_hash === null &&
    value.prepared_metadata === null
  ) {
    return null;
  }
  const metadata = value.prepared_metadata;
  if (
    !value.prepared_transaction ||
    !value.sweep_transaction_hash ||
    !metadata ||
    typeof metadata.sweepTo !== "string"
  ) {
    throw new Error("Prepared crypto sweep row is incomplete");
  }
  if (
    (metadata.network === "base" || metadata.network === "bsc") &&
    typeof metadata.nonce === "string"
  ) {
    return {
      rawTransaction: value.prepared_transaction,
      transactionHash: value.sweep_transaction_hash,
      metadata: {
        network: metadata.network,
        sweepTo: metadata.sweepTo,
        nonce: metadata.nonce,
      },
    };
  }
  if (
    metadata.network === "solana" &&
    typeof metadata.blockhash === "string" &&
    typeof metadata.lastValidBlockHeight === "number" &&
    Number.isSafeInteger(metadata.lastValidBlockHeight)
  ) {
    return {
      rawTransaction: value.prepared_transaction,
      transactionHash: value.sweep_transaction_hash,
      metadata: {
        network: "solana",
        sweepTo: metadata.sweepTo,
        blockhash: metadata.blockhash,
        lastValidBlockHeight: metadata.lastValidBlockHeight,
      },
    };
  }
  throw new Error("Prepared crypto sweep metadata is malformed");
}

function directPaymentSettlementDigest(payment: CryptoPayment): string {
  const direct = directMetadata(payment);
  return settlementDigest({
    id: payment.id,
    organizationId: payment.organization_id,
    userId: payment.user_id,
    expectedAmount: payment.expected_amount,
    creditsToAdd: payment.credits_to_add,
    expiresAt: payment.expires_at,
    network: direct.network,
    tokenKind: direct.tokenKind,
    tokenAddress: direct.tokenAddress,
    tokenMint: direct.tokenMint,
    tokenDecimals: direct.tokenDecimals,
    expectedTokenUnits: direct.expectedTokenUnits.toString(),
    payerAddress: direct.payerAddress,
    quoteSignature: direct.metadata.quote_signature,
  });
}

async function enqueueDirectSweep(
  transaction: DbTransaction,
  payload: DirectSweepPayload,
): Promise<void> {
  if (payload.tokenKind === "native") return;
  const digest = settlementDigest(payload);
  const [inserted] = await transaction
    .insert(cryptoSweepOutbox)
    .values({ payment_id: payload.paymentId, payload: { ...payload }, payload_digest: digest })
    .onConflictDoNothing({ target: cryptoSweepOutbox.payment_id })
    .returning();
  if (inserted) return;
  const [existing] = await transaction
    .select()
    .from(cryptoSweepOutbox)
    .where(eq(cryptoSweepOutbox.payment_id, payload.paymentId))
    .limit(1);
  if (!existing || existing.payload_digest !== digest) {
    throw new Error("Crypto sweep replay does not match the committed sweep intent");
  }
}

function directInvoiceSettlement(
  payment: CryptoPayment,
  direct: ReturnType<typeof directMetadata>,
  transactionHash: string,
) {
  const amountPaid = new Decimal(payment.expected_amount).toDecimalPlaces(2).toFixed(2);
  const creditsAdded = new Decimal(payment.credits_to_add).toDecimalPlaces(2).toFixed(2);
  return {
    organization_id: payment.organization_id,
    stripe_invoice_id: createCryptoInvoiceId(payment.id),
    stripe_customer_id: createCryptoCustomerId(payment.organization_id),
    stripe_payment_intent_id: transactionHash,
    amount_due: amountPaid,
    amount_paid: amountPaid,
    currency: "usd",
    status: "paid",
    invoice_type: "crypto_payment",
    credits_added: creditsAdded,
    metadata: {
      payment_method: "crypto",
      provider: "wallet_native",
      network: direct.network,
      token: direct.tokenSymbol,
      transaction_hash: transactionHash,
      bonus_credits: direct.bonusCredits,
    },
  } as const;
}

export class DirectWalletPaymentsService {
  getConfig(env: Bindings) {
    const networks = (["base", "bsc", "solana"] as const).map((network) =>
      publicDirectPaymentConfig(env, network),
    );
    return {
      enabled: networks.some((network) => network.enabled),
      networks: networks.map(sanitizeDirectPaymentConfig),
      promotion: {
        code: "bsc",
        network: "bsc",
        minimumUsd: 10,
        bonusCredits: 5,
      },
    };
  }

  async createPayment(env: Bindings, params: CreateDirectPaymentParams) {
    const cfg = directPaymentConfig(env, params.network);
    requireConfigured(cfg);
    // The payer wallet does NOT need to match the account wallet. Credits land
    // on organization_id from the authenticated session, and the verified
    // on-chain `from` address is recorded as `payer_wallet_address` for audit.
    // This lets OAuth-only users pay from any EVM wallet they hold.

    // Resolve which token on the network this purchase is using. Networks
    // with a single token (Base USDC, Solana USDC) ignore the param.
    const selectedToken: DirectWalletTokenOption =
      params.network === "bsc" ? resolveBscToken(params.tokenSymbol) : cfg.tokens[0];

    const amount = new Decimal(params.amountUsd);
    const validation = validatePaymentAmount(amount);
    if (!validation.valid) throw new Error(validation.error ?? "Invalid amount");

    const promoRequested =
      params.promoCode === "bsc" && params.network === "bsc" && amount.greaterThanOrEqualTo(10);
    const promoApplies = promoRequested;
    const bonusCredits = promoApplies ? 5 : 0;
    const creditsToAdd = amount.plus(bonusCredits);

    // Native BNB pricing: dollars are not tokens, so we quote the live
    // BNB/USD price from Chainlink (with CoinGecko fallback) and lock it
    // into the expected wei amount. Stables (USDT/USDC/$U) are 1:1 with USD
    // by definition, so amount_usd × 10^decimals is correct without an
    // oracle.
    let priceQuote: BnbPriceQuote | null = null;
    let expectedTokenUnits: bigint;
    if (params.network === "bsc" && selectedToken.kind === "native") {
      priceQuote = await getBnbUsdQuote();
      const bnbAmount = amount.div(priceQuote.priceUsd);
      expectedTokenUnits = BigInt(
        bnbAmount.mul(new Decimal(10).pow(selectedToken.decimals)).toFixed(0),
      );
    } else {
      expectedTokenUnits = unitsForUsd(amount, selectedToken.decimals);
    }

    const now = new Date();

    const payment = await dbWrite.transaction(async (tx) => {
      // Duplicate-redemption guard: the one-time BSC promo bonus must only ever
      // be granted once per organization. Serialize concurrent attempts with a
      // per-org advisory lock, then reject if any prior promo payment already
      // exists in a non-terminal/successful state. 'broadcast' is included
      // because such a payment is in-flight and will settle to 'confirmed' —
      // omitting it would leave a window for a second bonus.
      if (promoRequested) {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtext(${"crypto_direct_bsc_promo:" + params.organizationId}))
        `);
        const existingPromo = await tx
          .select({ id: cryptoPayments.id })
          .from(cryptoPayments)
          .where(sql`
            ${cryptoPayments.organization_id} = ${params.organizationId}
            AND ${cryptoPayments.status} IN ('pending', 'broadcast', 'confirmed')
            AND ${cryptoPayments.metadata}->>'kind' = 'direct_wallet_credit_purchase'
            AND ${cryptoPayments.metadata}->>'promo_code' = 'bsc'
          `)
          .limit(1);
        if (existingPromo.length > 0) {
          throw new Error("BSC promotion has already been redeemed for this organization");
        }
      }

      const [created] = await tx
        .insert(cryptoPayments)
        .values({
          organization_id: params.organizationId,
          user_id: params.userId,
          payment_address: cfg.receiveAddress ?? "",
          token_address: selectedToken.tokenAddress ?? selectedToken.tokenMint ?? null,
          token: selectedToken.symbol,
          network: cfg.displayName,
          expected_amount: amount.toFixed(2),
          credits_to_add: creditsToAdd.toFixed(2),
          status: "pending",
          created_at: now,
          updated_at: now,
          expires_at: new Date(now.getTime() + PAYMENT_EXPIRATION_MS),
          metadata: {
            kind: "direct_wallet_credit_purchase",
            provider: "wallet_native",
            direct_network: params.network,
            chain_id: cfg.chainId,
            payer_wallet_address: normalizePayer(params.network, params.payerAddress),
            receive_address: cfg.receiveAddress,
            secure_address_configured: Boolean(cfg.secureAddress),
            token_symbol: selectedToken.symbol,
            token_kind: selectedToken.kind,
            token_address: selectedToken.tokenAddress ?? null,
            token_mint: selectedToken.tokenMint ?? null,
            token_decimals: selectedToken.decimals,
            expected_token_units: expectedTokenUnits.toString(),
            expected_token_amount: formatUnitsAsTokenAmount(
              expectedTokenUnits,
              selectedToken.decimals,
            ),
            paid_amount_usd: amount.toFixed(2),
            bonus_credits: bonusCredits,
            promo_code: promoApplies ? "bsc" : null,
            price_quote: priceQuote
              ? {
                  pair: "BNB/USD",
                  source: priceQuote.source,
                  feed_address: priceQuote.feedAddress ?? null,
                  price_usd: priceQuote.priceUsd.toString(),
                  updated_at: priceQuote.updatedAt,
                  fetched_at: priceQuote.fetchedAt,
                }
              : null,
            // Slippage tolerance for the on-chain verify step. Only meaningful
            // when paying with a non-stable native token whose price moves
            // between quote and broadcast. Stables ignore this.
            slippage_bps: selectedToken.kind === "native" ? NATIVE_SLIPPAGE_BPS : 0,
          },
        })
        .returning();
      if (!created) throw new Error("Failed to create direct crypto payment");
      return created;
    });

    const payerProofNonce = crypto.randomUUID();
    const payerProofInput = {
      paymentId: payment.id,
      organizationId: params.organizationId,
      userId: params.userId,
      network: params.network,
      chainId: cfg.chainId ?? null,
      payerAddress: params.payerAddress,
      receiveAddress: cfg.receiveAddress ?? "",
      tokenSymbol: selectedToken.symbol,
      tokenAddress: selectedToken.tokenAddress ?? null,
      tokenMint: selectedToken.tokenMint ?? null,
      expectedTokenUnits,
      nonce: payerProofNonce,
      expiresAt: payment.expires_at,
    };
    const payerProofMessage = buildDirectWalletPayerProofMessage(payerProofInput);
    const payerProofScheme = payerProofSchemeForNetwork(params.network);
    const payerProofTypedData =
      params.network === "solana"
        ? null
        : buildDirectWalletPayerProofTypedData({
            ...payerProofInput,
            network: params.network,
            chainId: cfg.chainId ?? 0,
          });

    const { signature: quoteSignature, canonicalInput: quoteCanonicalInput } = await signQuote(
      env,
      {
        paymentId: payment.id,
        expectedTokenUnits,
        receiveAddress: cfg.receiveAddress ?? "",
        chainId: cfg.chainId ?? null,
        tokenAddress: selectedToken.tokenAddress ?? null,
        tokenMint: selectedToken.tokenMint ?? null,
        expiresAt: payment.expires_at,
      },
    );

    // Persist the signature and canonical input for audit + later verification.
    await dbWrite
      .update(cryptoPayments)
      .set({
        metadata: sql`COALESCE(${cryptoPayments.metadata}, '{}'::jsonb) || ${JSON.stringify({
          quote_signature: quoteSignature,
          quote_canonical_input: quoteCanonicalInput,
          payer_proof_message: payerProofMessage,
          payer_proof_typed_data: payerProofTypedData,
          payer_proof_nonce: payerProofNonce,
          payer_proof_expires_at: payment.expires_at.toISOString(),
          payer_proof_scheme: payerProofScheme,
        })}::jsonb`,
        updated_at: new Date(),
      })
      .where(eq(cryptoPayments.id, payment.id));

    return {
      payment,
      paymentInstructions: {
        network: params.network,
        chainId: cfg.chainId,
        tokenSymbol: selectedToken.symbol,
        tokenKind: selectedToken.kind,
        tokenAddress: selectedToken.tokenAddress,
        tokenMint: selectedToken.tokenMint,
        tokenDecimals: selectedToken.decimals,
        receiveAddress: cfg.receiveAddress,
        amountUnits: expectedTokenUnits.toString(),
        amountToken: formatUnitsAsTokenAmount(expectedTokenUnits, selectedToken.decimals),
        amountUsd: amount.toFixed(2),
        creditsToAdd: creditsToAdd.toFixed(2),
        bonusCredits,
        expiresAt: payment.expires_at.toISOString(),
        quoteSignature,
        quoteCanonicalInput,
        payerProofMessage,
        payerProofTypedData,
        payerProofScheme,
      },
    };
  }

  /**
   * Records a broadcast tx hash against a pending payment. Called by the
   * frontend the instant the wallet returns a hash, BEFORE the user-driven
   * confirm path runs. Persisting the hash here means a browser crash, tab
   * close, or network drop between broadcast and confirm doesn't orphan a
   * paid tx — the cron auto-confirm path picks it up.
   *
   * Idempotent: a second call with the same hash is a no-op. A different
   * hash on an already-attached payment errors.
   */
  async attachTransaction(
    env: Bindings,
    params: {
      paymentId: string;
      txHash: string;
      userId: string;
      payerSignature?: string;
    },
  ): Promise<{
    payment: CryptoPayment;
    alreadyAttached: boolean;
  }> {
    return await dbWrite.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(cryptoPayments)
        .where(eq(cryptoPayments.id, params.paymentId))
        .for("update");
      if (!payment) throw new Error("Payment not found");
      if (payment.user_id !== params.userId) throw new Error("Unauthorized");
      const canonicalTxHash = canonicalizeCryptoTransactionHash(params.txHash, payment.network);

      // Already-confirmed payments don't accept new hashes — the hash is
      // already final.
      if (payment.status === "confirmed") {
        if (
          !cryptoTransactionHashesEqual(payment.transaction_hash, canonicalTxHash, payment.network)
        ) {
          throw new Error("Payment confirmation replay does not match the committed transaction");
        }
        return { payment, alreadyAttached: true };
      }

      if (
        cryptoTransactionHashesEqual(payment.transaction_hash, canonicalTxHash, payment.network)
      ) {
        return { payment, alreadyAttached: true };
      }
      if (payment.transaction_hash) {
        throw new Error("Payment already has a different transaction hash attached");
      }
      if (payment.status !== "pending") {
        throw new Error(`Cannot attach tx to payment in status ${payment.status}`);
      }
      const direct = directMetadata(payment);
      const cfg = directPaymentConfig(env, direct.network);
      const payerProofPatch = await verifyPayerProofOrThrow({
        paymentId: payment.id,
        direct,
        signature: params.payerSignature,
        cfg,
      });

      // Guard against the same tx being attached to two different payments.
      const existingTx = await tx
        .select()
        .from(cryptoPayments)
        .where(
          isHexTransactionHash(canonicalTxHash)
            ? sql`lower(${cryptoPayments.transaction_hash}) = ${canonicalTxHash}`
            : eq(cryptoPayments.transaction_hash, canonicalTxHash),
        )
        .for("update");
      if (existingTx.some((candidate) => candidate.id !== payment.id)) {
        throw new Error("Transaction already attached to another payment");
      }

      const [updated] = await tx
        .update(cryptoPayments)
        .set({
          transaction_hash: canonicalTxHash,
          status: "broadcast",
          ...(payerProofPatch && {
            metadata: sql`COALESCE(${cryptoPayments.metadata}, '{}'::jsonb) || ${JSON.stringify(
              payerProofPatch,
            )}::jsonb`,
          }),
          updated_at: new Date(),
        })
        .where(eq(cryptoPayments.id, payment.id))
        .returning();
      if (!updated) throw new Error("Failed to attach transaction");
      return { payment: updated, alreadyAttached: false };
    });
  }

  /**
   * Read-only status fetch for the user's polling loop. Returns the minimum
   * the UI needs to render a "waiting for confirmation" screen without
   * leaking unrelated metadata.
   */
  async getPaymentStatusForUser(params: { paymentId: string; userId: string }): Promise<{
    paymentId: string;
    status: string;
    network: DirectWalletNetwork | null;
    txHash: string | null;
    blockNumber: string | null;
    expectedAmount: string;
    creditsToAdd: string;
    bonusCredits: number;
    expiresAt: string;
    confirmedAt: string | null;
    explorerUrl: string | null;
    error: string | null;
  } | null> {
    const payment = await dbWrite
      .select()
      .from(cryptoPayments)
      .where(eq(cryptoPayments.id, params.paymentId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!payment) return null;
    if (payment.user_id !== params.userId) {
      throw new Error("Unauthorized");
    }
    const metadata = metadataOf(payment);
    const rawNetwork = metadata.direct_network;
    const network: DirectWalletNetwork | null =
      rawNetwork === "base" || rawNetwork === "bsc" || rawNetwork === "solana" ? rawNetwork : null;
    const explorerUrl = buildExplorerUrl(network, payment.transaction_hash);
    const errorValue = typeof metadata.failure_reason === "string" ? metadata.failure_reason : null;

    return {
      paymentId: payment.id,
      status: payment.status,
      network,
      txHash: payment.transaction_hash,
      blockNumber: payment.block_number,
      expectedAmount: payment.expected_amount,
      creditsToAdd: payment.credits_to_add,
      bonusCredits: parseDirectWalletMetadataNumber({
        paymentId: payment.id,
        field: "bonus_credits",
        value: metadata.bonus_credits,
        defaultValue: 0,
      }),
      expiresAt: payment.expires_at.toISOString(),
      confirmedAt: payment.confirmed_at?.toISOString() ?? null,
      explorerUrl,
      error: errorValue,
    };
  }

  async confirmPayment(
    env: Bindings,
    params: {
      paymentId: string;
      txHash: string;
      userId: string;
      // Allow the cron auto-confirm path to confirm a tx that landed after
      // the user-facing expiry. The on-chain tx is real money — refusing to
      // credit it because of a clock-side timeout would orphan a paid sale.
      allowExpired?: boolean;
      payerSignature?: string;
    },
  ) {
    const [observedPayment] = await dbWrite
      .select()
      .from(cryptoPayments)
      .where(eq(cryptoPayments.id, params.paymentId))
      .limit(1);
    if (!observedPayment) throw new Error("Payment not found");
    if (observedPayment.user_id !== params.userId) throw new Error("Unauthorized");
    const observedDirect = directMetadata(observedPayment);
    const observedConfig = directPaymentConfig(env, observedDirect.network);
    const canonicalTxHash = canonicalizeCryptoTransactionHash(
      params.txHash,
      observedDirect.network,
    );
    requireConfigured(observedConfig);

    let payerProofPatch: Record<string, unknown> | null = null;
    let verification: { blockNumber: string; receivedUnits: bigint };
    if (observedPayment.status === "confirmed") {
      if (
        !cryptoTransactionHashesEqual(
          observedPayment.transaction_hash,
          canonicalTxHash,
          observedDirect.network,
        )
      ) {
        throw new Error("Payment confirmation replay does not match the committed transaction");
      }
      const receivedUnits = metadataOf(observedPayment).received_token_units;
      if (typeof receivedUnits !== "string" || !/^\d+$/.test(receivedUnits)) {
        throw new Error("Confirmed payment is missing its verified token units");
      }
      verification = {
        blockNumber: observedPayment.block_number ?? "",
        receivedUnits: BigInt(receivedUnits),
      };
    } else {
      if (observedPayment.status !== "pending" && observedPayment.status !== "broadcast") {
        throw new Error(`Payment is ${observedPayment.status}`);
      }
      if (observedPayment.expires_at < new Date() && !params.allowExpired) {
        throw new Error("Payment has expired");
      }
      if (
        observedPayment.transaction_hash &&
        !cryptoTransactionHashesEqual(
          observedPayment.transaction_hash,
          canonicalTxHash,
          observedDirect.network,
        )
      ) {
        throw new Error("Payment already has a different transaction hash attached");
      }
      const persistedSig = observedDirect.metadata.quote_signature;
      if (typeof persistedSig !== "string" || persistedSig.length === 0) {
        throw new Error("Quote signature missing — payment may have been tampered with.");
      }
      const sigOk = await verifyQuoteSignature(
        env,
        {
          paymentId: observedPayment.id,
          expectedTokenUnits: observedDirect.expectedTokenUnits,
          receiveAddress: String(observedDirect.metadata.receive_address ?? ""),
          chainId: observedConfig.chainId ?? null,
          tokenAddress: observedDirect.tokenAddress,
          tokenMint: observedDirect.tokenMint,
          expiresAt: observedPayment.expires_at,
        },
        persistedSig,
      );
      if (!sigOk)
        throw new Error("Quote signature mismatch — payment may have been tampered with.");

      payerProofPatch = await verifyPayerProofOrThrow({
        paymentId: observedPayment.id,
        direct: observedDirect,
        signature: params.payerSignature,
        cfg: observedConfig,
      });
      if (observedDirect.network === "solana") {
        verification = await verifySolanaTokenPayment({
          cfg: observedConfig,
          payerAddress: observedDirect.payerAddress,
          txHash: canonicalTxHash,
          expectedUnits: observedDirect.expectedTokenUnits,
        });
      } else if (observedDirect.tokenKind === "native") {
        verification = await verifyEvmNativePayment({
          cfg: observedConfig,
          payerAddress: observedDirect.payerAddress,
          txHash: canonicalTxHash,
          expectedUnits: observedDirect.expectedTokenUnits,
          slippageBps: observedDirect.slippageBps,
        });
      } else {
        if (!observedDirect.tokenAddress)
          throw new Error("Payment metadata is missing token address");
        verification = await verifyEvmTokenPayment({
          cfg: observedConfig,
          tokenAddress: observedDirect.tokenAddress,
          payerAddress: observedDirect.payerAddress,
          txHash: canonicalTxHash,
          expectedUnits: observedDirect.expectedTokenUnits,
        });
      }
    }
    const observedDigest = directPaymentSettlementDigest(observedPayment);

    const result = await dbWrite.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(cryptoPayments)
        .where(eq(cryptoPayments.id, params.paymentId))
        .for("update");

      if (!payment) throw new Error("Payment not found");
      if (payment.user_id !== params.userId) throw new Error("Unauthorized");
      if (payment.status === "confirmed") {
        const direct = directMetadata(payment);
        const cfg = directPaymentConfig(env, direct.network);
        if (
          !cryptoTransactionHashesEqual(payment.transaction_hash, canonicalTxHash, direct.network)
        ) {
          throw new Error("Payment confirmation replay does not match the committed transaction");
        }
        const invoiceSettlement = directInvoiceSettlement(payment, direct, canonicalTxHash);
        await invoicesService.create(invoiceSettlement, tx);
        await enqueueDirectSweep(tx, {
          paymentId: payment.id,
          network: direct.network,
          tokenKind: direct.tokenKind,
          tokenAddress: direct.tokenAddress,
          tokenMint: direct.tokenMint,
          tokenDecimals: direct.tokenDecimals,
          receivedUnits: verification.receivedUnits.toString(),
          sweepTo: cfg.secureAddress,
        });
        return {
          payment,
          alreadyConfirmed: true,
          transactionHash: canonicalTxHash,
          direct,
          cfg,
          amountPaid: payment.expected_amount,
          creditsToAdd: payment.credits_to_add,
          sweep: metadataOf(payment).sweep ?? { state: "pending" },
        };
      }
      if (payment.status !== "pending" && payment.status !== "broadcast") {
        throw new Error(`Payment is ${payment.status}`);
      }
      // Expiry only blocks the user-initiated confirm path. A tx broadcast
      // before expiry that landed late is auto-recovered by the cron path
      // which calls verifyAndConfirmBroadcast() directly.
      if (payment.expires_at < new Date() && !params.allowExpired) {
        throw new Error("Payment has expired");
      }

      const direct = directMetadata(payment);
      const cfg = directPaymentConfig(env, direct.network);
      requireConfigured(cfg);
      if (directPaymentSettlementDigest(payment) !== observedDigest) {
        throw new Error("Payment quote changed while on-chain verification was in progress");
      }
      if (
        payment.transaction_hash &&
        !cryptoTransactionHashesEqual(payment.transaction_hash, canonicalTxHash, direct.network)
      ) {
        throw new Error("Payment already has a different transaction hash attached");
      }

      const existingTx = await tx
        .select()
        .from(cryptoPayments)
        .where(
          isHexTransactionHash(canonicalTxHash)
            ? sql`lower(${cryptoPayments.transaction_hash}) = ${canonicalTxHash}`
            : eq(cryptoPayments.transaction_hash, canonicalTxHash),
        )
        .for("update");
      if (existingTx.some((candidate) => candidate.id !== payment.id)) {
        throw new Error("Transaction already processed for another payment");
      }

      const amountPaid = new Decimal(payment.expected_amount);
      const creditsToAdd = new Decimal(payment.credits_to_add);
      const confirmedAt = new Date();
      await tx
        .update(cryptoPayments)
        .set({
          status: "confirmed",
          transaction_hash: canonicalTxHash,
          block_number: verification.blockNumber,
          received_amount: amountPaid.toFixed(2),
          confirmed_at: confirmedAt,
          updated_at: confirmedAt,
          metadata: {
            ...metadataOf(payment),
            ...(payerProofPatch ?? {}),
            confirmed_at: confirmedAt.toISOString(),
            received_token_units: verification.receivedUnits.toString(),
            sweep: { state: direct.tokenKind === "native" ? "not_required" : "pending" },
          },
        })
        .where(eq(cryptoPayments.id, payment.id));

      // Grant the credit INSIDE the confirmation transaction (db: tx) so it
      // commits atomically with the status="confirmed" flip. Pre-fix the grant
      // ran on the global connection AFTER the transaction committed: an
      // addCredits failure left the row durably `confirmed` with zero credits,
      // and the recovery cron (processBroadcastBatch) only re-selects
      // `broadcast` rows — the paid on-chain deposit stayed uncredited forever.
      // The `wallet_native:<id>` key keeps a replay a no-op via the SQL-level
      // dedupe in addCredits (ON CONFLICT on stripe_payment_intent_id).
      await creditsService.addCredits({
        organizationId: payment.organization_id,
        amount: creditsToAdd.toFixed(2),
        description:
          direct.bonusCredits > 0
            ? `Direct crypto payment (${direct.tokenSymbol} on ${cfg.displayName}) + BSC promotion`
            : `Direct crypto payment (${direct.tokenSymbol} on ${cfg.displayName})`,
        stripePaymentIntentId: `wallet_native:${payment.id}`,
        db: tx,
        metadata: {
          crypto_payment_id: payment.id,
          payment_method: "crypto",
          provider: "wallet_native",
          transaction_hash: canonicalTxHash,
          network: direct.network,
          token: direct.tokenSymbol,
          paid_amount_usd: amountPaid.toFixed(2),
          bonus_credits: direct.bonusCredits,
          credits_added: creditsToAdd.toFixed(2),
          payer_wallet_address: direct.payerAddress,
        },
      });

      const invoiceSettlement = directInvoiceSettlement(payment, direct, canonicalTxHash);
      await invoicesService.create(invoiceSettlement, tx);
      await enqueueDirectSweep(tx, {
        paymentId: payment.id,
        network: direct.network,
        tokenKind: direct.tokenKind,
        tokenAddress: direct.tokenAddress,
        tokenMint: direct.tokenMint,
        tokenDecimals: direct.tokenDecimals,
        receivedUnits: verification.receivedUnits.toString(),
        sweepTo: cfg.secureAddress,
      });

      const [confirmed] = await tx
        .select()
        .from(cryptoPayments)
        .where(eq(cryptoPayments.id, payment.id));
      return {
        payment: confirmed ?? payment,
        alreadyConfirmed: false,
        transactionHash: canonicalTxHash,
        direct,
        cfg,
        amountPaid: amountPaid.toFixed(2),
        creditsToAdd: creditsToAdd.toFixed(2),
        sweep: { state: direct.tokenKind === "native" ? "not_required" : "pending" },
      };
    });

    if (result.direct.tokenKind !== "native") {
      try {
        await this.processSweepForPayment(env, result.payment.id);
      } catch (error) {
        // error-policy:J4 settlement is durable and explicitly reports a
        // pending sweep; the active cron dispatcher retries the outbox row.
        logger.warn("[DirectWalletPayments] Post-settlement sweep deferred", {
          paymentId: redact.paymentId(result.payment.id),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("[DirectWalletPayments] Payment confirmed", {
      paymentId: redact.paymentId(params.paymentId),
      txHash: redact.txHash(result.transactionHash),
    });

    return result;
  }

  private async processSweepForPayment(
    env: Bindings,
    paymentId: string,
    hooks?: { afterExternalSweep?: () => Promise<void> },
  ): Promise<boolean> {
    const claimToken = crypto.randomUUID();
    const now = new Date();
    const claimed = await dbWrite.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(cryptoSweepOutbox)
        .where(eq(cryptoSweepOutbox.payment_id, paymentId))
        .for("update")
        .limit(1);
      if (!candidate || candidate.state === "delivered" || candidate.state === "terminal") {
        return null;
      }
      if (
        candidate.state === "processing" &&
        candidate.lease_expires_at &&
        candidate.lease_expires_at > now
      ) {
        return null;
      }
      if (candidate.next_attempt_at > now) return null;
      const [row] = await tx
        .update(cryptoSweepOutbox)
        .set({
          state: "processing",
          claim_token: claimToken,
          lease_expires_at: new Date(now.getTime() + 120_000),
          attempts: candidate.attempts + 1,
          updated_at: now,
        })
        .where(eq(cryptoSweepOutbox.id, candidate.id))
        .returning();
      return row ?? null;
    });
    if (!claimed) return false;

    let externalSweepReturned = false;
    try {
      const payload = directSweepPayload(claimed.payload);
      if (settlementDigest(payload) !== claimed.payload_digest) {
        throw new Error("Crypto sweep outbox payload digest mismatch");
      }
      const cfg = directPaymentConfig(env, payload.network);
      requireConfigured(cfg);
      const units = BigInt(payload.receivedUnits);
      let prepared = preparedSweepFromRow(claimed);
      if (
        prepared &&
        (prepared.metadata.network !== payload.network ||
          prepared.metadata.sweepTo !== payload.sweepTo)
      ) {
        throw new Error("Prepared crypto sweep does not match the immutable intent");
      }
      const prepare = async (): Promise<PreparedSweep | null> => {
        if (!payload.sweepTo) return null;
        if (payload.network === "solana") {
          if (!payload.tokenMint) throw new Error("Solana sweep intent is missing its token mint");
          return prepareSolanaSweep({
            env,
            cfg,
            units,
            sweepTo: payload.sweepTo,
            tokenMint: payload.tokenMint,
            tokenDecimals: payload.tokenDecimals,
          });
        }
        return prepareEvmSweep({
          env,
          cfg,
          tokenAddress: payload.tokenAddress,
          tokenDecimals: payload.tokenDecimals,
          units,
          sweepTo: payload.sweepTo,
        });
      };
      const persistPrepared = async (
        next: PreparedSweep,
        previousHash: string | null,
      ): Promise<void> => {
        const [persisted] = await dbWrite
          .update(cryptoSweepOutbox)
          .set({
            prepared_transaction: next.rawTransaction,
            sweep_transaction_hash: next.transactionHash,
            prepared_metadata: next.metadata,
            updated_at: new Date(),
          })
          .where(
            and(
              eq(cryptoSweepOutbox.id, claimed.id),
              eq(cryptoSweepOutbox.claim_token, claimToken),
              previousHash === null
                ? sql`${cryptoSweepOutbox.sweep_transaction_hash} IS NULL`
                : eq(cryptoSweepOutbox.sweep_transaction_hash, previousHash),
            ),
          )
          .returning({ id: cryptoSweepOutbox.id });
        if (!persisted) {
          throw new Error("Crypto sweep lease was lost before transaction preparation");
        }
      };
      if (!prepared) {
        prepared = await prepare();
        if (prepared) await persistPrepared(prepared, null);
      }
      if (prepared) {
        if (payload.network === "solana") {
          const outcome = await submitPreparedSolanaSweep(cfg, prepared);
          if (outcome === "reprepare") {
            const expiredHash = prepared.transactionHash;
            const replacement = await prepare();
            if (!replacement) throw new Error("Solana sweep replacement could not be prepared");
            await persistPrepared(replacement, expiredHash);
            prepared = replacement;
            if ((await submitPreparedSolanaSweep(cfg, prepared)) === "reprepare") {
              throw new Error("New Solana sweep blockhash expired before submission");
            }
          }
        } else {
          await submitPreparedEvmSweep(cfg, prepared);
        }
      }
      externalSweepReturned = true;
      const completedAt = new Date();
      await hooks?.afterExternalSweep?.();
      await dbWrite.transaction(async (tx) => {
        const [owned] = await tx
          .select()
          .from(cryptoSweepOutbox)
          .where(
            and(
              eq(cryptoSweepOutbox.id, claimed.id),
              eq(cryptoSweepOutbox.claim_token, claimToken),
            ),
          )
          .for("update")
          .limit(1);
        if (!owned) throw new Error("Crypto sweep lease was lost before acknowledgement");
        await tx
          .update(cryptoSweepOutbox)
          .set({
            state: "delivered",
            delivered_at: completedAt,
            sweep_transaction_hash: prepared?.transactionHash ?? null,
            claim_token: null,
            lease_expires_at: null,
            last_error: null,
            updated_at: completedAt,
          })
          .where(eq(cryptoSweepOutbox.id, claimed.id));
        await tx
          .update(cryptoPayments)
          .set({
            metadata: sql`COALESCE(${cryptoPayments.metadata}, '{}'::jsonb) || ${JSON.stringify({
              sweep: prepared
                ? {
                    sweep_transaction_hash: prepared.transactionHash,
                    sweep_to: prepared.metadata.sweepTo,
                  }
                : { state: "not_configured" },
              sweep_completed_at: completedAt.toISOString(),
            })}::jsonb`,
            updated_at: completedAt,
          })
          .where(eq(cryptoPayments.id, paymentId));
      });
      return true;
    } catch (error) {
      // error-policy:J4 the outbox retains the failure and bounded retry state;
      // the payment and credit settlement remain committed and observable.
      // Once the provider returned a submission result, an acknowledgement
      // failure is outcome-unknown. Never submit again automatically: doing so
      // could sweep a later deposit with the same balance-based transfer.
      const terminal = externalSweepReturned || claimed.attempts >= 12;
      await dbWrite
        .update(cryptoSweepOutbox)
        .set({
          state: terminal ? "terminal" : "pending",
          terminal_at: terminal ? new Date() : null,
          next_attempt_at: new Date(
            Date.now() + Math.min(3_600_000, 2 ** claimed.attempts * 1_000),
          ),
          claim_token: null,
          lease_expires_at: null,
          last_error: error instanceof Error ? error.message : String(error),
          updated_at: new Date(),
        })
        .where(
          and(eq(cryptoSweepOutbox.id, claimed.id), eq(cryptoSweepOutbox.claim_token, claimToken)),
        );
      throw error;
    }
  }

  async drainSweepOutbox(
    env: Bindings,
    limit = 25,
    hooks?: { afterExternalSweep?: () => Promise<void> },
  ): Promise<{ processed: number; delivered: number; deferred: number }> {
    const due = await dbWrite
      .select({ paymentId: cryptoSweepOutbox.payment_id })
      .from(cryptoSweepOutbox)
      .where(
        and(
          lte(cryptoSweepOutbox.next_attempt_at, new Date()),
          or(
            eq(cryptoSweepOutbox.state, "pending"),
            and(
              eq(cryptoSweepOutbox.state, "processing"),
              lte(cryptoSweepOutbox.lease_expires_at, new Date()),
            ),
          ),
        ),
      )
      .orderBy(cryptoSweepOutbox.next_attempt_at, cryptoSweepOutbox.created_at)
      .limit(limit);
    const stats = { processed: 0, delivered: 0, deferred: 0 };
    for (const row of due) {
      stats.processed += 1;
      try {
        if (await this.processSweepForPayment(env, row.paymentId, hooks)) stats.delivered += 1;
      } catch {
        // error-policy:J4 processSweepForPayment persisted retry/terminal state.
        stats.deferred += 1;
      }
    }
    return stats;
  }

  /**
   * Auto-confirm any payments stuck in `broadcast` — the user broadcast a
   * tx but never called (or failed to call) confirm. The cron path drives
   * this every minute or so; each payment gets a short on-chain check, and
   * one of three things happens:
   *
   *   - Tx is mined and matches expected → confirm the payment, issue credits.
   *   - Tx isn't on chain yet (mempool / not propagated) → leave as `broadcast`,
   *     retry next tick.
   *   - Tx reverted, recipient/amount wrong, or chain rejected → mark
   *     `failed_chain` with `metadata.failure_reason`. Surfaces in the UI
   *     waiting overlay so the user knows it's done.
   *   - RPC/infra error (503, timeout, rate-limit) → says nothing about the
   *     tx itself, so leave as `broadcast` and retry next tick. A paid
   *     deposit must never be terminally failed on RPC evidence alone.
   */
  async processBroadcastBatch(
    env: Bindings,
    options: { batchSize?: number } = {},
  ): Promise<{
    processed: number;
    confirmed: number;
    stillPending: number;
    failed: number;
  }> {
    const batchSize = options.batchSize ?? 25;
    const stats = { processed: 0, confirmed: 0, stillPending: 0, failed: 0 };

    const candidates = await dbWrite
      .select()
      .from(cryptoPayments)
      .where(
        sql`${cryptoPayments.status} = 'broadcast'
            AND ${cryptoPayments.transaction_hash} IS NOT NULL
            AND ${cryptoPayments.metadata}->>'kind' = 'direct_wallet_credit_purchase'`,
      )
      .limit(batchSize);

    // Cap how many times the cron retries a transient verify failure on a
    // single payment. A real tx propagates within minutes; ~1 hour of
    // "not found" usually means a bad hash, wrong network, or a tx that
    // was dropped from the mempool. Past that, a NOT-FOUND tx is marked
    // `failed_chain` so the user sees the failure instead of an indefinite
    // spinner. Unknown (RPC/infra) errors keep retrying past the cap — see
    // the classification in the catch below.
    const MAX_VERIFY_ATTEMPTS = 60;

    for (const payment of candidates) {
      stats.processed += 1;
      const hash = payment.transaction_hash;
      if (!hash) continue;
      try {
        await this.confirmPayment(env, {
          paymentId: payment.id,
          txHash: hash,
          userId: payment.user_id ?? "",
          allowExpired: true,
        });
        stats.confirmed += 1;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Classify the failure. Money rule: only a DETERMINISTIC verification
        // failure may terminally fail a deposit — the tx is on chain (or the
        // payment row is provably unverifiable) and retrying can never change
        // the outcome: reverted tx, wrong sender/recipient/amount, tampered
        // quote, payer-proof mismatch, hash already credited to another
        // payment, or an unverifiable compatibility row. Everything OUTSIDE this
        // allowlist retries — a transient RPC failure (503 / timeout /
        // rate-limit thrown by getTransactionReceipt / getTransaction /
        // getParsedTransaction, e.g. viem HttpRequestError or TimeoutError)
        // says nothing about the tx and must never mark a genuinely-paid
        // deposit `failed_chain`.
        const terminal =
          /Transaction failed|amount is lower than the expected|is (below|above) the expected (floor|ceiling)|recipient does not match|sender does not match the proven payer|was not confirmed successfully|ATA owner does not match|does not transfer enough|proof metadata mismatch|Quote signature|already processed for another payment|missing token address|LEGACY_PAYMENT_MISSING_PAYER_PROOF/i.test(
            msg,
          );
        // Receipt-not-yet-found: expected while a tx propagates. Unlike the
        // unknown/RPC bucket this IS terminal once retries are exhausted —
        // ~1 hour of "not found" means a bad hash, wrong network, or a tx
        // dropped from the mempool.
        const notFound =
          /not found|not yet|pending|TransactionReceiptNotFoundError|could not be found/i.test(msg);

        const attempts =
          parseDirectWalletMetadataNumber({
            paymentId: payment.id,
            field: "verify_attempts",
            value: (metadataOf(payment) as Record<string, unknown>).verify_attempts,
            defaultValue: 0,
            integer: true,
          }) + 1;

        const bumpVerifyAttempts = () =>
          dbWrite
            .update(cryptoPayments)
            .set({
              updated_at: new Date(),
              metadata: sql`COALESCE(${cryptoPayments.metadata}, '{}'::jsonb) || ${JSON.stringify({
                verify_attempts: attempts,
                last_verify_error: msg,
                last_verify_at: new Date().toISOString(),
              })}::jsonb`,
            })
            .where(eq(cryptoPayments.id, payment.id));

        if (!terminal && attempts < MAX_VERIFY_ATTEMPTS) {
          stats.stillPending += 1;
          await bumpVerifyAttempts();
          continue;
        }

        if (!terminal && !notFound) {
          // Unknown (almost certainly RPC/infra) errors exhausted the retry
          // window. The tx may be PAID — RPC trouble is not evidence about
          // the tx, so never flip to `failed_chain` here. Keep the row in
          // `broadcast` (the attempt counter keeps climbing for
          // observability) and log at error level; the payment confirms as
          // soon as the RPC recovers, or fails properly once a real
          // terminal / not-found signal appears.
          stats.stillPending += 1;
          logger.error(
            "[DirectWalletPayments] verify still failing with a non-terminal error after MAX_VERIFY_ATTEMPTS — keeping payment in broadcast",
            { paymentId: redact.paymentId(payment.id), attempts, lastError: msg },
          );
          await bumpVerifyAttempts();
          continue;
        }

        if (!terminal) {
          logger.warn(
            "[DirectWalletPayments] giving up on broadcast payment after MAX_VERIFY_ATTEMPTS",
            { paymentId: redact.paymentId(payment.id), attempts, lastError: msg },
          );
        }

        stats.failed += 1;
        await dbWrite
          .update(cryptoPayments)
          .set({
            status: "failed_chain",
            updated_at: new Date(),
            metadata: sql`COALESCE(${cryptoPayments.metadata}, '{}'::jsonb) || ${JSON.stringify({
              failure_reason: msg,
              failed_at: new Date().toISOString(),
            })}::jsonb`,
          })
          .where(eq(cryptoPayments.id, payment.id));
        logger.warn("[DirectWalletPayments] Marked payment failed_chain", {
          paymentId: redact.paymentId(payment.id),
          txHash: redact.txHash(hash),
          reason: msg,
        });
      }
    }

    if (stats.processed > 0) {
      logger.info("[DirectWalletPayments] processBroadcastBatch summary", stats);
    }
    return stats;
  }
}

export const directWalletPaymentsService = new DirectWalletPaymentsService();
