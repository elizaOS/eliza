import {
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    Action
} from "@elizaos/core";

export const getPrice: Action = {
  name: 'getPrice',
  description: 'Get coin price from CoinGecko API',
    handler: async (runtime: IAgentRuntime, 
                    message: Memory,  
                    state: State,
                    options: { [key: string]: unknown },
                    callback: HandlerCallback) => {
        try{
            elizaLogger.log("[coingecko] Handle with message ...");
            callback({
              text: "Price is 100K! Bullish!",
              attachments: []
            })
            elizaLogger.log("[coingecko] Handle with message ...DONE!");
            return [];
        }
        catch(error){
            elizaLogger.error("[coingecko] %s", error);
            return false;
        }
    },
    validate: async (runtime: IAgentRuntime, message: Memory) => {
      elizaLogger.log("[coingecko] Validating ...");
      elizaLogger.log("[coingecko] Validating ...DONE");
      return true;
    },
    similes: [
      "check price",
      "token price",
      "get token price",
      "price check",
      "how much is",
      "what's the price of",
      "what is the price of",
      "price of",
      "show me price",
      "current price",
      "market price"
    ],
    examples: []
};