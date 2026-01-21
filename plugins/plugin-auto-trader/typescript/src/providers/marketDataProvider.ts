import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

export const marketDataProvider: Provider = {
  name: "MARKET_DATA",
  get: async (_runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      // For now, provide mock market data
      // In a real implementation, this would fetch from real APIs
      const marketText = `📊 **Market Overview**

🔥 **Trending Tokens:**
• SOL: $102.45 (+2.3% 24h) - Vol: $2.1B
• ETH: $2,985.67 (+1.8% 24h) - Vol: $8.4B  
• BTC: $45,234.11 (+0.9% 24h) - Vol: $15.2B

📈 **Market Sentiment:** Bullish
🏛️ **Fear & Greed Index:** 68 (Greed)
💎 **Total Market Cap:** $1.82T

⚡ **Quick Stats:**
• Active DEX Pairs: 12,847
• 24h Volume: $28.6B
• BTC Dominance: 48.2%`;

      return { text: marketText };
    } catch (error) {
      console.error("[MarketDataProvider] Error:", error);
      return { text: "Market data is currently unavailable." };
    }
  },
};
