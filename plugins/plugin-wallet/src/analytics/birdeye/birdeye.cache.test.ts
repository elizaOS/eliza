/**
 * BirdeyeProvider caches its GET answers in the runtime cache. A token price
 * read through WALLET action=token_info (target birdeye) must come from
 * Birdeye again once the cached answer is old, not from the first lookup
 * forever.
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
import {
  TOKEN_INFO_SERVICE_TYPE,
  TokenInfoService,
} from "../token-info/service";

const BIRDEYE_API = "https://public-api.birdeye.so";
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";

const requests: string[] = [];
const realFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void>> = [];
let server: http.Server;
let baseUrl = "";
let price = 1.25;

beforeAll(async () => {
  // Birdeye answers with the token's current price.
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://birdeye.local");
    requests.push(url.pathname);
    const data =
      url.pathname === "/defi/token_overview" ||
      url.pathname === "/defi/v3/token/market-data"
        ? { address: PEPE, name: "Pepe", symbol: "PEPE", decimals: 18, price }
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
  vi.useRealTimers();
  requests.length = 0;
  price = 1.25;
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

async function lookUpPepe(
  runtime: IAgentRuntime,
): Promise<ActionResult | undefined> {
  const action = promoteSubactionsToActions(walletRouterAction).find(
    (candidate) => candidate.name === "WALLET",
  );
  if (!action) throw new Error("WALLET is not registered");
  const validation = validateToolArgs(action, {
    action: "token_info",
    target: "birdeye",
    address: PEPE,
  });
  expect(validation.errors).toEqual([]);

  const result = await action.handler(
    runtime,
    message(`what is ${PEPE} trading at?`),
    undefined,
    { parameters: validation.args } as HandlerOptions,
  );
  return result ?? undefined;
}

function overviewRequests(): number {
  return requests.filter((path) => path === "/defi/token_overview").length;
}

it("reads the price from Birdeye again once the cached answer is old", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T00:00:00Z"));
  const runtime = await createRuntime();

  const first = await lookUpPepe(runtime);
  expect(first?.success).toBe(true);
  expect(first?.text).toContain("1.25");

  vi.setSystemTime(new Date("2026-10-31T00:00:00Z"));
  price = 1.5;
  const later = await lookUpPepe(runtime);

  expect(overviewRequests()).toBe(2);
  expect(later?.success).toBe(true);
  expect(later?.text).toContain("1.50");
  expect(later?.text).not.toContain("1.25");
});

it("answers a repeat lookup within seconds from the cache", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T00:00:00Z"));
  const runtime = await createRuntime();

  await lookUpPepe(runtime);
  vi.setSystemTime(new Date("2026-10-30T00:00:05Z"));
  price = 1.5;
  const repeat = await lookUpPepe(runtime);

  expect(overviewRequests()).toBe(1);
  expect(repeat?.text).toContain("1.25");
});
