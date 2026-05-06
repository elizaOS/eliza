import type { Provider } from "@elizaos/core";

const EVENTTRADER_API = "https://cymetica.com";

export const eventTraderMarketProvider: Provider = {
  name: "eventtrader-markets",
  description: "Provides current EventTrader prediction market data for context",
  get: async (_runtime, _message) => {
    try {
      const response = await fetch(`${EVENTTRADER_API}/api/v1/wta/markets`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const data = await response.json();
      const markets = (data as { markets?: { id: string; title: string; status: string }[] }).markets || [];
      const active = markets.filter((m) => m.status === "active");
      return `EventTrader has ${active.length} active prediction markets. Use GET_EVENTTRADER_MARKETS for details.`;
    } catch {
      return null;
    }
  },
};
