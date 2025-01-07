import {
    Provider,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger
} from "@ai16z/eliza";

export const sampleProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
        // Data retrieval logic for the provider
        elizaLogger.log("Retrieving data in sampleProvider...");
    },
};
