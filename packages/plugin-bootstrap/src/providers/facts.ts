import type { Memory, Provider, State } from "@elizaos/core";
import {
    formatMessages,
    type IAgentRuntime,
    MemoryManager,
    ModelClass
} from "@elizaos/core";
import { formatFacts } from "../evaluators/fact.ts";

const factsProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        const recentMessagesData = state?.recentMessagesData?.slice(-10);
        console.log("get", message);


        const recentMessages = formatMessages({
            messages: recentMessagesData,
            actors: state?.actorsData,
        });

        const embedding = await runtime.useModel(ModelClass.TEXT_EMBEDDING, recentMessages);

        const memoryManager = new MemoryManager({
            runtime,
            tableName: "facts",
        });

        const relevantFacts = await memoryManager.searchMemories({
            embedding,
            roomId: message.roomId,
            count: 10,
            agentId: runtime.agentId,
        });

        const recentFactsData = await memoryManager.getMemories({
            roomId: message.roomId,
            count: 10,
            start: 0,
            end: Date.now(),
        });

        // join the two and deduplicate
        const allFacts = [...relevantFacts, ...recentFactsData].filter(
            (fact, index, self) =>
                index === self.findIndex((t) => t.id === fact.id)
        );

        if (allFacts.length === 0) {
            return "";
        }

        const formattedFacts = formatFacts(allFacts);

        return "Key facts that {{agentName}} knows:\n{{formattedFacts}}"
            .replace("{{agentName}}", runtime.character.name)
            .replace("{{formattedFacts}}", formattedFacts);
    },
};

export { factsProvider };
