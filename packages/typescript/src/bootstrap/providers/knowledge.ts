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
  position: 60,
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

    // Get message text for keyword search (if supported) or fallback
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
    // This avoids blocking on generating an embedding for the CURRENT message

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

    // If no recent embeddings (e.g. new conversation), we can't do vector search
    // without blocking. For now, we accept this trade-off for speed.
    // Ideally, we would fallback to keyword search if the adapter supports it.

    const relevantKnowledge = new Map<string, any>();

    if (embeddings.length > 0) {
      // 3. Search using recent embeddings
      // We'll use the most recent embedding primarily, or perhaps a few
      // For now, let's use the most recent one (last in the list likely, depending on sort)
      // recentMessages are usually returned sorted by time desc?
      // getMemories impl usually returns DESC.
      // So the first one is the most recent.

      const primaryEmbedding = embeddings[0];

      const results = await runtime.searchMemories({
        tableName: "knowledge",
        embedding: primaryEmbedding,
        query: queryText, // Pass query text for hybrid search if supported
        count: 5,
        match_threshold: 0.75, // Reasonable threshold
      });

      for (const entry of results) {
        if (entry.id) relevantKnowledge.set(entry.id.toString(), entry);
      }
    }

    // 4. Format results
    const uniqueEntries = Array.from(relevantKnowledge.values());

    for (const entry of uniqueEntries) {
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
