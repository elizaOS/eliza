/**
 * WALLET action=search_address looks a wallet up on the chain its address
 * belongs to. BirdeyeProvider reads the chain from the `x-chain` header, so the
 * Birdeye token-info provider must send the resolved chain under that name.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  promoteSubactionsToActions,
  validateToolArgs,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { walletRouterAction } from "../../chains/wallet-action";
import { TOKEN_INFO_SERVICE_TYPE, TokenInfoService } from "./service";

const BIRDEYE_API = "https://public-api.birdeye.so";
const EVM_WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const requests: Array<{ path: string; chain: string | undefined }> = [];
const realFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void>> = [];
let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  // Holdings are per chain, as in Birdeye: this wallet only holds USDC on
  // Ethereum.
  server = http.createServer((req, res) => {
    const chain = req.headers["x-chain"];
    requests.push({
      path: req.url ?? "",
      chain: typeof chain === "string" ? chain : undefined,
    });
    const items =
      chain === "ethereum"
        ? [{ address: USDC, symbol: "usdc", uiAmount: 2500, valueUsd: 2500 }]
        : [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        data: {
          wallet: EVM_WALLET,
          totalUsd: items.length > 0 ? 2500 : 0,
          items,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  vi.restoreAllMocks();
  requests.length = 0;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createRuntime(): Promise<IAgentRuntime> {
  const runtime = createSQLiteTestRuntime({
    logLevel: "fatal",
    character: { name: "Agent", bio: ["test"] },
  });
  cleanups.push(async () => {
    await runtime.stop();
    await runtime.close();
  });
  await runtime.initialize({ skipMigrations: true });
  await runtime.registerService(TokenInfoService);
  await runtime.getServiceLoadPromise(TOKEN_INFO_SERVICE_TYPE);
  return runtime;
}

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

it("looks an EVM wallet up on Ethereum, not on Solana", async () => {
  const runtime = await createRuntime();
  // BirdeyeProvider calls the public Birdeye host; send those calls to the
  // local server.
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    return realFetch(
      url.startsWith(BIRDEYE_API)
        ? baseUrl + url.slice(BIRDEYE_API.length)
        : input,
      init,
    );
  });
  const action = promoteSubactionsToActions(walletRouterAction).find(
    (candidate) => candidate.name === "WALLET",
  );
  if (!action) throw new Error("WALLET is not registered");
  const validation = validateToolArgs(action, {
    action: "search_address",
    address: EVM_WALLET,
  });
  expect(validation.errors).toEqual([]);

  const result = await action.handler(
    runtime,
    message(`what does ${EVM_WALLET} hold?`),
    undefined,
    { parameters: validation.args } as HandlerOptions,
  );

  expect(requests).toEqual([
    {
      path: `/v1/wallet/token_list?wallet=${EVM_WALLET}`,
      chain: "ethereum",
    },
  ]);
  expect(result?.success).toBe(true);
  expect(result?.text).toContain("Total value: $2,500");
  expect(result?.text).toContain("- USDC: $2,500 (2500)");
});
