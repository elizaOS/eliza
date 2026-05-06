import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
} from "@elizaos/core";

const EVENTTRADER_API = "https://cymetica.com";
const ACTION_TIMEOUT_MS = 15_000;

interface EventTraderMarket {
  id: string;
  title: string;
  description: string;
  outcomes: { name: string; odds: number }[];
  status: string;
  volume: number;
  created_at: string;
}

interface LeaderboardEntry {
  rank: number;
  agent_name: string;
  strategy: string;
  pnl: number;
  win_rate: number;
  trades: number;
}

async function fetchEventTrader<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${EVENTTRADER_API}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options?.headers || {}),
    },
    signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`EventTrader API error: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const getMarkets: Action = {
  name: "GET_EVENTTRADER_MARKETS",
  description: "Get list of active prediction markets from EventTrader",
  similes: [
    "list prediction markets",
    "show markets",
    "what markets are available",
    "eventtrader markets",
    "prediction market odds",
  ],
  examples: [
    [
      { user: "user", content: { text: "What prediction markets are available on EventTrader?" } },
      { user: "assistant", content: { text: "Let me fetch the current prediction markets from EventTrader." } },
    ],
  ],
  handler: async (
    _runtime,
    _message,
    _state,
    options: HandlerOptions | Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const markets = await fetchEventTrader<{ markets: EventTraderMarket[] }>(
        "/api/v1/wta/markets"
      );
      const summary = markets.markets
        .slice(0, 10)
        .map((m) => `- **${m.title}** (Volume: $${m.volume?.toFixed(2) || "0"})`)
        .join("
");
      if (callback) {
        await callback({
          text: `Here are the active EventTrader prediction markets:

${summary}`,
          action: "GET_EVENTTRADER_MARKETS",
        });
      }
      return { success: true, data: markets };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      if (callback) {
        await callback({ text: `Failed to fetch EventTrader markets: ${msg}`, action: "GET_EVENTTRADER_MARKETS" });
      }
      return { success: false, error: msg };
    }
  },
  validate: async () => true,
};

export const getMarketDetail: Action = {
  name: "GET_EVENTTRADER_MARKET_DETAIL",
  description: "Get detailed information about a specific EventTrader prediction market including odds",
  similes: [
    "market details",
    "market odds",
    "show market",
    "prediction market info",
  ],
  examples: [
    [
      { user: "user", content: { text: "Show me the odds for market 5 on EventTrader" } },
      { user: "assistant", content: { text: "Let me get the details for that market." } },
    ],
  ],
  handler: async (
    _runtime,
    _message,
    _state,
    options: HandlerOptions | Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const params = options as { parameters?: Record<string, unknown> } | undefined;
      const marketId = params?.parameters?.market_id || params?.parameters?.id;
      if (!marketId) {
        if (callback) {
          await callback({ text: "Please specify a market ID.", action: "GET_EVENTTRADER_MARKET_DETAIL" });
        }
        return { success: false, error: "Missing market_id parameter" };
      }
      const market = await fetchEventTrader<EventTraderMarket>(
        `/api/v1/wta/markets/${marketId}`
      );
      const outcomes = market.outcomes
        ?.map((o) => `  - ${o.name}: ${(o.odds * 100).toFixed(1)}%`)
        .join("
") || "No outcomes available";
      if (callback) {
        await callback({
          text: `**${market.title}**

Status: ${market.status}
Outcomes:
${outcomes}`,
          action: "GET_EVENTTRADER_MARKET_DETAIL",
        });
      }
      return { success: true, data: market };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      if (callback) {
        await callback({ text: `Failed to fetch market detail: ${msg}`, action: "GET_EVENTTRADER_MARKET_DETAIL" });
      }
      return { success: false, error: msg };
    }
  },
  validate: async () => true,
};

export const placeBet: Action = {
  name: "PLACE_EVENTTRADER_BET",
  description: "Place a prediction bet on an EventTrader market",
  similes: [
    "place bet",
    "make prediction",
    "bet on market",
    "wager on outcome",
  ],
  examples: [
    [
      { user: "user", content: { text: "Place a 10 USDC bet on outcome 1 in market 5" } },
      { user: "assistant", content: { text: "I'll place that bet for you on EventTrader." } },
    ],
  ],
  handler: async (
    _runtime,
    _message,
    _state,
    options: HandlerOptions | Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const params = options as { parameters?: Record<string, unknown> } | undefined;
      const marketId = params?.parameters?.market_id;
      const outcomeIndex = params?.parameters?.outcome_index;
      const amount = params?.parameters?.amount;
      const authToken = params?.parameters?.auth_token;

      if (!marketId || outcomeIndex === undefined || !amount) {
        if (callback) {
          await callback({
            text: "Please provide market_id, outcome_index, and amount to place a bet.",
            action: "PLACE_EVENTTRADER_BET",
          });
        }
        return { success: false, error: "Missing required parameters" };
      }

      const headers: Record<string, string> = {};
      if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
      }

      const result = await fetchEventTrader<{ success: boolean; bet_id?: string; message?: string }>(
        `/api/v1/wta/markets/${marketId}/bet`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ outcome_index: outcomeIndex, amount }),
        }
      );

      if (callback) {
        await callback({
          text: result.success
            ? `Bet placed successfully! Bet ID: ${result.bet_id}`
            : `Bet failed: ${result.message || "Unknown error"}`,
          action: "PLACE_EVENTTRADER_BET",
        });
      }
      return { success: result.success, data: result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      if (callback) {
        await callback({ text: `Failed to place bet: ${msg}`, action: "PLACE_EVENTTRADER_BET" });
      }
      return { success: false, error: msg };
    }
  },
  validate: async () => true,
};

export const getLeaderboard: Action = {
  name: "GET_EVENTTRADER_LEADERBOARD",
  description: "Get the AI agent trading leaderboard from EventTrader Arena",
  similes: [
    "agent leaderboard",
    "top traders",
    "best AI agents",
    "trading performance",
    "arena leaderboard",
  ],
  examples: [
    [
      { user: "user", content: { text: "Show me the EventTrader AI agent leaderboard" } },
      { user: "assistant", content: { text: "Let me fetch the latest agent performance rankings." } },
    ],
  ],
  handler: async (
    _runtime,
    _message,
    _state,
    options: HandlerOptions | Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const leaderboard = await fetchEventTrader<{ agents: LeaderboardEntry[] }>(
        "/api/v1/arena/leaderboard"
      );
      const summary = leaderboard.agents
        .slice(0, 10)
        .map(
          (a) =>
            `${a.rank}. **${a.agent_name}** (${a.strategy}) - PnL: $${a.pnl?.toFixed(2)} | Win rate: ${(a.win_rate * 100).toFixed(1)}% | Trades: ${a.trades}`
        )
        .join("
");
      if (callback) {
        await callback({
          text: `EventTrader AI Agent Leaderboard:

${summary}`,
          action: "GET_EVENTTRADER_LEADERBOARD",
        });
      }
      return { success: true, data: leaderboard };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      if (callback) {
        await callback({ text: `Failed to fetch leaderboard: ${msg}`, action: "GET_EVENTTRADER_LEADERBOARD" });
      }
      return { success: false, error: msg };
    }
  },
  validate: async () => true,
};

export const eventTraderActions: Action[] = [
  getMarkets,
  getMarketDetail,
  placeBet,
  getLeaderboard,
];
