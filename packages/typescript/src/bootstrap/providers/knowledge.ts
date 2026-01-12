import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";

/**
 * Knowledge Provider - Provides relevant knowledge from the agent's knowledge base.
 *
 * This provider retrieves and formats relevant knowledge entries
 * based on the current context and message using semantic similarity search.
 */
export const knowledgeProvider: Provider = {
  name: "KNOWLEDGE",
  description:
    "Provides relevant knowledge from the agent's knowledge base based on semantic similarity",
  dynamic: true,

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const sections: string[] = [];
    const knowledgeEntries: Array<{
      id: string;
      text: string;
      source: string;
    }> = [];

    // Get message text for similarity search
    const queryText = message.content?.text || "";

    if (!queryText) {
      return {
        text: "",
        values: {
          knowledgeCount: 0,
          hasKnowledge: false as boolean,
        },
        data: {
          entries: [],
          query: "",
        },
      } as ProviderResult;
    }

    // Search for relevant knowledge using searchMemories with knowledge table
    const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: queryText,
    });
    const relevantKnowledge = await runtime.searchMemories({
      tableName: "knowledge",
      embedding,
      query: queryText,
      count: 5,
    });

    for (const entry of relevantKnowledge) {
      if (entry.content?.text) {
        let knowledgeText = entry.content.text;
        // Truncate if too long
        if (knowledgeText.length > 500) {
          knowledgeText = `${knowledgeText.substring(0, 500)}...`;
        }

        const entryData = {
          id: entry.id?.toString() || "",
          text: knowledgeText,
          source: (entry.metadata?.source as string | undefined) || "unknown",
        };
        knowledgeEntries.push(entryData);
        sections.push(`- ${knowledgeText}`);
      }
    }

    const contextText =
      sections.length > 0 ? `# Relevant Knowledge\n${sections.join("\n")}` : "";

    return {
      text: contextText,
      values: {
        knowledgeCount: knowledgeEntries.length,
        hasKnowledge: knowledgeEntries.length > 0,
      },
      data: {
        entries: knowledgeEntries,
        query: queryText,
      },
    } as ProviderResult;
  },
};
