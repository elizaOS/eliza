import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("FACTS");

/**
 * Formats an array of memories into a single string with each memory content text separated by a new line.
 *
 * @param {Memory[]} facts - An array of Memory objects to be formatted.
 * @returns {string} A single string containing all memory content text with new lines separating each text.
 */
/**
 * Formats an array of Memory objects into a string, joining them with newlines.
 *
 * @param {Memory[]} facts - An array of Memory objects to format.
 * @returns {string} The formatted string with each Memory object's text joined by newlines.
 */
function formatFacts(facts: Memory[]) {
  const result: string[] = [];
  for (let i = facts.length - 1; i >= 0; i -= 1) {
    result.push(facts[i]?.content.text ?? "");
  }
  return result.join("\n");
}

/**
 * Function to get key facts that the agent knows.
 * @param {IAgentRuntime} runtime - The runtime environment for the agent.
 * @param {Memory} message - The message object containing relevant information.
 * @param {State} [_state] - Optional state information.
 * @returns {Object} An object containing values, data, and text related to the key facts.
 */
const factsProvider: Provider = {
  name: spec.name,
  description: spec.description,
  dynamic: spec.dynamic ?? true,
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    // Parallelize initial data fetching operations including recentInteractions
    const recentMessages = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      count: 10,
      unique: false,
    });

    // join the text of the last 5 messages
    const lastMessageLines: string[] = [];
    for (
      let i = recentMessages.length - 1;
      i >= 0 && lastMessageLines.length < 5;
      i -= 1
    ) {
      lastMessageLines.push(recentMessages[i]?.content.text ?? "");
    }
    lastMessageLines.reverse();
    const last5Messages = lastMessageLines.join("\n");

    const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: last5Messages,
    });

    const [relevantFacts, recentFactsData] = await Promise.all([
      runtime.searchMemories({
        tableName: "facts",
        embedding,
        roomId: message.roomId,
        worldId: message.worldId,
        count: 6,
        query: message.content.text,
      }),
      runtime.searchMemories({
        embedding,
        query: message.content.text,
        tableName: "facts",
        roomId: message.roomId,
        entityId: message.entityId,
        count: 6,
      }),
    ]);

    // join the two and deduplicate
    const seenIds = new Set<string>();
    const allFacts: Memory[] = [];
    for (const fact of [...relevantFacts, ...recentFactsData]) {
      const factId = fact.id ?? "";
      if (factId && !seenIds.has(factId)) {
        seenIds.add(factId);
        allFacts.push(fact);
      }
    }

    if (allFacts.length === 0) {
      return {
        values: {
          facts: "",
        },
        data: {
          facts: allFacts,
        },
        text: "No facts available.",
      };
    }

    const formattedFacts = formatFacts(allFacts);

    const agentName = runtime.character.name ?? "Agent";
    const text = "Key facts that {{agentName}} knows:\n{{formattedFacts}}"
      .replace("{{agentName}}", agentName)
      .replace("{{formattedFacts}}", formattedFacts);

    return {
      values: {
        facts: formattedFacts,
      },
      data: {
        facts: allFacts,
      },
      text,
    };
  },
};

export { factsProvider };
