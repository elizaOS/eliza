import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

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

  get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
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
          hasKnowledge: false,
        },
        data: {
          entries: [],
        },
      };
    }

    try {
      // Search for relevant knowledge
      const relevantKnowledge = await runtime.searchKnowledge({
        query: queryText,
        limit: 5,
      });

      for (const entry of relevantKnowledge) {
        if (entry.content?.text) {
          let knowledgeText = entry.content.text;
          // Truncate if too long
          if (knowledgeText.length > 500) {
            knowledgeText = knowledgeText.substring(0, 500) + "...";
          }

          const entryData = {
            id: entry.id?.toString() || "",
            text: knowledgeText,
            source:
              (entry.metadata?.source as string | undefined) || "unknown",
          };
          knowledgeEntries.push(entryData);
          sections.push(`- ${knowledgeText}`);
        }
      }
    } catch (error) {
      runtime.logger.warn(
        {
          src: "provider:knowledge",
          error: error instanceof Error ? error.message : String(error),
        },
        "Error searching knowledge base",
      );
    }

    const contextText =
      sections.length > 0
        ? `# Relevant Knowledge\n${sections.join("\n")}`
        : "";

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
    };
  },
};


