/**
 * Translates Aomi wallet envelopes into exact previews and wallet-backend operations.
 *
 * The plugin never reads signing keys. EVM and Solana identities come from
 * `WalletBackendService`, and this boundary returns only the result shape Aomi
 * needs to resume its suspended thread.
 */
import { createHash } from "node:crypto";

import {
  toViemSignMessageArgs,
  toViemSignTypedDataArgs,
  type WalletRequest,
  type WalletRequestResult,
  type WalletSolanaSignMessagePayload,
  type WalletSolanaSignPayload,
  type WalletTxCallPayload,
} from "@aomi-labs/client";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  WALLET_BACKEND_SERVICE_TYPE,
  type WalletBackendService,
} from "@elizaos/plugin-wallet";
import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  type Address,
  type Chain,
  createWalletClient,
  type Hex,
  http,
  isAddress,
  isHex,
} from "viem";
import * as viemChains from "viem/chains";
import type { AomiConfig } from "./config.js";

const EVM_RPC_TIMEOUT_MS = 10_000;

function walletService(runtime: IAgentRuntime): WalletBackendService {
  const service = runtime.getService<WalletBackendService>(
    WALLET_BACKEND_SERVICE_TYPE,
  );
  if (!service) {
    throw new ElizaError(
      "@elizaos/plugin-wallet must be loaded before Aomi can execute wallet requests.",
      {
        code: "AOMI_WALLET_SERVICE_UNAVAILABLE",
        severity: "fatal",
      },
    );
  }
  return service;
}

function isChain(value: unknown): value is Chain {
  if (!value || typeof value !== "object") return false;
  return (
    typeof Reflect.get(value, "id") === "number" &&
    typeof Reflect.get(value, "rpcUrls") === "object"
  );
}

function chainFromId(chainId: number): Chain {
  const chain = Object.values(viemChains).find(
    (candidate) => isChain(candidate) && candidate.id === chainId,
  );
  if (!chain || !isChain(chain)) {
    throw new ElizaError(`Aomi requested unsupported EVM chain ${chainId}.`, {
      code: "AOMI_UNSUPPORTED_EVM_CHAIN",
      context: { chainId },
      severity: "fatal",
    });
  }
  return chain;
}

function parseBigInt(
  value: string | undefined,
  field: "value" | "gas",
): bigint | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    return BigInt(value);
  } catch (cause) {
    // error-policy:J2 Preserve the untrusted envelope value and parse cause.
    throw new ElizaError(`Aomi EVM ${field} must be an integer string.`, {
      code: "AOMI_INVALID_EVM_CALL",
      context: { field, value },
      cause,
      severity: "fatal",
    });
  }
}

function requestCalls(
  request: Extract<WalletRequest, { kind: "transaction" }>,
): {
  readonly chainId: number;
  readonly calls: readonly WalletTxCallPayload[];
} {
  const payload = request.payload;
  const calls =
    payload.calls && payload.calls.length > 0
      ? payload.calls
      : payload.to
        ? [
            {
              txId: payload.txId ?? payload.txIds?.[0] ?? 0,
              to: payload.to,
              value: payload.value,
              data: payload.data,
              chainId: payload.chainId,
            },
          ]
        : [];
  if (calls.length === 0) {
    throw new ElizaError("Aomi EVM request did not include call data.", {
      code: "AOMI_INVALID_EVM_CALL",
      severity: "fatal",
    });
  }
  if (calls.length > 1) {
    throw new ElizaError(
      "Aomi requested an EVM batch, but the configured Eliza wallet has no atomic batch primitive.",
      {
        code: "AOMI_ATOMIC_BATCH_UNAVAILABLE",
        context: { callCount: calls.length },
        severity: "fatal",
      },
    );
  }

  const chainId = calls[0].chainId ?? payload.chainId;
  if (!chainId || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new ElizaError("Aomi EVM request did not include a valid chain id.", {
      code: "AOMI_INVALID_EVM_CALL",
      severity: "fatal",
    });
  }
  return { chainId, calls };
}

function validateEvmCall(call: WalletTxCallPayload): {
  readonly to: Address;
  readonly value?: bigint;
  readonly data?: Hex;
  readonly gas?: bigint;
} {
  if (!isAddress(call.to)) {
    throw new ElizaError(
      "Aomi EVM request contains an invalid target address.",
      {
        code: "AOMI_INVALID_EVM_CALL",
        context: { to: call.to },
        severity: "fatal",
      },
    );
  }
  if (call.data !== undefined && !isHex(call.data)) {
    throw new ElizaError("Aomi EVM request contains invalid calldata.", {
      code: "AOMI_INVALID_EVM_CALL",
      context: { to: call.to },
      severity: "fatal",
    });
  }
  return {
    to: call.to,
    value: parseBigInt(call.value, "value"),
    data: call.data,
    gas: parseBigInt(call.gas, "gas"),
  };
}

function evmRpcUrl(
  runtime: IAgentRuntime,
  config: AomiConfig,
  chain: Chain,
): string {
  const perChain = runtime.getSetting(`EVM_RPC_URL_${chain.id}`);
  if (typeof perChain === "string" && perChain.trim()) return perChain.trim();
  if (config.evmRpcUrl) return config.evmRpcUrl;
  const defaultUrl = chain.rpcUrls.default.http[0];
  if (!defaultUrl) {
    throw new ElizaError(`No RPC URL is available for EVM chain ${chain.id}.`, {
      code: "AOMI_EVM_RPC_UNAVAILABLE",
      context: { chainId: chain.id },
      severity: "fatal",
    });
  }
  return defaultUrl;
}

async function executeEvmTransaction(
  runtime: IAgentRuntime,
  config: AomiConfig,
  request: Extract<WalletRequest, { kind: "transaction" }>,
): Promise<WalletRequestResult> {
  const { chainId, calls } = requestCalls(request);
  const call = validateEvmCall(calls[0]);
  const chain = chainFromId(chainId);
  const account = walletService(runtime)
    .getWalletBackend()
    .getEvmAccount(chainId);
  const wallet = createWalletClient({
    account,
    chain,
    transport: http(evmRpcUrl(runtime, config, chain), {
      timeout: EVM_RPC_TIMEOUT_MS,
      retryCount: 0,
    }),
  });
  const txHash = await wallet.sendTransaction({
    account,
    chain,
    to: call.to,
    value: call.value,
    data: call.data,
    gas: call.gas,
  });
  return {
    kind: "transaction",
    txHash,
    aaRequestedMode: "none",
    aaResolvedMode: "none",
    executionKind: "eoa",
    batched: false,
    callCount: 1,
    sponsored: false,
  };
}

function eip712ChainId(
  request: Extract<WalletRequest, { kind: "eip712_sign" }>,
  fallback: number,
): number {
  const value = request.payload.typed_data?.domain?.chainId;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? value.startsWith("0x")
          ? Number.parseInt(value.slice(2), 16)
          : Number.parseInt(value, 10)
        : fallback;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function executeEip712(
  runtime: IAgentRuntime,
  config: AomiConfig,
  request: Extract<WalletRequest, { kind: "eip712_sign" }>,
): Promise<WalletRequestResult> {
  const account = walletService(runtime)
    .getWalletBackend()
    .getEvmAccount(eip712ChainId(request, config.chainId));
  const typed = toViemSignTypedDataArgs(request.payload);
  if (typed?.message) {
    if (!account.signTypedData) {
      throw new ElizaError(
        "The configured Eliza wallet cannot sign EIP-712 payloads.",
        {
          code: "AOMI_EIP712_UNAVAILABLE",
          severity: "fatal",
        },
      );
    }
    const signature = await account.signTypedData({
      ...typed,
      message: typed.message,
    });
    return { kind: "eip712_sign", signature };
  }

  const message = toViemSignMessageArgs(request.payload);
  if (!message) {
    throw new ElizaError(
      "Aomi signature request contains no signable payload.",
      {
        code: "AOMI_INVALID_EIP712_REQUEST",
        severity: "fatal",
      },
    );
  }
  if (!account.signMessage) {
    throw new ElizaError(
      "The configured Eliza wallet cannot sign EVM messages.",
      {
        code: "AOMI_EVM_MESSAGE_SIGN_UNAVAILABLE",
        severity: "fatal",
      },
    );
  }
  const signature = await account.signMessage(message);
  return { kind: "eip712_sign", signature };
}

function decodeBase64(value: string, field: string): Uint8Array {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new ElizaError(`Aomi ${field} must be valid base64.`, {
      code: "AOMI_INVALID_SOLANA_REQUEST",
      context: { field },
      severity: "fatal",
    });
  }
  const bytes = Buffer.from(normalized, "base64");
  const canonical = bytes.toString("base64");
  if (
    bytes.length === 0 ||
    canonical.replace(/=+$/, "") !== normalized.replace(/=+$/, "")
  ) {
    throw new ElizaError(`Aomi ${field} must be valid non-empty base64.`, {
      code: "AOMI_INVALID_SOLANA_REQUEST",
      context: { field },
      severity: "fatal",
    });
  }
  return bytes;
}

function payloadDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable payload]";
  }
}

function solanaTransactionSummary(unsignedTx: string): string[] {
  const bytes = decodeBase64(unsignedTx, "unsigned transaction");
  const digest = payloadDigest(bytes);
  try {
    const transaction = VersionedTransaction.deserialize(bytes);
    const staticKeys = transaction.message.staticAccountKeys;
    const programs = transaction.message.compiledInstructions.map(
      (instruction) =>
        staticKeys[instruction.programIdIndex]?.toBase58() ??
        `lookup-table-index:${instruction.programIdIndex}`,
    );
    return [
      `Fee payer: ${staticKeys[0]?.toBase58() ?? "unknown"}`,
      `Instructions: ${transaction.message.compiledInstructions.length}`,
      `Programs: ${[...new Set(programs)].join(", ") || "none"}`,
      `Payload: ${bytes.length} bytes, sha256:${digest}`,
    ];
  } catch {
    try {
      const transaction = Transaction.from(bytes);
      const programs = transaction.instructions.map((instruction) =>
        instruction.programId.toBase58(),
      );
      return [
        `Fee payer: ${transaction.feePayer?.toBase58() ?? "unknown"}`,
        `Instructions: ${transaction.instructions.length}`,
        `Programs: ${[...new Set(programs)].join(", ") || "none"}`,
        `Payload: ${bytes.length} bytes, sha256:${digest}`,
      ];
    } catch (cause) {
      throw new ElizaError(
        "Aomi Solana transaction is neither a valid versioned nor legacy transaction.",
        {
          code: "AOMI_INVALID_SOLANA_REQUEST",
          cause,
          severity: "fatal",
        },
      );
    }
  }
}

async function signSolanaTransaction(
  runtime: IAgentRuntime,
  payload: WalletSolanaSignPayload,
): Promise<string> {
  if (!payload.unsignedTx) {
    throw new ElizaError(
      "Aomi Solana request is missing unsigned transaction bytes.",
      {
        code: "AOMI_INVALID_SOLANA_REQUEST",
        severity: "fatal",
      },
    );
  }
  const bytes = decodeBase64(payload.unsignedTx, "unsigned transaction");
  const signer = walletService(runtime).getWalletBackend().getSolanaSigner();

  let versioned: VersionedTransaction | null = null;
  try {
    versioned = VersionedTransaction.deserialize(bytes);
  } catch {
    versioned = null;
  }
  if (versioned) {
    const signed = await signer.signTransaction(versioned);
    return Buffer.from(signed.serialize()).toString("base64");
  }

  let legacy: Transaction;
  try {
    legacy = Transaction.from(bytes);
  } catch (cause) {
    // error-policy:J2 Surface invalid legacy bytes after versioned decoding failed.
    throw new ElizaError(
      "Aomi Solana transaction is neither a valid versioned nor legacy transaction.",
      {
        code: "AOMI_INVALID_SOLANA_REQUEST",
        cause,
        severity: "fatal",
      },
    );
  }
  const signed = await signer.signTransaction(legacy);
  return Buffer.from(
    signed.serialize({
      requireAllSignatures: true,
      verifySignatures: true,
    }),
  ).toString("base64");
}

function solanaRpcUrl(runtime: IAgentRuntime, cluster?: string): string {
  const configured = runtime.getSetting("SOLANA_RPC_URL");
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  if (cluster?.includes("devnet")) return "https://api.devnet.solana.com";
  if (cluster?.includes("testnet")) return "https://api.testnet.solana.com";
  return "https://api.mainnet-beta.solana.com";
}

async function sendSolanaTransaction(
  runtime: IAgentRuntime,
  payload: WalletSolanaSignPayload,
  signedTx: string,
): Promise<string> {
  const connection = new Connection(solanaRpcUrl(runtime, payload.cluster), {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });
  const signature = await connection.sendRawTransaction(
    Buffer.from(signedTx, "base64"),
    { skipPreflight: false, maxRetries: 3 },
  );
  const confirmation = await connection.confirmTransaction(
    signature,
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new ElizaError(`Solana transaction ${signature} failed.`, {
      code: "AOMI_SOLANA_TRANSACTION_FAILED",
      context: { signature, err: confirmation.value.err },
      severity: "fatal",
    });
  }
  return signature;
}

async function executeSolana(
  runtime: IAgentRuntime,
  request: Exclude<
    WalletRequest,
    { kind: "transaction" } | { kind: "eip712_sign" }
  >,
): Promise<WalletRequestResult> {
  if (request.kind === "solana_sign_message") {
    const payload = request.payload as WalletSolanaSignMessagePayload;
    if (!payload.message) {
      throw new ElizaError(
        "Aomi Solana message request is missing message bytes.",
        {
          code: "AOMI_INVALID_SOLANA_REQUEST",
          severity: "fatal",
        },
      );
    }
    const signer = walletService(runtime).getWalletBackend().getSolanaSigner();
    const signature = await signer.signMessage(
      decodeBase64(payload.message, "message"),
    );
    return {
      kind: "solana_sign_message",
      signature: Buffer.from(signature).toString("base64"),
    };
  }

  const signedTx = await signSolanaTransaction(runtime, request.payload);
  if (request.kind === "solana_sign") {
    return { kind: "solana_sign", signedTx };
  }
  const signature = await sendSolanaTransaction(
    runtime,
    request.payload,
    signedTx,
  );
  return { kind: request.kind, signature, signedTx };
}

export function walletRequestSupportError(
  request: WalletRequest,
): string | null {
  if (
    request.kind === "transaction" &&
    request.payload.calls &&
    request.payload.calls.length > 1
  ) {
    return "Atomic EVM batches are unavailable with the configured Eliza wallet.";
  }
  return null;
}

export function walletRequestPreview(request: WalletRequest): string {
  if (request.kind === "transaction") {
    const calls =
      request.payload.calls && request.payload.calls.length > 0
        ? request.payload.calls
        : request.payload.to
          ? [
              {
                to: request.payload.to,
                value: request.payload.value,
                gas: undefined,
                data: request.payload.data,
                chainId: request.payload.chainId,
              },
            ]
          : [];
    const call = calls[0];
    return [
      "Aomi prepared an EVM transaction.",
      `Chain: ${call?.chainId ?? request.payload.chainId ?? "unknown"}`,
      `Target: ${call?.to ?? "missing"}`,
      `Value (wei): ${call?.value ?? "0"}`,
      `Gas limit: ${call?.gas ?? "automatic"}`,
      `Calldata: ${call?.data ?? "0x"}`,
      `Calls: ${calls.length}`,
      "Reply yes to sign and submit, or anything else to reject.",
    ].join("\n");
  }
  if (request.kind === "eip712_sign") {
    const primaryType =
      request.payload.typed_data?.primaryType ??
      (request.payload.non_typed_data ? "personal message" : "unknown");
    return [
      "Aomi prepared an EVM signature request.",
      `Type: ${primaryType}`,
      `Description: ${request.payload.description ?? "not provided"}`,
      ...(request.payload.typed_data
        ? [
            `Domain: ${safeJson(request.payload.typed_data.domain ?? {})}`,
            `Message: ${safeJson(request.payload.typed_data.message ?? {})}`,
          ]
        : [`Message: ${request.payload.non_typed_data ?? "missing"}`]),
      "Reply yes to sign, or anything else to reject.",
    ].join("\n");
  }
  const payloadLines =
    request.kind === "solana_sign_message"
      ? (() => {
          const bytes = decodeBase64(request.payload.message ?? "", "message");
          return [
            `Message (base64): ${request.payload.message}`,
            `Payload: ${bytes.length} bytes, sha256:${payloadDigest(bytes)}`,
          ];
        })()
      : request.payload.unsignedTx
        ? solanaTransactionSummary(request.payload.unsignedTx)
        : ["Payload: missing unsigned transaction"];
  return [
    `Aomi prepared a Solana ${request.kind.replaceAll("_", " ")} request.`,
    `Cluster: ${request.payload.cluster ?? "solana:mainnet"}`,
    `Description: ${request.payload.description ?? "not provided"}`,
    ...payloadLines,
    request.kind === "solana_sign" || request.kind === "solana_sign_message"
      ? "Reply yes to sign, or anything else to reject."
      : "Reply yes to sign and submit, or anything else to reject.",
  ].join("\n");
}

export async function executeWalletRequest(
  runtime: IAgentRuntime,
  config: AomiConfig,
  request: WalletRequest,
): Promise<WalletRequestResult> {
  if (request.kind === "transaction") {
    return executeEvmTransaction(runtime, config, request);
  }
  if (request.kind === "eip712_sign") {
    return executeEip712(runtime, config, request);
  }
  return executeSolana(runtime, request);
}
