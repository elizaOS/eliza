/**
 * "ETH" names the native coin only on chains whose native currency is ETH. On
 * BNB Smart Chain a transfer of "ETH" must not broadcast a native BNB send.
 * Real default chain handlers against a local JSON-RPC stub.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseTransaction } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerDefaultWalletChainHandlers } from "./registry";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const raws: string[] = [];
let server: http.Server;
let url = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      const out = calls.map(
        (c: { id: number; method: string; params: unknown[] }) => {
          const r = (result: unknown) => ({ jsonrpc: "2.0", id: c.id, result });
          switch (c.method) {
            case "eth_chainId":
              return r("0x38");
            case "eth_getTransactionCount":
              return r("0x0");
            case "eth_estimateGas":
              return r("0x5208");
            case "eth_gasPrice":
              return r("0x3b9aca00");
            case "eth_maxPriorityFeePerGas":
              return r("0x3b9aca00");
            case "eth_getBlockByNumber":
              return r({
                baseFeePerGas: "0x0",
                number: "0x1",
                hash: `0x${"1".repeat(64)}`,
                timestamp: "0x1",
                transactions: [],
              });
            case "eth_sendRawTransaction":
              raws.push(c.params[0] as string);
              return r(`0x${"ab".repeat(32)}`);
            default:
              return r(null);
          }
        },
      );
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function bscRuntime() {
  const settings: Record<string, string> = {
    EVM_PRIVATE_KEY: PK,
    ETHEREUM_PROVIDER_BSC: url,
  };
  return {
    agentId: "agent",
    character: { settings: { chains: { evm: ["bsc"] } } },
    getSetting: (key: string) => settings[key] ?? null,
    setSetting: () => {},
    getService: () => null,
  } as never;
}

async function transferOnBsc(fromToken: string) {
  const runtime = bscRuntime();
  const handlers: Array<{
    chain: string;
    execute: (params: unknown, context: unknown) => Promise<unknown>;
  }> = [];
  registerDefaultWalletChainHandlers(
    {
      registerChainHandler: (handler: never) => handlers.push(handler),
    } as never,
    runtime,
  );
  const bsc = handlers.find((handler) => handler.chain === "bsc");
  if (!bsc) throw new Error("bsc handler not registered");
  raws.length = 0;
  try {
    await bsc.execute(
      {
        subaction: "transfer",
        mode: "execute",
        chain: "bsc",
        fromToken,
        amount: "1",
        recipient: RECIPIENT,
      },
      {
        runtime,
        walletBackend: null,
        walletServices: [],
        tokenDataService: null,
      },
    );
  } catch {}
  return raws.map((raw) => parseTransaction(raw as `0x${string}`));
}

describe("WALLET native-coin resolution on BNB Smart Chain", () => {
  it("does not send native BNB when the user asked for ETH", async () => {
    expect(await transferOnBsc("ETH")).toEqual([]);
  });

  it("still sends native BNB for the chain's own symbol", async () => {
    const sent = await transferOnBsc("BNB");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.value).toBe(1_000_000_000_000_000_000n);
  });
});
