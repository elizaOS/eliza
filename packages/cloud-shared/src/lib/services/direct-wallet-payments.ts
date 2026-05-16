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
import { eq } from "drizzle-orm";
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
import {
  type CryptoPayment,
  cryptoPaymentsRepository,
} from "../../db/repositories/crypto-payments";
import { cryptoPayments } from "../../db/schemas/crypto-payments";
import type { Bindings } from "../../types/cloud-worker-env";
import { PAYMENT_EXPIRATION_MS, validatePaymentAmount } from "../config/crypto";
import { createCryptoCustomerId, createCryptoInvoiceId } from "../constants/invoice-ids";
import { logger, redact } from "../utils/logger";
import { creditsService } from "./credits";
import { invoicesService } from "./invoices";

export type DirectWalletNetwork = "base" | "bsc" | "solana";

export interface DirectWalletNetworkConfig {
  network: DirectWalletNetwork;
  displayName: string;
  chainId?: number;
  tokenSymbol: "USDC" | "USDT";
  tokenAddress?: Hex;
  tokenMint?: string;
  tokenDecimals: number;
  receiveAddress: string | null;
  secureAddress: string | null;
  rpcUrl: string;
  enabled: boolean;
}

interface CreateDirectPaymentParams {
  organizationId: string;
  userId: string;
  accountWalletAddress: string;
  payerAddress: string;
  amountUsd: number;
  network: DirectWalletNetwork;
  promoCode?: "bsc";
}

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BSC_USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function envString(env: Bindings, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function directPaymentConfig(
  env: Bindings,
  network: DirectWalletNetwork,
): DirectWalletNetworkConfig {
  if (network === "base") {
    const receiveAddress = envString(env, "CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS");
    const secureAddress = envString(env, "CRYPTO_DIRECT_BASE_SECURE_ADDRESS");
    const tokenAddress = envString(env, "CRYPTO_DIRECT_BASE_TOKEN_ADDRESS") ?? BASE_USDC_ADDRESS;
    return {
      network,
      displayName: "Base",
      chainId: base.id,
      tokenSymbol: "USDC",
      tokenAddress: getAddress(tokenAddress),
      tokenDecimals: Number(envString(env, "CRYPTO_DIRECT_BASE_TOKEN_DECIMALS") ?? 6),
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
    const tokenAddress = envString(env, "CRYPTO_DIRECT_BSC_TOKEN_ADDRESS") ?? BSC_USDT_ADDRESS;
    return {
      network,
      displayName: "BNB Smart Chain",
      chainId: bsc.id,
      tokenSymbol: "USDT",
      tokenAddress: getAddress(tokenAddress),
      tokenDecimals: Number(envString(env, "CRYPTO_DIRECT_BSC_TOKEN_DECIMALS") ?? 18),
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
  return {
    network,
    displayName: "Solana",
    tokenSymbol: "USDC",
    tokenMint: envString(env, "CRYPTO_DIRECT_SOLANA_TOKEN_MINT") ?? SOLANA_USDC_MINT,
    tokenDecimals: Number(envString(env, "CRYPTO_DIRECT_SOLANA_TOKEN_DECIMALS") ?? 6),
    receiveAddress,
    secureAddress,
    rpcUrl:
      envString(env, "CRYPTO_DIRECT_SOLANA_RPC_URL") ??
      envString(env, "SOLANA_RPC_URL") ??
      envString(env, "NEXT_PUBLIC_SOLANA_RPC_URL") ??
      "https://api.mainnet-beta.solana.com",
    enabled: Boolean(receiveAddress),
  };
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

function assertAccountWalletMatches(params: {
  network: DirectWalletNetwork;
  accountWalletAddress: string;
  payerAddress: string;
}) {
  const account = normalizePayer(params.network, params.accountWalletAddress);
  const payer = normalizePayer(params.network, params.payerAddress);
  if (account !== payer) {
    throw new Error("Connected wallet must match the wallet on the account");
  }
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
  tokenDecimals: number;
  expectedTokenUnits: bigint;
  bonusCredits: number;
} {
  const metadata = metadataOf(payment);
  if (metadata.kind !== "direct_wallet_credit_purchase") {
    throw new Error("Payment is not a direct wallet payment");
  }
  const network = metadata.direct_network;
  if (network !== "base" && network !== "bsc" && network !== "solana") {
    throw new Error("Payment has invalid direct network metadata");
  }
  return {
    metadata,
    network,
    payerAddress: String(metadata.payer_wallet_address ?? ""),
    tokenDecimals: Number(metadata.token_decimals ?? 0),
    expectedTokenUnits: BigInt(String(metadata.expected_token_units ?? "0")),
    bonusCredits: Number(metadata.bonus_credits ?? 0),
  };
}

async function verifyEvmTokenPayment(params: {
  cfg: DirectWalletNetworkConfig;
  payerAddress: string;
  txHash: string;
  expectedUnits: bigint;
}): Promise<{ blockNumber: string; receivedUnits: bigint }> {
  if (!params.cfg.chainId || !params.cfg.tokenAddress || !params.cfg.receiveAddress) {
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
  if (tx.to?.toLowerCase() !== params.cfg.tokenAddress.toLowerCase()) {
    throw new Error("Transaction is not a transfer of the expected token");
  }

  const receiveAddress = normalizeEvmAddress(params.cfg.receiveAddress);
  const payerAddress = normalizeEvmAddress(params.payerAddress);
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
      event.address.toLowerCase() === params.cfg.tokenAddress?.toLowerCase() &&
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
  const tx = await connection.getParsedTransaction(params.txHash, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
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
  units: bigint;
}): Promise<Record<string, unknown> | null> {
  if (!params.cfg.tokenAddress || !params.cfg.secureAddress) return null;
  const privateKey = evmPrivateKey(params.env, params.cfg.network);
  if (!privateKey) return null;

  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    chain: params.cfg.network === "base" ? base : bsc,
    transport: http(params.cfg.rpcUrl),
  });
  const hash = await wallet.sendTransaction({
    to: params.cfg.tokenAddress,
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
      directPaymentConfig(env, network),
    );
    return {
      enabled: networks.some((network) => network.enabled),
      networks,
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
    assertAccountWalletMatches({
      network: params.network,
      accountWalletAddress: params.accountWalletAddress,
      payerAddress: params.payerAddress,
    });

    const amount = new Decimal(params.amountUsd);
    const validation = validatePaymentAmount(amount);
    if (!validation.valid) throw new Error(validation.error ?? "Invalid amount");

    const promoApplies =
      params.promoCode === "bsc" && params.network === "bsc" && amount.greaterThanOrEqualTo(10);
    const bonusCredits = promoApplies ? 5 : 0;
    const creditsToAdd = amount.plus(bonusCredits);
    const expectedTokenUnits = unitsForUsd(amount, cfg.tokenDecimals);
    const now = new Date();

    const payment = await cryptoPaymentsRepository.create({
      organization_id: params.organizationId,
      user_id: params.userId,
      payment_address: cfg.receiveAddress ?? "",
      token_address: cfg.tokenAddress ?? cfg.tokenMint ?? null,
      token: cfg.tokenSymbol,
      network: cfg.displayName,
      expected_amount: amount.toFixed(2),
      credits_to_add: creditsToAdd.toFixed(2),
      status: "pending",
      expires_at: new Date(now.getTime() + PAYMENT_EXPIRATION_MS),
      metadata: {
        kind: "direct_wallet_credit_purchase",
        provider: "wallet_native",
        direct_network: params.network,
        chain_id: cfg.chainId,
        payer_wallet_address: normalizePayer(params.network, params.payerAddress),
        receive_address: cfg.receiveAddress,
        secure_address_configured: Boolean(cfg.secureAddress),
        token_symbol: cfg.tokenSymbol,
        token_address: cfg.tokenAddress,
        token_mint: cfg.tokenMint,
        token_decimals: cfg.tokenDecimals,
        expected_token_units: expectedTokenUnits.toString(),
        expected_token_amount: formatUnitsAsTokenAmount(expectedTokenUnits, cfg.tokenDecimals),
        paid_amount_usd: amount.toFixed(2),
        bonus_credits: bonusCredits,
        promo_code: promoApplies ? "bsc" : null,
      },
    });

    return {
      payment,
      paymentInstructions: {
        network: params.network,
        chainId: cfg.chainId,
        tokenSymbol: cfg.tokenSymbol,
        tokenAddress: cfg.tokenAddress,
        tokenMint: cfg.tokenMint,
        tokenDecimals: cfg.tokenDecimals,
        receiveAddress: cfg.receiveAddress,
        amountUnits: expectedTokenUnits.toString(),
        amountToken: formatUnitsAsTokenAmount(expectedTokenUnits, cfg.tokenDecimals),
        amountUsd: amount.toFixed(2),
        creditsToAdd: creditsToAdd.toFixed(2),
        bonusCredits,
        expiresAt: payment.expires_at.toISOString(),
      },
    };
  }

  async confirmPayment(
    env: Bindings,
    params: { paymentId: string; txHash: string; userId: string },
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
      if (payment.status !== "pending") throw new Error(`Payment is ${payment.status}`);
      if (payment.expires_at < new Date()) throw new Error("Payment has expired");

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

      const verification =
        direct.network === "solana"
          ? await verifySolanaTokenPayment({
              cfg,
              payerAddress: direct.payerAddress,
              txHash: params.txHash,
              expectedUnits: direct.expectedTokenUnits,
            })
          : await verifyEvmTokenPayment({
              cfg,
              payerAddress: direct.payerAddress,
              txHash: params.txHash,
              expectedUnits: direct.expectedTokenUnits,
            });

      const amountPaid = new Decimal(payment.expected_amount);
      const creditsToAdd = new Decimal(payment.credits_to_add);
      const confirmedAt = new Date();
      const sweep =
        direct.network === "solana"
          ? await sweepSolanaIfConfigured({ env, cfg, units: verification.receivedUnits }).catch(
              (error) => ({ sweep_error: error instanceof Error ? error.message : String(error) }),
            )
          : await sweepEvmIfConfigured({ env, cfg, units: verification.receivedUnits }).catch(
              (error) => ({ sweep_error: error instanceof Error ? error.message : String(error) }),
            );

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
          ? `Direct crypto payment (${cfg.tokenSymbol} on ${cfg.displayName}) + BSC promotion`
          : `Direct crypto payment (${cfg.tokenSymbol} on ${cfg.displayName})`,
      stripePaymentIntentId: `wallet_native:${result.payment.id}`,
      metadata: {
        crypto_payment_id: result.payment.id,
        payment_method: "crypto",
        provider: "wallet_native",
        transaction_hash: params.txHash,
        network: direct.network,
        token: cfg.tokenSymbol,
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
          token: cfg.tokenSymbol,
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
}

export const directWalletPaymentsService = new DirectWalletPaymentsService();
