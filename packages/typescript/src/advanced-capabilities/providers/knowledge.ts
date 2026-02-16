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

    // New Strategy: Use embeddings from recent messages to find relevant knowledge

    // 1. Fetch recent messages
    const recentMessages = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      count: 5,
      unique: false,
    });

    // 2. Extract valid embeddings
    const embeddings = recentMessages
      .map((m) => m.embedding)
      .filter((e): e is number[] => !!e && e.length > 0);

    const relevantKnowledge = new Map<string, any>();

    if (embeddings.length > 0) {
      // 3. Search using recent embeddings
      const primaryEmbedding = embeddings[0];

      const results = await runtime.searchMemories({
        tableName: "knowledge",
        embedding: primaryEmbedding,
        query: queryText,
        count: 5,
        match_threshold: 0.75,
      });

      for (const entry of results) {
        if (entry.id) relevantKnowledge.set(entry.id.toString(), entry);
      }
    }

    const relevantKnowledgeArray = Array.from(relevantKnowledge.values());

    if (relevantKnowledgeArray.length === 0) {
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

    // Reuse existing loop variable name by re-assigning or just using the array
    // The original code used `relevantKnowledge` as the array.
    // We can just proceed to loop over `relevantKnowledgeArray`.

    // ... we need to make sure the next block uses relevantKnowledgeArray
    // But replace_file_content replaces a chunk.
    // The original code continues with:
    // if (relevantKnowledge.length === 0) { ... }
    // for (const entry of relevantKnowledge) { ... }

    // So I should include that part in the replacement or ensure variable names match.
    // Let's redefine `relevantKnowledge` as the array to minimize changes below.
    const finalRelevantKnowledge = relevantKnowledgeArray;

    if (finalRelevantKnowledge.length === 0) {
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

    for (const entry of finalRelevantKnowledge) {
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
