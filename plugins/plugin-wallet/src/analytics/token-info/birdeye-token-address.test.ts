/**
 * WALLET action=token_info with target birdeye looks a token up by its
 * contract address. A Solana mint is an address too, so the lookup must read
 * Birdeye's token overview for it instead of searching it as a symbol.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ActionResult,
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
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const requests: Array<{ path: string; chain: string | undefined }> = [];
const realFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void>> = [];
let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  // Birdeye knows USDC on Solana by its mint. Keyword search matches token
  // names and symbols, so the uppercased mint finds nothing.
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://birdeye.local");
    const chain = req.headers["x-chain"];
    requests.push({
      path: url.pathname,
      chain: typeof chain === "string" ? chain : undefined,
    });
    const known =
      url.searchParams.get("address") === USDC_MINT && chain === "solana";
    const usdc = {
      address: USDC_MINT,
      name: "USD Coin",
      symbol: "USDC",
      network: "solana",
      price: 1,
    };
    const data =
      url.pathname === "/defi/v3/search"
        ? {
            items:
              url.searchParams.get("keyword") === "USDC"
                ? [{ type: "token", result: [usdc] }]
                : [],
          }
        : url.pathname === "/defi/token_overview" && known
          ? {
              address: USDC_MINT,
              name: "USD Coin",
              symbol: "USDC",
              decimals: 6,
              price: 1,
            }
          : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data }));
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

async function runTokenInfo(
  args: Record<string, unknown>,
  text: string,
): Promise<ActionResult | undefined> {
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
    action: "token_info",
    target: "birdeye",
    ...args,
  });
  expect(validation.errors).toEqual([]);

  const result = await action.handler(runtime, message(text), undefined, {
    parameters: validation.args,
  } as HandlerOptions);
  return result ?? undefined;
}

it("looks a Solana mint up as a token address, not as a symbol", async () => {
  const result = await runTokenInfo(
    { address: USDC_MINT },
    `what is ${USDC_MINT}?`,
  );

  expect(requests.map(({ path }) => path).sort()).toEqual([
    "/defi/token_overview",
    "/defi/token_security",
    "/defi/v3/token/market-data",
    "/defi/v3/token/trade-data/single",
  ]);
  expect(new Set(requests.map(({ chain }) => chain))).toEqual(
    new Set(["solana"]),
  );
  expect(result?.success).toBe(true);
  expect(result?.text).toContain("mode: address");
  expect(result?.text).toContain("resultCount: 1");
  expect(result?.text).toContain("USD Coin");
});

it("still searches a symbol by keyword", async () => {
  const result = await runTokenInfo({ query: "usdc" }, "what is usdc?");

  expect(requests).toEqual([{ path: "/defi/v3/search", chain: "solana" }]);
  expect(result?.success).toBe(true);
  expect(result?.text).toContain("mode: symbol");
  expect(result?.text).toContain(USDC_MINT);
});
