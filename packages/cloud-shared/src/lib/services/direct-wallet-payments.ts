import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  isAddress,
  parseAbiItem,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc } from "viem/chains";
import { dbWrite } from "../../db/client";
import type { CryptoPayment } from "../../db/repositories/crypto-payments";
import { cryptoPayments } from "../../db/schemas/crypto-payments";
import type { Bindings } from "../../types/cloud-worker-env";
import { PAYMENT_EXPIRATION_MS, validatePaymentAmount } from "../config/crypto";
import { createCryptoCustomerId, createCryptoInvoiceId } from "../constants/invoice-ids";
import { logger, redact } from "../utils/logger";
import { type BnbPriceQuote, getBnbUsdQuote } from "./bnb-price-oracle";
import { creditsService } from "./credits";
import { invoicesService } from "./invoices";

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
const BSC_USDC_ADDRESS = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
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
    symbol: "USDC",
    kind: "bep20",
    tokenAddress: getAddress(BSC_USDC_ADDRESS),
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
  const match = BSC_TOKEN_OPTIONS.find(
    (t) => t.symbol.toUpperCase() === symbol.toUpperCase(),
  );
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
    // Backward-compat: legacy CRYPTO_DIRECT_BSC_TOKEN_ADDRESS overrides the
    // default USDT contract in the tokens list, in case an env has been
    // pointed at a non-standard contract.
    const usdtOverride = envString(env, "CRYPTO_DIRECT_BSC_TOKEN_ADDRESS");
    const tokens: DirectWalletTokenOption[] = usdtOverride
      ? BSC_TOKEN_OPTIONS.map((t) =>
          t.symbol === "USDT"
            ? { ...t, tokenAddress: getAddress(usdtOverride) }
            : t,
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
    tokenMint:
      typeof metadata.token_mint === "string" ? metadata.token_mint : null,
    tokenDecimals: Number(metadata.token_decimals ?? 0),
    expectedTokenUnits: BigInt(String(metadata.expected_token_units ?? "0")),
    bonusCredits: Number(metadata.bonus_credits ?? 0),
    slippageBps: Number(metadata.slippage_bps ?? 0),
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

  const tx = await client.getTransaction({ hash: params.txHash as Hex });
  if (tx.from.toLowerCase() !== normalizeEvmAddress(params.payerAddress)) {
    throw new Error("Transaction sender does not match account wallet");
  }
  if (tx.to?.toLowerCase() !== params.tokenAddress.toLowerCase()) {
    throw new Error("Transaction is not a transfer of the expected token");
  }

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

  const tx = await client.getTransaction({ hash: params.txHash as Hex });
  if (tx.from.toLowerCase() !== normalizeEvmAddress(params.payerAddress)) {
    throw new Error("Transaction sender does not match account wallet");
  }
  if (
    !tx.to ||
    tx.to.toLowerCase() !== normalizeEvmAddress(params.cfg.receiveAddress)
  ) {
    throw new Error("Transaction recipient does not match the receive address");
  }
  // Apply slippage tolerance for native-token payments where the locked
  // quote may have drifted between createPayment and broadcast. A non-native
  // (stable) verify passes slippageBps=0, so the floor is the exact expected
  // amount and an over-payment is still accepted.
  const slippageBps = BigInt(params.slippageBps ?? 0);
  const floor =
    slippageBps > 0n
      ? (params.expectedUnits * (10_000n - slippageBps)) / 10_000n
      : params.expectedUnits;
  if (tx.value < floor) {
    throw new Error(
      `Transaction amount ${tx.value} is below the expected floor ${floor} (expected ${params.expectedUnits}, slippage ${slippageBps} bps)`,
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
  if (!tx?.meta || tx.meta.err) throw new Error("Transaction was not confirmed successfully");

  const mint = params.cfg.tokenMint;
  const receiver = normalizeSolanaAddress(params.cfg.receiveAddress);
  const payer = normalizeSolanaAddress(params.payerAddress);
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

async function sweepEvmIfConfigured(params: {
  env: Bindings;
  cfg: DirectWalletNetworkConfig;
  tokenAddress: Hex | null;
  tokenDecimals: number;
  units: bigint;
}): Promise<Record<string, unknown> | null> {
  if (!params.tokenAddress || !params.cfg.secureAddress) return null;
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
  const hash = await wallet.sendTransaction({
    to: params.tokenAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(params.cfg.secureAddress), params.units],
    }),
  });
  return { sweep_transaction_hash: hash, sweep_to: params.cfg.secureAddress };
}

function solanaKeypairFromEnv(env: Bindings): Keypair | null {
  const raw = envString(env, "CRYPTO_DIRECT_SOLANA_PRIVATE_KEY");
  if (!raw) return null;
  if (raw.trim().startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

async function sweepSolanaIfConfigured(params: {
  env: Bindings;
  cfg: DirectWalletNetworkConfig;
  units: bigint;
}): Promise<Record<string, unknown> | null> {
  if (!params.cfg.tokenMint || !params.cfg.secureAddress) return null;
  const payer = solanaKeypairFromEnv(params.env);
  if (!payer) return null;
  if (
    !params.cfg.receiveAddress ||
    payer.publicKey.toBase58() !== normalizeSolanaAddress(params.cfg.receiveAddress)
  ) {
    throw new Error("Configured Solana sweep key does not match the receive wallet");
  }

  const connection = new Connection(params.cfg.rpcUrl, "confirmed");
  const mint = new PublicKey(params.cfg.tokenMint);
  const fromAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const secureOwner = new PublicKey(params.cfg.secureAddress);
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
      params.cfg.tokenDecimals,
    ),
  );
  const hash = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  return { sweep_transaction_hash: hash, sweep_to: params.cfg.secureAddress };
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
      params.network === "bsc"
        ? resolveBscToken(params.tokenSymbol)
        : cfg.tokens[0];

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
      // BSC promo redemption check temporarily disabled — allow repeat $5 bonus on $10 buys.
      // if (promoRequested) {
      //   await tx.execute(sql`
      //     SELECT pg_advisory_xact_lock(hashtext(${"crypto_direct_bsc_promo:" + params.organizationId}))
      //   `);
      //   const existingPromo = await tx
      //     .select({ id: cryptoPayments.id })
      //     .from(cryptoPayments)
      //     .where(sql`
      //       ${cryptoPayments.organization_id} = ${params.organizationId}
      //       AND ${cryptoPayments.status} IN ('pending', 'confirmed')
      //       AND ${cryptoPayments.metadata}->>'kind' = 'direct_wallet_credit_purchase'
      //       AND ${cryptoPayments.metadata}->>'promo_code' = 'bsc'
      //     `)
      //     .limit(1);
      //   if (existingPromo.length > 0) {
      //     throw new Error("BSC promotion has already been redeemed for this organization");
      //   }
      // }

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
            slippage_bps:
              selectedToken.kind === "native" ? NATIVE_SLIPPAGE_BPS : 0,
          },
        })
        .returning();
      if (!created) throw new Error("Failed to create direct crypto payment");
      return created;
    });

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
    params: { paymentId: string; txHash: string; userId: string },
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

      // Already-confirmed payments don't accept new hashes — the hash is
      // already final.
      if (payment.status === "confirmed") {
        return { payment, alreadyAttached: true };
      }

      if (payment.transaction_hash === params.txHash) {
        return { payment, alreadyAttached: true };
      }
      if (payment.transaction_hash && payment.transaction_hash !== params.txHash) {
        throw new Error(
          "Payment already has a different transaction hash attached",
        );
      }
      if (payment.status !== "pending") {
        throw new Error(`Cannot attach tx to payment in status ${payment.status}`);
      }

      // Guard against the same tx being attached to two different payments.
      const existingTx = await tx
        .select()
        .from(cryptoPayments)
        .where(eq(cryptoPayments.transaction_hash, params.txHash))
        .for("update");
      if (existingTx.length > 0 && existingTx[0].id !== payment.id) {
        throw new Error("Transaction already attached to another payment");
      }

      const [updated] = await tx
        .update(cryptoPayments)
        .set({
          transaction_hash: params.txHash,
          status: "broadcast",
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
  async getPaymentStatusForUser(
    params: { paymentId: string; userId: string },
  ): Promise<{
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
      rawNetwork === "base" || rawNetwork === "bsc" || rawNetwork === "solana"
        ? rawNetwork
        : null;
    const explorerUrl = buildExplorerUrl(network, payment.transaction_hash);
    const errorValue =
      typeof metadata.failure_reason === "string" ? metadata.failure_reason : null;

    return {
      paymentId: payment.id,
      status: payment.status,
      network,
      txHash: payment.transaction_hash,
      blockNumber: payment.block_number,
      expectedAmount: payment.expected_amount,
      creditsToAdd: payment.credits_to_add,
      bonusCredits: Number(metadata.bonus_credits ?? 0),
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
    },
  ) {
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
        return {
          payment,
          alreadyConfirmed: true,
          direct,
          cfg,
          amountPaid: payment.expected_amount,
          creditsToAdd: payment.credits_to_add,
          sweep: metadataOf(payment).sweep,
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

      const existingTx = await tx
        .select()
        .from(cryptoPayments)
        .where(eq(cryptoPayments.transaction_hash, params.txHash))
        .for("update");
      if (existingTx.length > 0 && existingTx[0].id !== payment.id) {
        throw new Error("Transaction already processed for another payment");
      }

      let verification: { blockNumber: string; receivedUnits: bigint };
      if (direct.network === "solana") {
        verification = await verifySolanaTokenPayment({
          cfg,
          payerAddress: direct.payerAddress,
          txHash: params.txHash,
          expectedUnits: direct.expectedTokenUnits,
        });
      } else if (direct.tokenKind === "native") {
        verification = await verifyEvmNativePayment({
          cfg,
          payerAddress: direct.payerAddress,
          txHash: params.txHash,
          expectedUnits: direct.expectedTokenUnits,
          slippageBps: direct.slippageBps,
        });
      } else {
        if (!direct.tokenAddress) {
          throw new Error("Payment metadata is missing token address");
        }
        verification = await verifyEvmTokenPayment({
          cfg,
          tokenAddress: direct.tokenAddress,
          payerAddress: direct.payerAddress,
          txHash: params.txHash,
          expectedUnits: direct.expectedTokenUnits,
        });
      }

      const amountPaid = new Decimal(payment.expected_amount);
      const creditsToAdd = new Decimal(payment.credits_to_add);
      const confirmedAt = new Date();
      const sweep =
        direct.network === "solana"
          ? await sweepSolanaIfConfigured({ env, cfg, units: verification.receivedUnits }).catch(
              (error) => ({ sweep_error: error instanceof Error ? error.message : String(error) }),
            )
          : direct.tokenKind === "native"
            ? null
            : await sweepEvmIfConfigured({
                env,
                cfg,
                tokenAddress: direct.tokenAddress,
                tokenDecimals: direct.tokenDecimals,
                units: verification.receivedUnits,
              }).catch((error) => ({
                sweep_error: error instanceof Error ? error.message : String(error),
              }));

      await tx
        .update(cryptoPayments)
        .set({
          status: "confirmed",
          transaction_hash: params.txHash,
          block_number: verification.blockNumber,
          received_amount: amountPaid.toFixed(2),
          confirmed_at: confirmedAt,
          updated_at: confirmedAt,
          metadata: {
            ...metadataOf(payment),
            confirmed_at: confirmedAt.toISOString(),
            received_token_units: verification.receivedUnits.toString(),
            sweep,
          },
        })
        .where(eq(cryptoPayments.id, payment.id));

      const [confirmed] = await tx
        .select()
        .from(cryptoPayments)
        .where(eq(cryptoPayments.id, payment.id));
      return {
        payment: confirmed ?? payment,
        alreadyConfirmed: false,
        direct,
        cfg,
        amountPaid: amountPaid.toFixed(2),
        creditsToAdd: creditsToAdd.toFixed(2),
        sweep,
      };
    });

    const { direct, cfg, amountPaid, creditsToAdd, sweep } = result;

    await creditsService.addCredits({
      organizationId: result.payment.organization_id,
      amount: Number(creditsToAdd),
      description:
        direct.bonusCredits > 0
          ? `Direct crypto payment (${direct.tokenSymbol} on ${cfg.displayName}) + BSC promotion`
          : `Direct crypto payment (${direct.tokenSymbol} on ${cfg.displayName})`,
      stripePaymentIntentId: `wallet_native:${result.payment.id}`,
      metadata: {
        crypto_payment_id: result.payment.id,
        payment_method: "crypto",
        provider: "wallet_native",
        transaction_hash: params.txHash,
        network: direct.network,
        token: direct.tokenSymbol,
        paid_amount_usd: amountPaid,
        bonus_credits: direct.bonusCredits,
        credits_added: creditsToAdd,
        payer_wallet_address: direct.payerAddress,
      },
    });

    const invoiceId = createCryptoInvoiceId(result.payment.id);
    const existingInvoice = await invoicesService.getByStripeInvoiceId(invoiceId);
    if (!existingInvoice) {
      await invoicesService.create({
        organization_id: result.payment.organization_id,
        stripe_invoice_id: invoiceId,
        stripe_customer_id: createCryptoCustomerId(result.payment.organization_id),
        stripe_payment_intent_id: params.txHash,
        amount_due: amountPaid,
        amount_paid: amountPaid,
        currency: "usd",
        status: "paid",
        invoice_type: "crypto_payment",
        credits_added: creditsToAdd,
        metadata: {
          payment_method: "crypto",
          provider: "wallet_native",
          network: direct.network,
          token: direct.tokenSymbol,
          transaction_hash: params.txHash,
          bonus_credits: direct.bonusCredits,
          sweep,
        },
      });
    }

    logger.info("[DirectWalletPayments] Payment confirmed", {
      paymentId: redact.paymentId(params.paymentId),
      txHash: redact.txHash(params.txHash),
    });

    return result;
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
        // Heuristic: receipt-not-yet-found means we should keep waiting.
        // Anything else (wrong recipient, low value, reverted) is terminal
        // — record it so the user sees a clear failure.
        const transient =
          /not found|not yet|pending|TransactionReceiptNotFoundError|could not be found/i.test(
            msg,
          );
        if (transient) {
          stats.stillPending += 1;
          continue;
        }
        stats.failed += 1;
        await dbWrite
          .update(cryptoPayments)
          .set({
            status: "failed_chain",
            updated_at: new Date(),
            metadata: sql`COALESCE(${cryptoPayments.metadata}, '{}'::jsonb) || ${JSON.stringify(
              {
                failure_reason: msg,
                failed_at: new Date().toISOString(),
              },
            )}::jsonb`,
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
