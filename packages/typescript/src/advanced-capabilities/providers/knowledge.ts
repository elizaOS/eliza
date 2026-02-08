import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("KNOWLEDGE");

/**
 * Knowledge Provider - Provides relevant knowledge from the agent's knowledge base.
 *
 * This provider retrieves and formats relevant knowledge entries
 * based on the current context and message using semantic similarity search.
 */
export const knowledgeProvider: Provider = {
  name: spec.name,
  description: spec.description,
  dynamic: spec.dynamic ?? true,

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
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

    if (relevantKnowledge.length === 0) {
      return {
        text: "",
        values: {
          knowledgeCount: 0,
          hasKnowledge: false as boolean,
        },
        data: {
          entries: [],
          query: queryText,
        },
      } as ProviderResult;
    }

    const sections: string[] = [];
    const knowledgeEntries: Array<{
      id: string;
      text: string;
      source: string;
    }> = [];

    for (const entry of relevantKnowledge) {
      const text = entry.content?.text;
      if (!text) continue;
      let knowledgeText = text;
      if (knowledgeText.length > 500) {
        knowledgeText = `${knowledgeText.substring(0, 500)}...`;
      }

      knowledgeEntries.push({
        id: entry.id?.toString() || "",
        text: knowledgeText,
        source: (entry.metadata?.source as string | undefined) || "unknown",
      });
      sections.push(`- ${knowledgeText}`);
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
