import { AgentRuntime, type Character } from "@elizaos/core";
import { initWalletProvider } from "@elizaos/plugin-evm";
import {
  type MarketsResponse,
  type OrderBook,
  getWalletAddress,
  initializeClobClient,
  initializeClobClientWithCreds,
} from "@elizaos/plugin-polymarket";
import sqlPlugin from "@elizaos/plugin-sql";
import { Side } from "@polymarket/clob-client";

import { loadEnvConfig, type CliOptions, type EnvConfig } from "./lib";

export type MarketPick = {
  readonly tokenId: string;
  readonly marketLabel: string;
  readonly tickSize: number;
};

export function bestPrice(orderBook: Pick<OrderBook, "bids" | "asks">): {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
} {
  const bestBidRaw = orderBook.bids[0]?.price;
  const bestAskRaw = orderBook.asks[0]?.price;
  const bestBid = typeof bestBidRaw === "string" ? Number(bestBidRaw) : NaN;
  const bestAsk = typeof bestAskRaw === "string" ? Number(bestAskRaw) : NaN;
  return {
    bestBid: Number.isFinite(bestBid) ? bestBid : null,
    bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
  };
}

export async function createRuntime(options: CliOptions, config: EnvConfig): Promise<AgentRuntime> {
  const character: Character = {
    name: "PolymarketDemoAgent",
    bio: "Autonomous Polymarket demo agent (CLI).",
    settings: {
      chains: {
        evm: [options.chain],
      },
      secrets: {
        EVM_PRIVATE_KEY: config.privateKey,
        POLYMARKET_PRIVATE_KEY: config.privateKey,
        CLOB_API_URL: config.clobApiUrl,
        ...(options.rpcUrl
          ? {
              [`ETHEREUM_PROVIDER_${options.chain.toUpperCase()}`]: options.rpcUrl,
              [`EVM_PROVIDER_${options.chain.toUpperCase()}`]: options.rpcUrl,
            }
          : {}),
      },
    },
  };

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin],
    logLevel: "info",
  });
  await runtime.initialize();
  return runtime;
}

export async function assertWalletParity(runtime: AgentRuntime): Promise<string> {
  const walletFromPolymarket = getWalletAddress(runtime);
  const evmWallet = await initWalletProvider(runtime);
  const walletFromEvm = evmWallet.getAddress();

  if (walletFromPolymarket.toLowerCase() !== walletFromEvm.toLowerCase()) {
    throw new Error(`Wallet mismatch: plugin-polymarket=${walletFromPolymarket} plugin-evm=${walletFromEvm}`);
  }
  return walletFromEvm;
}

export async function pickFirstActiveMarket(
  client: { getMarkets: (cursor?: string) => Promise<MarketsResponse> },
  maxPages: number
): Promise<MarketPick> {
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const resp = await client.getMarkets(cursor);
    for (const m of resp.data) {
      if (!m.active || m.closed) continue;
      const tok = m.tokens[0];
      if (!tok?.token_id) continue;
      const label = m.question && m.question.trim().length > 0 ? m.question : m.condition_id;
      const tick = m.minimum_tick_size ? Number(m.minimum_tick_size) : NaN;
      const tickSize = Number.isFinite(tick) && tick > 0 ? tick : 0.001;
      return { tokenId: tok.token_id, marketLabel: label, tickSize };
    }
    cursor = resp.next_cursor && resp.next_cursor.length > 0 ? resp.next_cursor : undefined;
  }
  throw new Error("No active market found (try increasing --max-pages or check API).");
}

export async function verify(options: CliOptions): Promise<void> {
  const config = loadEnvConfig(options);
  const runtime = await createRuntime(options, config);
  try {
    const address = await assertWalletParity(runtime);
    console.log("✅ wallet address:", address);
    console.log("✅ clob api url:", config.clobApiUrl);
    console.log("✅ execute enabled:", String(options.execute));
    console.log("✅ creds present:", String(config.creds !== null));

    if (options.network) {
      const client = await initializeClobClient(runtime);
      const marketsResp = await client.getMarkets(undefined);
      console.log("🌐 network ok: fetched markets =", String(marketsResp.data.length));
    }
  } finally {
    await runtime.stop();
  }
}

export async function once(options: CliOptions): Promise<void> {
  if (!options.network) {
    throw new Error("The 'once' command requires --network (it fetches markets + order book).");
  }

  const config = loadEnvConfig(options);
  const runtime = await createRuntime(options, config);

  try {
    await assertWalletParity(runtime);

    const publicClient = await initializeClobClient(runtime);
    const { tokenId, marketLabel, tickSize } = await pickFirstActiveMarket(publicClient, options.maxPages);
    const orderBook = await publicClient.getOrderBook(tokenId);

    const { bestBid, bestAsk } = bestPrice(orderBook);
    if (bestBid === null || bestAsk === null) {
      console.log("No usable bid/ask; skipping:", tokenId);
      return;
    }

    const spread = bestAsk - bestBid;
    const midpoint = (bestAsk + bestBid) / 2;
    const price = Math.max(0.01, Math.min(0.99, midpoint - tickSize));

    console.log("🎯 market:", marketLabel);
    console.log("🔑 token:", tokenId);
    console.log("📈 bestBid:", bestBid.toFixed(4), "bestAsk:", bestAsk.toFixed(4));
    console.log("📏 spread:", spread.toFixed(4), "midpoint:", midpoint.toFixed(4));
    console.log("🧪 decision: BUY", String(options.orderSize), "at", price.toFixed(4));

    if (!options.execute) {
      console.log("🧊 dry-run: not placing order (pass --execute to place)");
      return;
    }

    if (config.creds === null) {
      throw new Error("Internal error: execute=true but creds missing");
    }

    const authed = await initializeClobClientWithCreds(runtime);
    const res = await authed.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        side: Side.BUY,
        size: options.orderSize,
        feeRateBps: 0,
      },
      undefined,
      "GTC"
    );

    console.log("✅ order response:", JSON.stringify(res));
  } finally {
    await runtime.stop();
  }
}

export async function run(options: CliOptions): Promise<void> {
  if (!options.network) {
    throw new Error("The 'run' command requires --network (it fetches markets + order book).");
  }
  for (let i = 0; i < options.iterations; i += 1) {
    await once(options);
    if (i + 1 < options.iterations) {
      await new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs));
    }
  }
}

