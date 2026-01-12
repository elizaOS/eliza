import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { getElizaGreeting } from "../models/text";

export const elizaGreetingProvider: Provider = {
  name: "eliza-greeting",

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<{
    data: { greeting: string };
    values: { greeting: string };
    text: string;
  }> => {
    const greeting = getElizaGreeting();

    return {
      data: {
        greeting,
      },
      values: {
        greeting,
      },
      text: greeting,
    };
  },
};

export default elizaGreetingProvider;
