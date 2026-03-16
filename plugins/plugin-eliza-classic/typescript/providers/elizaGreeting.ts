import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import { getElizaGreeting } from "../models/text";

const spec = requireProviderSpec("eliza-greeting");

export const elizaGreetingProvider: Provider = {
  name: spec.name,

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
