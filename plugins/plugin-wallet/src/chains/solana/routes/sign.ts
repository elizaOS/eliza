/**
 * Browser-facing Solana signing endpoints.
 *
 * These endpoints let an in-browser dApp request a signature from the agent's
 * resident keypair via the wallet backend. They are gated by a single shared
 * bearer token (`WALLET_BROWSER_SIGN_TOKEN`) — without that token set, every
 * route returns 503 so the surface is closed by default.
 *
 * The companion JS shim in `../../../browser-shim/` bakes the token into a
 * registered Wallet-Standard provider and proxies `signTransaction` /
 * `signMessage` / `signAndSendTransaction` to these routes. CORS is permissive
 * (any origin, with the token as the actual auth) because the shim runs inside
 * arbitrary dApp pages whose origin is not knowable in advance.
 */

import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { Connection, type SendOptions, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { resolveWalletBackend } from "../../../wallet/select-backend";
import type { SolanaService } from "../service";

type RouteHandler = NonNullable<Route["handler"]>;

interface JsonResponse {
  status: (code: number) => JsonResponse;
  json: (body: unknown) => void;
  setHeader?: (name: string, value: string) => void;
}

function setCorsHeaders(req: RouteRequest, res: RouteResponse): void {
  const origin = (req.headers?.origin as string | undefined) ?? "*";
  const r = res as unknown as JsonResponse & {
    setHeader?: (name: string, value: string) => void;
  };
  r.setHeader?.("Access-Control-Allow-Origin", origin);
  r.setHeader?.("Vary", "Origin");
  r.setHeader?.("Access-Control-Allow-Methods", "POST, OPTIONS");
  r.setHeader?.("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Wallet-Sign-Token");
  r.setHeader?.("Access-Control-Allow-Credentials", "true");
  r.setHeader?.("Access-Control-Max-Age", "600");
}

function readSignToken(runtime: IAgentRuntime): string | null {
  const fromRuntime = runtime.getSetting("WALLET_BROWSER_SIGN_TOKEN");
  if (typeof fromRuntime === "string" && fromRuntime.trim().length >= 16) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env.WALLET_BROWSER_SIGN_TOKEN?.trim();
  if (fromEnv && fromEnv.length >= 16) {
    return fromEnv;
  }
  return null;
}

function readBearer(req: RouteRequest): string | null {
  const auth = req.headers?.authorization as string | undefined;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  const x = req.headers?.["x-wallet-sign-token"] as string | undefined;
  if (typeof x === "string" && x.length > 0) return x.trim();
  return null;
}

function authorize(req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime): boolean {
  setCorsHeaders(req, res);
  if ((req as unknown as { method?: string }).method === "OPTIONS") {
    res.status(204).json({});
    return false;
  }
  const expected = readSignToken(runtime);
  if (!expected) {
    res.status(503).json({ error: "WALLET_BROWSER_SIGN_TOKEN not configured" });
    return false;
  }
  const got = readBearer(req);
  if (got !== expected) {
    res.status(401).json({ error: "invalid sign token" });
    return false;
  }
  return true;
}

function decodeBase64(s: string): Uint8Array {
  const buf = Buffer.from(s, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeTransaction(b64: string): Transaction | VersionedTransaction {
  const raw = decodeBase64(b64);
  // Try versioned first; fall back to legacy.
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    return Transaction.from(raw);
  }
}

function serializeTransaction(tx: Transaction | VersionedTransaction): Uint8Array {
  if (tx instanceof VersionedTransaction) {
    return tx.serialize();
  }
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

const pubkeyHandler: RouteHandler = async (req, res, runtime) => {
  if (!authorize(req, res, runtime)) return;
  try {
    const backend = await resolveWalletBackend(runtime);
    const addrs = backend.getAddresses();
    if (!addrs.solana) {
      res.status(404).json({ error: "no solana key configured" });
      return;
    }
    res.status(200).json({ publicKey: addrs.solana.toBase58() });
  } catch (err) {
    logger.error({ err }, "[wallet/solana/pubkey] failed");
    res.status(500).json({ error: (err as Error).message });
  }
};

const signTransactionHandler: RouteHandler = async (req, res, runtime) => {
  if (!authorize(req, res, runtime)) return;
  try {
    const body = (req.body ?? {}) as { transactionBase64?: unknown };
    if (typeof body.transactionBase64 !== "string") {
      res.status(400).json({ error: "transactionBase64 required" });
      return;
    }
    const backend = await resolveWalletBackend(runtime);
    const signer = backend.getSolanaSigner();
    const tx = decodeTransaction(body.transactionBase64);
    const signed = await signer.signTransaction(tx);
    res.status(200).json({
      signedBase64: encodeBase64(serializeTransaction(signed)),
      publicKey: signer.publicKey.toBase58(),
    });
  } catch (err) {
    logger.error({ err }, "[wallet/solana/sign-transaction] failed");
    res.status(500).json({ error: (err as Error).message });
  }
};

const signAllTransactionsHandler: RouteHandler = async (req, res, runtime) => {
  if (!authorize(req, res, runtime)) return;
  try {
    const body = (req.body ?? {}) as { transactionsBase64?: unknown };
    if (
      !Array.isArray(body.transactionsBase64) ||
      !body.transactionsBase64.every((s) => typeof s === "string")
    ) {
      res.status(400).json({ error: "transactionsBase64 string[] required" });
      return;
    }
    const backend = await resolveWalletBackend(runtime);
    const signer = backend.getSolanaSigner();
    const txs = (body.transactionsBase64 as string[]).map((b64) => decodeTransaction(b64));
    const signed = await signer.signAllTransactions(txs);
    res.status(200).json({
      signedBase64s: signed.map((tx) => encodeBase64(serializeTransaction(tx))),
      publicKey: signer.publicKey.toBase58(),
    });
  } catch (err) {
    logger.error({ err }, "[wallet/solana/sign-all-transactions] failed");
    res.status(500).json({ error: (err as Error).message });
  }
};

const signMessageHandler: RouteHandler = async (req, res, runtime) => {
  if (!authorize(req, res, runtime)) return;
  try {
    const body = (req.body ?? {}) as { messageBase64?: unknown };
    if (typeof body.messageBase64 !== "string") {
      res.status(400).json({ error: "messageBase64 required" });
      return;
    }
    const backend = await resolveWalletBackend(runtime);
    const signer = backend.getSolanaSigner();
    const messageBytes = decodeBase64(body.messageBase64);
    const sig = await signer.signMessage(messageBytes);
    res.status(200).json({
      signatureBase64: encodeBase64(sig),
      signatureBase58: bs58.encode(sig),
      publicKey: signer.publicKey.toBase58(),
    });
  } catch (err) {
    logger.error({ err }, "[wallet/solana/sign-message] failed");
    res.status(500).json({ error: (err as Error).message });
  }
};

const signAndSendHandler: RouteHandler = async (req, res, runtime) => {
  if (!authorize(req, res, runtime)) return;
  try {
    const body = (req.body ?? {}) as {
      transactionBase64?: unknown;
      sendOptions?: unknown;
    };
    if (typeof body.transactionBase64 !== "string") {
      res.status(400).json({ error: "transactionBase64 required" });
      return;
    }
    const backend = await resolveWalletBackend(runtime);
    const signer = backend.getSolanaSigner();
    const tx = decodeTransaction(body.transactionBase64);
    const signed = await signer.signTransaction(tx);

    const solanaService = runtime.getService<SolanaService>("chain_solana");
    const rpcUrl =
      (runtime.getSetting("SOLANA_RPC_URL") as string | undefined) ??
      process.env.SOLANA_RPC_URL ??
      "https://api.mainnet-beta.solana.com";
    const conn =
      solanaService && typeof solanaService === "object" && "connection" in solanaService
        ? ((solanaService as unknown as { connection: Connection }).connection ??
          new Connection(rpcUrl, "confirmed"))
        : new Connection(rpcUrl, "confirmed");

    const sendOptions: SendOptions =
      body.sendOptions && typeof body.sendOptions === "object"
        ? (body.sendOptions as SendOptions)
        : { skipPreflight: false, maxRetries: 3 };

    const signature = await conn.sendRawTransaction(serializeTransaction(signed), sendOptions);
    res.status(200).json({
      signature,
      publicKey: signer.publicKey.toBase58(),
    });
  } catch (err) {
    logger.error({ err }, "[wallet/solana/sign-and-send-transaction] failed");
    res.status(500).json({ error: (err as Error).message });
  }
};

export const solanaSignRoutes: Route[] = [
  {
    type: "GET",
    path: "/wallet/solana/pubkey",
    public: true,
    name: "wallet-solana-pubkey",
    handler: pubkeyHandler,
  },
  {
    type: "POST",
    path: "/wallet/solana/pubkey",
    public: true,
    name: "wallet-solana-pubkey-post",
    handler: pubkeyHandler,
  },
  {
    type: "POST",
    path: "/wallet/solana/sign-transaction",
    public: true,
    name: "wallet-solana-sign-transaction",
    handler: signTransactionHandler,
  },
  {
    type: "POST",
    path: "/wallet/solana/sign-all-transactions",
    public: true,
    name: "wallet-solana-sign-all-transactions",
    handler: signAllTransactionsHandler,
  },
  {
    type: "POST",
    path: "/wallet/solana/sign-message",
    public: true,
    name: "wallet-solana-sign-message",
    handler: signMessageHandler,
  },
  {
    type: "POST",
    path: "/wallet/solana/sign-and-send-transaction",
    public: true,
    name: "wallet-solana-sign-and-send-transaction",
    handler: signAndSendHandler,
  },
];
