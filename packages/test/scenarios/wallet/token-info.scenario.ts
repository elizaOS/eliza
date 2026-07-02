/**
 * Keyless per-plugin e2e for `@elizaos/plugin-wallet` (issue #8801).
 *
 * Exercises the WALLET umbrella action's analytics path end-to-end against a
 * scoped mock of the public DexScreener API (api.dexscreener.com), installed
 * via a fetch interceptor in the seed. A "look up token info" request routes
 * through WALLET with `action=token_info`, which dispatches to the token-info
 * service's DexScreener provider, fetches the token's pairs from the mock, and
 * reports the token's price/volume — no live network, no API keys, no signer.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";

const WALLET = "WALLET";
// USDC mainnet contract — used only as a deterministic lookup key for the mock.
const TOKEN_ADDRESS = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

type R = AgentRuntime & {
  setSetting?: (k: string, v: string) => void;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let restoreFetch: (() => void) | undefined;
/** URLs of DexScreener token-pair lookups the mock actually served. */
let dexMockHits: string[] = [];

const MOCK_PAIR = {
  chainId: "ethereum",
  dexId: "uniswap",
  url: "https://dexscreener.com/ethereum/0xpair",
  pairAddress: "0xpair0000000000000000000000000000000000",
  baseToken: {
    address: TOKEN_ADDRESS,
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
  },
  quoteToken: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    name: "Wrapped Ether",
    symbol: "WETH",
    decimals: 18,
  },
  priceNative: "0.00033",
  priceUsd: "1.00",
  txns: {
    m5: { buys: 1, sells: 1 },
    h1: { buys: 10, sells: 8 },
    h6: { buys: 60, sells: 55 },
    h24: { buys: 240, sells: 230 },
  },
  volume: { h24: 1500000, h6: 400000, h1: 80000, m5: 5000 },
  priceChange: { m5: 0.01, h1: 0.02, h6: -0.05, h24: 0.12 },
  liquidity: { usd: 25000000, base: 25000000, quote: 8000 },
  fdv: 32000000000,
  marketCap: 32000000000,
  pairCreatedAt: 1600000000000,
};

export default scenario({
  lane: "pr-deterministic",
  id: "wallet.token-info",
  title:
    "Wallet: token info via WALLET action against a mocked DexScreener API",
  domain: "wallet",
  tags: ["smoke", "wallet", "analytics"],
  description:
    "Looks up token information through the WALLET action (action=token_info) against a scoped mock of the DexScreener API — keyless, no signer, no live network.",

  requires: { plugins: ["@elizaos/plugin-wallet"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "wallet-mock-and-config",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        dexMockHits = [];

        // Pin the DexScreener base URL so the interceptor target is stable,
        // regardless of any Eliza Cloud routing defaults.
        process.env.DEXSCREENER_API_URL = "https://api.dexscreener.com";
        runtime.setSetting?.(
          "DEXSCREENER_API_URL",
          "https://api.dexscreener.com",
        );

        // Scoped fetch interceptor: redirect DexScreener token-pair lookups to
        // a deterministic mock; everything else hits the real fetch.
        const realFetch = globalThis.fetch;
        restoreFetch = () => {
          if (globalThis.fetch === dexMockFetch) {
            globalThis.fetch = realFetch;
          }
          restoreFetch = undefined;
        };
        const dexMockFetch = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : input.toString();
          if (
            url.includes("api.dexscreener.com") &&
            url.includes("/latest/dex/tokens/")
          ) {
            dexMockHits.push(url);
            return new Response(JSON.stringify({ pairs: [MOCK_PAIR] }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return realFetch(input, init);
        }) as typeof fetch;
        globalThis.fetch = dexMockFetch;

        runtime.scenarioLlmFixtures?.register(
          {
            name: "wallet-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("USDC"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["wallet"],
              intents: ["wallet"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [WALLET],
            },
            times: 1,
          },
          {
            name: "wallet-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("USDC"),
              toolName: WALLET,
            },
            response: {
              text: "",
              thought: "Look up token info for USDC via DexScreener.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-wallet",
                  name: WALLET,
                  type: "function",
                  arguments: {
                    action: "token_info",
                    address: TOKEN_ADDRESS,
                  },
                },
              ],
            },
            times: 1,
          },
          {
            // After WALLET returns the token info, the runtime makes a final
            // RESPONSE_HANDLER (no HANDLE_RESPONSE tool) to decide whether to
            // continue; the token lookup is terminal, so FINISH.
            name: "wallet-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Token info returned; nothing more to do.",
              messageToUser: "USDC is trading at $1.00.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore-wallet-fetch",
      apply: () => {
        restoreFetch?.();
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Wallet" },
  ],

  turns: [
    {
      kind: "message",
      name: "lookup",
      text: `Look up DexScreener market data for USDC at ${TOKEN_ADDRESS}.`,
      // Carry the wallet discriminator on the inbound message so the WALLET
      // action's structural validate() (which has no live LLM at gate time)
      // recognizes the analytics subaction and exposes the tool to the planner.
      content: { action: "token_info", address: TOKEN_ADDRESS },
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === WALLET);
        if (!call) {
          return `Expected ${WALLET} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${WALLET} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: WALLET,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the token-info pipeline really fetched the
      // DexScreener pairs for the requested address and surfaced the mock's
      // market data in the action result — not just "the handler returned
      // success".
      type: "custom",
      name: "dexscreener-token-info-effect",
      predicate: (ctx) => {
        const hit = dexMockHits.find((url) =>
          url.toLowerCase().includes(TOKEN_ADDRESS.toLowerCase()),
        );
        if (!hit) {
          return `DexScreener mock never served a token-pair lookup for ${TOKEN_ADDRESS}; served: ${
            dexMockHits.join(", ") || "(none)"
          }`;
        }
        const call = ctx.actionsCalled.find(
          (a) => a.actionName === WALLET && a.result?.success === true,
        );
        const data =
          call?.result?.data && typeof call.result.data === "object"
            ? (call.result.data as Record<string, unknown>)
            : null;
        if (!data) {
          return "successful WALLET call carried no result.data";
        }
        if (data.subaction !== "token_info") {
          return `expected result.data.subaction "token_info", saw ${String(data.subaction ?? "(missing)")}`;
        }
        const pairs = Array.isArray(data.pairs) ? data.pairs : [];
        const pair =
          pairs[0] && typeof pairs[0] === "object"
            ? (pairs[0] as Record<string, unknown>)
            : null;
        const baseToken =
          pair?.baseToken && typeof pair.baseToken === "object"
            ? (pair.baseToken as Record<string, unknown>)
            : null;
        if (baseToken?.symbol !== "USDC" || pair?.priceUsd !== "1.00") {
          return `expected result.data.pairs[0] to carry the mock's USDC pair (symbol USDC, priceUsd 1.00); saw ${JSON.stringify(
            pair ?? "(no pairs)",
          ).slice(0, 300)}`;
        }
      },
    },
  ],
});
