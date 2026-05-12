/**
 * Standalone wallet sign HTTP server — exposes the same routes that
 * `@elizaos/plugin-wallet` registers in production, but without booting the
 * full agent runtime. Used by `launch-pumpfun.ts` and any other browser-driven
 * wallet test that just needs an endpoint to sign with.
 *
 * Routes (all gated by `Authorization: Bearer ${signToken}`):
 *   GET  /wallet/solana/pubkey
 *   POST /wallet/solana/sign-transaction      { transactionBase64 }
 *   POST /wallet/solana/sign-all-transactions { transactionsBase64: string[] }
 *   POST /wallet/solana/sign-message          { messageBase64 }
 *   POST /wallet/solana/sign-and-send-transaction { transactionBase64, sendOptions? }
 *   GET  /wallet/evm/address
 *   POST /wallet/evm/personal-sign            { message }
 *   POST /wallet/evm/sign-typed-data          { typedData }
 *   POST /wallet/evm/sign-transaction         { chainId, tx }
 *   POST /wallet/evm/send-transaction         { chainId, tx }
 */

import http from "node:http";
import {
  Connection,
  Keypair,
  type SendOptions,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  type Address,
  type Chain,
  createWalletClient,
  type Hex,
  http as viemHttp,
  publicActions,
  type TypedDataDefinition,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";

export interface SignServerConfig {
  port: number;
  signToken: string;
  solanaSecretKeyBase58?: string;
  evmPrivateKey?: `0x${string}`;
  solanaRpcUrl?: string;
  evmRpcByChainId?: Record<number, string>;
}

export interface SignServerHandle {
  url: string;
  port: number;
  solanaPublicKey: string | null;
  evmAddress: `0x${string}` | null;
  close(): Promise<void>;
}

function decodeBase64(s: string): Uint8Array {
  const buf = Buffer.from(s, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function loadSolanaKeypair(b58: string): Keypair {
  const decoded = bs58.decode(b58);
  if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
  if (decoded.length === 32) return Keypair.fromSeed(decoded);
  throw new Error(
    `solana key decodes to ${decoded.length} bytes (expected 32 or 64)`,
  );
}

function chainFromId(id: number): Chain {
  const all = Object.values(viemChains) as Chain[];
  const hit = all.find((c) => typeof c?.id === "number" && c.id === id);
  if (!hit) throw new Error(`unsupported EVM chainId: ${id}`);
  return hit;
}

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = (req.headers.origin as string | undefined) ?? "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Wallet-Sign-Token",
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function bearerOk(req: http.IncomingMessage, expected: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim() === expected;
  }
  const x = req.headers["x-wallet-sign-token"];
  if (typeof x === "string") return x.trim() === expected;
  return false;
}

function decodeTransaction(b64: string): Transaction | VersionedTransaction {
  const raw = decodeBase64(b64);
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    return Transaction.from(raw);
  }
}

function serializeTransaction(tx: Transaction | VersionedTransaction): Uint8Array {
  if (tx instanceof VersionedTransaction) return tx.serialize();
  return new Uint8Array(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
}

function signSolana(
  kp: Keypair,
  tx: Transaction | VersionedTransaction,
): Transaction | VersionedTransaction {
  if (tx instanceof VersionedTransaction) {
    const copy = VersionedTransaction.deserialize(tx.serialize());
    copy.sign([kp]);
    return copy;
  }
  const copy = Transaction.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
  copy.partialSign(kp);
  return copy;
}

export async function startSignServer(
  config: SignServerConfig,
): Promise<SignServerHandle> {
  if (config.signToken.length < 16) {
    throw new Error("signToken must be ≥16 chars");
  }
  const solanaKp = config.solanaSecretKeyBase58
    ? loadSolanaKeypair(config.solanaSecretKeyBase58)
    : null;
  const evmAccount = config.evmPrivateKey
    ? privateKeyToAccount(config.evmPrivateKey)
    : null;
  const solanaRpc =
    config.solanaRpcUrl ??
    process.env.SOLANA_RPC_URL ??
    "https://api.mainnet-beta.solana.com";
  const solanaConn = new Connection(solanaRpc, "confirmed");

  const server = http.createServer(async (req, res) => {
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // --- public-ish meta endpoints (no signing happens) -------------
      if (req.method === "GET" && pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          solana: solanaKp?.publicKey.toBase58() ?? null,
          evm: evmAccount?.address ?? null,
        });
      }

      // every signing route requires the bearer
      if (!bearerOk(req, config.signToken)) {
        return sendJson(res, 401, { error: "invalid sign token" });
      }

      // --- Solana ---------------------------------------------------
      if (pathname === "/wallet/solana/pubkey") {
        if (!solanaKp) return sendJson(res, 404, { error: "no solana key" });
        return sendJson(res, 200, { publicKey: solanaKp.publicKey.toBase58() });
      }

      if (
        req.method === "POST" &&
        pathname === "/wallet/solana/sign-transaction"
      ) {
        if (!solanaKp) return sendJson(res, 404, { error: "no solana key" });
        const body = await readJson<{ transactionBase64?: string }>(req);
        if (typeof body.transactionBase64 !== "string") {
          return sendJson(res, 400, { error: "transactionBase64 required" });
        }
        const tx = decodeTransaction(body.transactionBase64);
        const signed = signSolana(solanaKp, tx);
        return sendJson(res, 200, {
          signedBase64: encodeBase64(serializeTransaction(signed)),
          publicKey: solanaKp.publicKey.toBase58(),
        });
      }

      if (
        req.method === "POST" &&
        pathname === "/wallet/solana/sign-all-transactions"
      ) {
        if (!solanaKp) return sendJson(res, 404, { error: "no solana key" });
        const body = await readJson<{ transactionsBase64?: string[] }>(req);
        if (
          !Array.isArray(body.transactionsBase64) ||
          !body.transactionsBase64.every((s) => typeof s === "string")
        ) {
          return sendJson(res, 400, {
            error: "transactionsBase64 string[] required",
          });
        }
        const signed = body.transactionsBase64.map((b64) =>
          serializeTransaction(signSolana(solanaKp, decodeTransaction(b64))),
        );
        return sendJson(res, 200, {
          signedBase64s: signed.map(encodeBase64),
          publicKey: solanaKp.publicKey.toBase58(),
        });
      }

      if (req.method === "POST" && pathname === "/wallet/solana/sign-message") {
        if (!solanaKp) return sendJson(res, 404, { error: "no solana key" });
        const body = await readJson<{ messageBase64?: string }>(req);
        if (typeof body.messageBase64 !== "string") {
          return sendJson(res, 400, { error: "messageBase64 required" });
        }
        const sig = nacl.sign.detached(
          decodeBase64(body.messageBase64),
          solanaKp.secretKey,
        );
        return sendJson(res, 200, {
          signatureBase64: encodeBase64(sig),
          signatureBase58: bs58.encode(sig),
          publicKey: solanaKp.publicKey.toBase58(),
        });
      }

      if (
        req.method === "POST" &&
        pathname === "/wallet/solana/sign-and-send-transaction"
      ) {
        if (!solanaKp) return sendJson(res, 404, { error: "no solana key" });
        const body = await readJson<{
          transactionBase64?: string;
          sendOptions?: SendOptions;
        }>(req);
        if (typeof body.transactionBase64 !== "string") {
          return sendJson(res, 400, { error: "transactionBase64 required" });
        }
        const tx = decodeTransaction(body.transactionBase64);
        const signed = signSolana(solanaKp, tx);
        const sig = await solanaConn.sendRawTransaction(
          serializeTransaction(signed),
          body.sendOptions ?? { skipPreflight: false, maxRetries: 3 },
        );
        return sendJson(res, 200, {
          signature: sig,
          publicKey: solanaKp.publicKey.toBase58(),
        });
      }

      // --- EVM ------------------------------------------------------
      if (pathname === "/wallet/evm/address") {
        if (!evmAccount) return sendJson(res, 404, { error: "no evm key" });
        return sendJson(res, 200, { address: evmAccount.address });
      }

      if (req.method === "POST" && pathname === "/wallet/evm/personal-sign") {
        if (!evmAccount) return sendJson(res, 404, { error: "no evm key" });
        const body = await readJson<{ message?: string }>(req);
        if (typeof body.message !== "string") {
          return sendJson(res, 400, { error: "message required" });
        }
        const message: { raw: Hex } | string = body.message.startsWith("0x")
          ? { raw: body.message as Hex }
          : body.message;
        const signature = await evmAccount.signMessage({ message } as never);
        return sendJson(res, 200, {
          signature,
          address: evmAccount.address,
        });
      }

      if (req.method === "POST" && pathname === "/wallet/evm/sign-typed-data") {
        if (!evmAccount) return sendJson(res, 404, { error: "no evm key" });
        const body = await readJson<{ typedData?: unknown }>(req);
        if (!body.typedData || typeof body.typedData !== "object") {
          return sendJson(res, 400, { error: "typedData required" });
        }
        const signature = await evmAccount.signTypedData(
          body.typedData as TypedDataDefinition,
        );
        return sendJson(res, 200, {
          signature,
          address: evmAccount.address,
        });
      }

      if (
        req.method === "POST" &&
        (pathname === "/wallet/evm/send-transaction" ||
          pathname === "/wallet/evm/sign-transaction")
      ) {
        if (!evmAccount) return sendJson(res, 404, { error: "no evm key" });
        const body = await readJson<{
          chainId?: number | string;
          tx?: Record<string, unknown>;
        }>(req);
        const chainId =
          typeof body.chainId === "number"
            ? body.chainId
            : typeof body.chainId === "string"
              ? body.chainId.startsWith("0x")
                ? Number.parseInt(body.chainId.slice(2), 16)
                : Number(body.chainId)
              : Number.NaN;
        if (!Number.isFinite(chainId)) {
          return sendJson(res, 400, { error: "chainId required" });
        }
        const chain = chainFromId(chainId);
        const rpc =
          config.evmRpcByChainId?.[chainId] ??
          process.env[`EVM_RPC_URL_${chainId}`] ??
          chain.rpcUrls?.default?.http?.[0];
        if (!rpc) {
          return sendJson(res, 400, {
            error: `no RPC for chain ${chainId}`,
          });
        }
        const wallet = createWalletClient({
          account: evmAccount,
          chain,
          transport: viemHttp(rpc),
        }).extend(publicActions);
        const tx = (body.tx ?? {}) as Record<string, unknown>;
        const toBig = (v: unknown): bigint | undefined => {
          if (v === undefined || v === null) return undefined;
          if (typeof v === "bigint") return v;
          if (typeof v === "number") return BigInt(v);
          if (typeof v === "string" && v.length > 0) return BigInt(v);
          return undefined;
        };

        if (pathname === "/wallet/evm/send-transaction") {
          const hash = await wallet.sendTransaction({
            account: evmAccount,
            chain,
            to: tx.to as Address | undefined,
            value: toBig(tx.value),
            data: tx.data as Hex | undefined,
            gas: toBig(tx.gas),
            maxFeePerGas: toBig(tx.maxFeePerGas),
            maxPriorityFeePerGas: toBig(tx.maxPriorityFeePerGas),
          });
          return sendJson(res, 200, {
            hash,
            address: evmAccount.address,
            chainId,
          });
        }

        const request = await wallet.prepareTransactionRequest({
          account: evmAccount,
          chain,
          to: tx.to as Address | undefined,
          value: toBig(tx.value),
          data: tx.data as Hex | undefined,
          gas: toBig(tx.gas),
          maxFeePerGas: toBig(tx.maxFeePerGas),
          maxPriorityFeePerGas: toBig(tx.maxPriorityFeePerGas),
        });
        const signed = await wallet.signTransaction(request);
        return sendJson(res, 200, {
          signedTransaction: signed,
          address: evmAccount.address,
          chainId,
        });
      }

      sendJson(res, 404, { error: `no route: ${req.method} ${pathname}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(config.port, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  const port =
    typeof addr === "object" && addr !== null
      ? addr.port
      : typeof addr === "string"
        ? Number.parseInt(addr, 10)
        : config.port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    solanaPublicKey: solanaKp?.publicKey.toBase58() ?? null,
    evmAddress: evmAccount?.address ?? null,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
