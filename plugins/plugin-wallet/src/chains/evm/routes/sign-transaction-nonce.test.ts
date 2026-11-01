/**
 * The browser shim forwards eth_signTransaction and eth_sendTransaction with
 * the dApp's transaction object, nonce included. Both routes must use that
 * nonce. A dApp that signs a replacement or a queued transaction asks for a
 * nonce other than the account's pending one.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { type Hex, parseTransaction } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { evmSignRoutes } from "./sign";

const SIGN_TOKEN = randomUUID();
const PRIVATE_KEY = generatePrivateKey();
const PENDING_NONCE = 9;

const rawSent: Hex[] = [];
const cleanups: Array<() => Promise<void>> = [];
let server: http.Server;
let rpcUrl = "";

beforeAll(async () => {
  // A JSON-RPC node whose pending nonce for the account is 9.
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const answer = (call: {
        id: number;
        method: string;
        params?: unknown[];
      }) => {
        if (call.method === "eth_sendRawTransaction") {
          rawSent.push(call.params?.[0] as Hex);
          return {
            jsonrpc: "2.0",
            id: call.id,
            result: `0x${"ab".repeat(32)}`,
          };
        }
        const results: Record<string, unknown> = {
          eth_chainId: "0x1",
          eth_getTransactionCount: `0x${PENDING_NONCE.toString(16)}`,
          eth_estimateGas: "0x5208",
          eth_maxPriorityFeePerGas: "0x1",
          eth_gasPrice: "0x2",
          eth_getBlockByNumber: {
            number: "0x1",
            hash: `0x${"11".repeat(32)}`,
            baseFeePerGas: "0x1",
            timestamp: "0x1",
            transactions: [],
          },
        };
        return { jsonrpc: "2.0", id: call.id, result: results[call.method] };
      };
      const out = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  rawSent.length = 0;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createRuntime(): Promise<IAgentRuntime> {
  const runtime = createSQLiteTestRuntime({
    logLevel: "fatal",
    character: {
      name: "Agent",
      bio: ["test"],
      secrets: {
        EVM_PRIVATE_KEY: PRIVATE_KEY,
        WALLET_BROWSER_SIGN_TOKEN: SIGN_TOKEN,
        ELIZA_WALLET_BACKEND: "local",
        EVM_RPC_URL_1: rpcUrl,
      },
    },
  });
  cleanups.push(async () => {
    await runtime.stop();
    await runtime.close();
  });
  await runtime.initialize({ skipMigrations: true });
  return runtime;
}

async function post(path: string, tx: Record<string, unknown>) {
  const route = evmSignRoutes.find((r) => r.type === "POST" && r.path === path);
  if (!route?.handler) throw new Error(`no POST route ${path}`);
  const runtime = await createRuntime();
  let status = 0;
  let payload: Record<string, unknown> = {};
  const res = {
    setHeader: () => {},
    status(code: number) {
      status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      payload = value;
      return res;
    },
  };
  await route.handler(
    {
      method: "POST",
      headers: { authorization: `Bearer ${SIGN_TOKEN}` },
      body: { chainId: 1, tx },
    } as never,
    res as never,
    runtime,
  );
  return { status, payload };
}

const transfer = {
  to: "0x000000000000000000000000000000000000dEaD",
  value: "0x1",
  gas: "0x5208",
  maxFeePerGas: "0x3b9aca00",
  maxPriorityFeePerGas: "0x1",
};

describe("browser EVM transaction nonce", () => {
  it("signs eth_signTransaction at the nonce the dApp asked for", async () => {
    const { status, payload } = await post("/wallet/evm/sign-transaction", {
      ...transfer,
      nonce: "0x5",
    });

    expect(status).toBe(200);
    const signed = parseTransaction(payload.signedTransaction as Hex);
    expect(signed.nonce).toBe(5);
  });

  it("signs at the pending nonce when the dApp leaves it out", async () => {
    const { status, payload } = await post(
      "/wallet/evm/sign-transaction",
      transfer,
    );

    expect(status).toBe(200);
    const signed = parseTransaction(payload.signedTransaction as Hex);
    expect(signed.nonce).toBe(PENDING_NONCE);
  });

  it("sends eth_sendTransaction at the nonce the dApp asked for", async () => {
    const { status } = await post("/wallet/evm/send-transaction", {
      ...transfer,
      nonce: "0x5",
    });

    expect(status).toBe(200);
    expect(rawSent).toHaveLength(1);
    expect(parseTransaction(rawSent[0]).nonce).toBe(5);
  });
});
