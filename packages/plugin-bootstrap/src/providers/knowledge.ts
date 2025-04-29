import type { IAgentRuntime, Memory, Provider } from '@elizaos/core';
import { addHeader } from '@elizaos/core';

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
  name: 'KNOWLEDGE',
  description:
    'Knowledge from the knowledge base that the agent knows, retrieved whenever the agent needs to answer a question about their expertise.',
  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory) => {
    const knowledgeData = await runtime.getKnowledge(message);

    const firstFiveKnowledgeItems = knowledgeData?.slice(0, 5);

    let knowledge =
      (firstFiveKnowledgeItems && firstFiveKnowledgeItems.length > 0
        ? addHeader(
            '# Knowledge',
            firstFiveKnowledgeItems.map((knowledge) => `- ${knowledge.content.text}`).join('\n')
          )
        : '') + '\n';

    const tokenLength = 3.5;

    if (knowledge.length > 4000 * tokenLength) {
      knowledge = knowledge.slice(0, 4000 * tokenLength);
    }

    return {
      data: {
        knowledge,
      },
      values: {
        knowledge,
      },
      text: knowledge,
    };
  },
};
