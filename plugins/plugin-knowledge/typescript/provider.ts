import type { IAgentRuntime, Memory, Provider } from "@elizaos/core";
import { addHeader, logger } from "@elizaos/core";
import type { KnowledgeService } from "./service.ts";

/**
 * Represents a knowledge provider that retrieves knowledge from the knowledge base.
 * @type {Provider}
 * @property {string} name - The name of the knowledge provider.
 * @property {string} description - The description of the knowledge provider.
 * @property {boolean} dynamic - Indicates if the knowledge provider is dynamic or static.
 * @property {Function} get - Asynchronously retrieves knowledge from the knowledge base.
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {Memory} message - The message containing the query for knowledge retrieval.
 * @returns {Object} An object containing the retrieved knowledge data, values, and text.
 */
export const knowledgeProvider: Provider = {
  name: "KNOWLEDGE",
  description:
    "Knowledge from the knowledge base that the agent knows, retrieved whenever the agent needs to answer a question about their expertise.",
  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory) => {
    const knowledgeService = runtime.getService("knowledge") as KnowledgeService;
    const knowledgeData = await knowledgeService?.getKnowledge(message);

    const firstFiveKnowledgeItems = knowledgeData?.slice(0, 5);

    let knowledge = `${
      firstFiveKnowledgeItems && firstFiveKnowledgeItems.length > 0
        ? addHeader(
            "# Knowledge",
            firstFiveKnowledgeItems.map((knowledge) => `- ${knowledge.content.text}`).join("\n")
          )
        : ""
    }\n`;

    const tokenLength = 3.5;

    if (knowledge.length > 4000 * tokenLength) {
      knowledge = knowledge.slice(0, 4000 * tokenLength);
    }

    // 📊 Prepare RAG metadata for conversation memory tracking
    let ragMetadata = null;
    if (knowledgeData && knowledgeData.length > 0) {
      ragMetadata = {
        retrievedFragments: knowledgeData.map((fragment) => {
          const fragmentMetadata = fragment.metadata as Record<string, unknown> | undefined;
          return {
            fragmentId: fragment.id,
            documentTitle:
              (fragmentMetadata?.filename as string) ||
              (fragmentMetadata?.title as string) ||
              "Unknown Document",
            similarityScore: (fragment as { similarity?: number }).similarity,
            contentPreview: `${(fragment.content?.text || "No content").substring(0, 100)}...`,
          };
        }),
        queryText: message.content?.text || "Unknown query",
        totalFragments: knowledgeData.length,
        retrievalTimestamp: Date.now(),
      };
    }

    // 🎯 Store RAG metadata for conversation memory enrichment
    if (knowledgeData && knowledgeData.length > 0 && knowledgeService && ragMetadata) {
      try {
        knowledgeService.setPendingRAGMetadata(ragMetadata);

        // Schedule enrichment check (with small delay to allow memory creation)
        setTimeout(async () => {
          try {
            await knowledgeService.enrichRecentMemoriesWithPendingRAG();
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn("RAG memory enrichment failed:", errorMessage);
          }
        }, 2000); // 2 second delay
      } catch (error) {
        // Don't fail the provider if enrichment fails
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn("RAG memory enrichment failed:", errorMessage);
      }
    }

    return {
      data: {
        knowledge,
        ragMetadata, // 🎯 Include RAG metadata for memory tracking
        knowledgeUsed: knowledgeData && knowledgeData.length > 0, // Simple flag for easy detection
      },
      values: {
        knowledge,
        knowledgeUsed: knowledgeData && knowledgeData.length > 0, // Simple flag for easy detection
      },
      text: knowledge,
      ragMetadata, // 🎯 Also include at top level for easy access
      knowledgeUsed: knowledgeData && knowledgeData.length > 0, // 🎯 Simple flag at top level too
    };
  },
};
