import type { IAgentRuntime, Memory, Provider } from "@elizaos/core";
import { addHeader } from "@elizaos/core";
import type { KnowledgeService } from "./service.ts";

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

    let ragMetadata = null;
    if (knowledgeData && knowledgeData.length > 0) {
      ragMetadata = {
        retrievedFragments: knowledgeData.map((fragment) => {
          const fragmentMetadata = fragment.metadata as Record<string, unknown> | undefined;
          return {
            fragmentId: fragment.id,
            documentTitle:
              (fragmentMetadata?.filename as string) || (fragmentMetadata?.title as string) || "",
            similarityScore: (fragment as { similarity?: number }).similarity,
            contentPreview: `${(fragment.content?.text || "").substring(0, 100)}...`,
          };
        }),
        queryText: message.content?.text || "",
        totalFragments: knowledgeData.length,
        retrievalTimestamp: Date.now(),
      };
    }

    if (knowledgeData && knowledgeData.length > 0 && knowledgeService && ragMetadata) {
      knowledgeService.setPendingRAGMetadata(ragMetadata);
      setTimeout(async () => {
        try {
          await knowledgeService.enrichRecentMemoriesWithPendingRAG();
        } catch {}
      }, 2000);
    }

    return {
      data: {
        knowledge,
        ragMetadata,
        knowledgeUsed: knowledgeData && knowledgeData.length > 0,
      },
      values: {
        knowledge,
        knowledgeUsed: knowledgeData && knowledgeData.length > 0,
      },
      text: knowledge,
      ragMetadata,
      knowledgeUsed: knowledgeData && knowledgeData.length > 0,
    };
  },
};
