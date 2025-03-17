import { addHeader } from '../prompts';
import type { IAgentRuntime, Memory, Provider } from '../types';

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
  description: 'Knowledge from the knowledge base that the agent knows',
  dynamic: true,
  get: async (runtime: IAgentRuntime, message: Memory) => {
    const knowledgeData = await runtime.getKnowledge(message);

    const knowledge =
      knowledgeData && knowledgeData.length > 0
        ? addHeader(
            '# Knowledge',
            knowledgeData.map((knowledge) => `- ${knowledge.content.text}`).join('\n')
          )
        : '';

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
