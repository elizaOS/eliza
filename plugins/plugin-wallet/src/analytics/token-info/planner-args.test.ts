/**
 * WALLET `action=token_info` driven with the arguments the planner can
 * actually send (validated against the declared WALLET schema). The WALLET
 * handler, `TokenInfoService`, the DexScreener provider and
 * `DexScreenerService` are the real ones; only the DexScreener HTTP boundary
 * is intercepted.
 */
import {
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  promoteSubactionsToActions,
  validateToolArgs,
} from "@elizaos/core";
import { afterEach, expect, it } from "vitest";
import { walletRouterAction } from "../../chains/wallet-action";
import { DexScreenerService } from "../dexscreener/service";
import { TOKEN_INFO_SERVICE_TYPE, TokenInfoService } from "./service";

const PEPE_CONTRACT = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";

const PAIR = {
  chainId: "ethereum",
  dexId: "uniswap",
  url: "https://dexscreener.com/ethereum/0xpair",
  pairAddress: "0xpair",
  baseToken: { address: PEPE_CONTRACT, name: "Pepe", symbol: "PEPE" },
  quoteToken: { address: "0xweth", name: "Wrapped Ether", symbol: "WETH" },
  priceNative: "0.000000003",
  priceUsd: "0.00001",
  volume: { h24: 1500000, h6: 400000, h1: 80000, m5: 5000 },
  priceChange: { m5: 0.01, h1: 0.02, h6: -0.05, h24: 0.12 },
  liquidity: { usd: 25000000, base: 1, quote: 1 },
};

const calls: string[] = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

async function createRuntime(): Promise<IAgentRuntime> {
  const services = new Map<string, unknown>();
  const runtime = {
    getSetting(key: string) {
      if (key === "DEXSCREENER_API_URL") return "https://dex.example.test";
      if (key === "DEXSCREENER_RATE_LIMIT_DELAY") return 0;
      return undefined;
    },
    getService(type: string) {
      return services.get(type) ?? null;
    },
  } as unknown as IAgentRuntime;
  services.set("dexscreener", await DexScreenerService.start(runtime));
  services.set(TOKEN_INFO_SERVICE_TYPE, await TokenInfoService.start(runtime));
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

async function run(
  text: string,
  args: Record<string, unknown>,
  actionName = "WALLET",
) {
  const action = promoteSubactionsToActions(walletRouterAction).find(
    (candidate) => candidate.name === actionName,
  );
  if (!action) throw new Error(`${actionName} is not registered`);
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("/token-boosts/")
      ? []
      : url.includes("/tokens/v1/")
        ? [PAIR]
        : { pairs: [PAIR] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const validation = validateToolArgs(action, args);
  expect(validation.errors).toEqual([]);
  return action.handler(await createRuntime(), message(text), undefined, {
    parameters: validation.args,
  } as HandlerOptions);
}

it("searches DexScreener for a token named only by symbol", async () => {
  const result = await run("what's the price of PEPE?", {
    action: "token_info",
    query: "PEPE",
  });

  expect(result?.success).toBe(true);
  expect(result?.data?.subaction).toBe("token_info");
  expect(result?.text).toContain('Token search results for "PEPE"');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("/latest/dex/search");
  expect(calls[0]).toContain("q=PEPE");
});

it("looks a token up by contract address even when the message mentions a wallet", async () => {
  const result = await run(`check ${PEPE_CONTRACT} before I fund my wallet`, {
    action: "token_info",
    address: PEPE_CONTRACT,
  });

  expect(result?.success).toBe(true);
  expect(result?.data?.target).toBe("dexscreener");
  expect(result?.text).toContain("Pepe (PEPE)");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain(PEPE_CONTRACT);
  expect(calls[0]).not.toContain("/latest/dex/search");
});

it("classifies a request with no token from the message text", async () => {
  const result = await run("what's trending on dexscreener?", {
    action: "token_info",
  });

  expect(result?.success).toBe(true);
  expect(result?.text).toContain("Trending tokens (24h)");
});

it("runs the lookup named by the declared operation argument", async () => {
  // The message text alone classifies as a token lookup and fails with no
  // address.
  const args = { action: "token_info", operation: "trending", limit: 5 };
  const result = await run("top tokens on base", args);

  expect(result?.success).toBe(true);
  expect(result?.text).toContain("Trending tokens (24h)");

  // The promoted virtual adds subaction=token_info to the arguments.
  const promoted = await run("top tokens on base", args, "WALLET_TOKEN_INFO");
  expect(promoted?.success).toBe(true);
  expect(promoted?.text).toContain("Trending tokens (24h)");
});

it("still reports a missing token when nothing names one", async () => {
  const result = await run("token info please", { action: "token_info" });

  expect(result?.success).toBe(false);
  expect(result?.error).toBe("MISSING_TOKEN_ADDRESS");
  expect(calls).toEqual([]);
});

it("lists the top pairs on the chain named by the declared chain argument", async () => {
  const result = await run("show me the top pairs on ethereum", {
    action: "token_info",
    chain: "ethereum",
  });

  expect(result?.success).toBe(true);
  expect(result?.text).toContain("Top ethereum pairs by volume");
  expect(result?.text).toContain("PEPE");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("q=ethereum");
});
