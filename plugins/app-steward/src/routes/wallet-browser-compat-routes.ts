import crypto from "node:crypto";
import type http from "node:http";
import { loadElizaConfig } from "@elizaos/agent";
import { ensureCompatApiAuthorized } from "@elizaos/app-core";
import {
  type CompatRuntimeState,
  readCompatJsonBody,
} from "@elizaos/app-core";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "@elizaos/app-core";
import { ethers } from "ethers";
import { deriveSolanaAddress } from "../api/wallet";
import { resolveWalletRpcReadiness } from "../api/wallet-rpc";
import type { StewardSignRequest } from "../types/steward";

/** @internal Exported for testing. Parse a transaction value string to BigInt. */
export function safeParseBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(
      `Invalid transaction value: expected an integer or hex string, got "${value}"`,
    );
  }
}

import { isStewardConfigured, signViaSteward } from "./steward-bridge";

function normalizeHexData(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const SOLANA_PKCS8_DER_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function resolveLocalBrowserWallet(): ethers.Wallet {
  const evmKey = normalizeString(process.env.EVM_PRIVATE_KEY);
  if (!evmKey) {
    throw new Error("Local wallet signing is unavailable.");
  }
  return new ethers.Wallet(evmKey.startsWith("0x") ? evmKey : `0x${evmKey}`);
}

function base58Decode(value: string): Buffer {
  if (!value.length) {
    return Buffer.alloc(0);
  }
  let number = 0n;
  for (const character of value) {
    const index = B58.indexOf(character);
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

function decodeLocalSolanaPrivateKey(value: string): Buffer {
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
  return base58Decode(trimmed);
}

function resolveLocalSolanaSeed(): { address: string; seed: Buffer } {
  const solanaKey = normalizeString(process.env.SOLANA_PRIVATE_KEY);
  if (!solanaKey) {
    throw new Error("Local Solana signing is unavailable.");
  }
  const decoded = decodeLocalSolanaPrivateKey(solanaKey);
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

function resolveSolanaMessageBytes(body: Record<string, unknown>): Buffer {
  const messageBase64 = normalizeString(body.messageBase64);
  if (messageBase64) {
    return Buffer.from(messageBase64, "base64");
  }
  const message = normalizeString(body.message);
  if (!message) {
    throw new Error("message or messageBase64 is required.");
  }
  return Buffer.from(message, "utf8");
}

let cachedRpcReadiness: ReturnType<typeof resolveWalletRpcReadiness> | null =
  null;
let cachedRpcReadinessAt = 0;
const RPC_CACHE_TTL_MS = 30_000;

function resolvePreferredRpcUrl(chainId: number): string | null {
  const now = Date.now();
  if (!cachedRpcReadiness || now - cachedRpcReadinessAt > RPC_CACHE_TTL_MS) {
    cachedRpcReadiness = resolveWalletRpcReadiness(loadElizaConfig());
    cachedRpcReadinessAt = now;
  }
  const readiness = cachedRpcReadiness;
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
  request: StewardSignRequest,
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

  const rpcUrl = resolvePreferredRpcUrl(request.chainId);
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for chain ${request.chainId}.`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  try {
    const wallet = resolveLocalBrowserWallet().connect(provider);
    const txResponse = await wallet.sendTransaction({
      chainId: request.chainId,
      data: request.data,
      to: request.to,
      value: safeParseBigInt(request.value),
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
  const wallet = resolveLocalBrowserWallet();
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
  const { address, seed } = resolveLocalSolanaSeed();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([SOLANA_PKCS8_DER_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const signature = crypto.sign(
    null,
    resolveSolanaMessageBytes(body),
    privateKey,
  );
  return {
    address,
    mode: "local-key",
    signatureBase64: signature.toString("base64"),
  };
}

type SolanaCluster = "mainnet" | "devnet" | "testnet";

interface SolanaWeb3Module {
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

const SOLANA_WEB3_PACKAGE: string = "@solana/web3.js";

async function loadSolanaWeb3(): Promise<SolanaWeb3Module> {
  return (await import(SOLANA_WEB3_PACKAGE)) as SolanaWeb3Module;
}

function normalizeSolanaCluster(value: unknown): SolanaCluster {
  if (value === "devnet" || value === "testnet" || value === "mainnet") {
    return value;
  }
  return "mainnet";
}

function clusterRpcUrl(cluster: SolanaCluster): string {
  switch (cluster) {
    case "devnet":
      return "https://api.devnet.solana.com";
    case "testnet":
      return "https://api.testnet.solana.com";
    default:
      return "https://api.mainnet-beta.solana.com";
  }
}

async function signLocalBrowserSolanaTransaction(
  body: Record<string, unknown>,
): Promise<{
  address: string;
  mode: "local-key";
  signedTransactionBase64: string;
  signature?: string;
  cluster: SolanaCluster;
}> {
  const transactionBase64 = normalizeString(body.transactionBase64);
  if (!transactionBase64) {
    throw new Error("transactionBase64 is required.");
  }
  const broadcast = normalizeBoolean(body.broadcast, false);
  const cluster = normalizeSolanaCluster(body.cluster);

  const { address, seed } = resolveLocalSolanaSeed();

  const web3 = await loadSolanaWeb3();
  const { Keypair, VersionedTransaction, Transaction, Connection } = web3;

  const keypair = Keypair.fromSeed(new Uint8Array(seed));
  const txBytes = Buffer.from(transactionBase64, "base64");

  // Solana transactions have a single-byte version prefix on v0/versioned
  // transactions (high bit set). Try the versioned path first; fall back to
  // legacy on parse failure to support both shapes uniformly.
  let signedBytes: Uint8Array;
  let broadcastSignature: string | undefined;
  try {
    const versioned = VersionedTransaction.deserialize(txBytes);
    versioned.sign([keypair]);
    signedBytes = versioned.serialize();
    if (broadcast) {
      const conn = new Connection(clusterRpcUrl(cluster), "confirmed");
      broadcastSignature = await conn.sendRawTransaction(signedBytes);
    }
  } catch (_err) {
    const legacy = Transaction.from(txBytes);
    legacy.partialSign(keypair);
    signedBytes = legacy.serialize();
    if (broadcast) {
      const conn = new Connection(clusterRpcUrl(cluster), "confirmed");
      broadcastSignature = await conn.sendRawTransaction(signedBytes);
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

export async function handleWalletBrowserCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (
    method !== "POST" ||
    (url.pathname !== "/api/wallet/browser-transaction" &&
      url.pathname !== "/api/wallet/browser-sign-message" &&
      url.pathname !== "/api/wallet/browser-solana-sign-message" &&
      url.pathname !== "/api/wallet/browser-solana-transaction")
  ) {
    return false;
  }

  if (!ensureCompatApiAuthorized(req, res)) {
    return true;
  }

  const body = await readCompatJsonBody(req, res);
  if (!body) {
    return true;
  }

  const hasLocalKey = Boolean(normalizeString(process.env.EVM_PRIVATE_KEY));
  const hasLocalSolanaKey = Boolean(
    normalizeString(process.env.SOLANA_PRIVATE_KEY),
  );
  let stewardError: Error | null = null;

  if (url.pathname === "/api/wallet/browser-sign-message") {
    const message = normalizeString(body.message);
    if (!message) {
      sendJsonErrorResponse(res, 400, "message is required.");
      return true;
    }

    if (hasLocalKey) {
      try {
        sendJsonResponse(
          res,
          200,
          await signLocalBrowserWalletMessage(message),
        );
        return true;
      } catch (error) {
        const failureMessage =
          error instanceof Error ? error.message : String(error);
        sendJsonErrorResponse(res, 503, failureMessage);
        return true;
      }
    }

    sendJsonErrorResponse(
      res,
      503,
      isStewardConfigured()
        ? "Browser message signing currently requires a local wallet key."
        : "No browser wallet signer is available.",
    );
    return true;
  }

  if (url.pathname === "/api/wallet/browser-solana-sign-message") {
    if (hasLocalSolanaKey) {
      try {
        sendJsonResponse(res, 200, await signLocalBrowserSolanaMessage(body));
        return true;
      } catch (error) {
        const failureMessage =
          error instanceof Error ? error.message : String(error);
        sendJsonErrorResponse(res, 503, failureMessage);
        return true;
      }
    }

    sendJsonErrorResponse(res, 503, "No browser Solana signer is available.");
    return true;
  }

  if (url.pathname === "/api/wallet/browser-solana-transaction") {
    if (hasLocalSolanaKey) {
      try {
        sendJsonResponse(
          res,
          200,
          await signLocalBrowserSolanaTransaction(body),
        );
        return true;
      } catch (error) {
        const failureMessage =
          error instanceof Error ? error.message : String(error);
        sendJsonErrorResponse(res, 503, failureMessage);
        return true;
      }
    }

    sendJsonErrorResponse(
      res,
      503,
      "No browser Solana transaction signer is available.",
    );
    return true;
  }

  const request: StewardSignRequest = {
    broadcast: normalizeBoolean(body.broadcast, true),
    chainId:
      typeof body.chainId === "number" && Number.isFinite(body.chainId)
        ? body.chainId
        : Number.NaN,
    data: normalizeHexData(body.data),
    description: normalizeString(body.description),
    to: normalizeString(body.to) ?? "",
    value: normalizeString(body.value) ?? "0",
  };

  if (!request.to || !request.value || !Number.isFinite(request.chainId)) {
    sendJsonErrorResponse(
      res,
      400,
      "to, value, and a valid chainId are required.",
    );
    return true;
  }

  if (isStewardConfigured()) {
    try {
      const result = await signViaSteward(request);
      sendJsonResponse(res, 200, {
        ...result,
        mode: "steward",
      });
      return true;
    } catch (error) {
      stewardError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (hasLocalKey) {
    try {
      sendJsonResponse(
        res,
        200,
        await sendLocalBrowserWalletTransaction(request),
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJsonErrorResponse(res, 503, message);
      return true;
    }
  }

  sendJsonErrorResponse(
    res,
    503,
    stewardError?.message || "No browser wallet signer is available.",
  );
  return true;
}
