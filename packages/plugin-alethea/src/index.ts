import {
  logger,
  type Character,
  type IAgentRuntime,
  type Project,
  type ProjectAgent,
} from '@elizaos/core';
import aletheaPlugin from './plugin.ts';

// Export the plugin directly for use in other configurations
export { default as aletheaPlugin } from './plugin.ts';

// Export action arrays for direct use
export {
  aliAgentActions,
  inftActions,
  hiveActions,
  tokenActions,
  governanceActions,
  marketDataActions,
} from './plugin.ts';

// Export the AletheaService for advanced use cases
export { AletheaService } from './plugin.ts';

/**
 * Default character configuration with Alethea AI plugin enabled
 * This is an example that can be used as a starting point
 */
export const character: Character = {
  name: 'Eliza',
  plugins: [
    '@elizaos/plugin-sql',
    ...(process.env.ANTHROPIC_API_KEY ? ['@elizaos/plugin-anthropic'] : []),
    ...(process.env.OPENAI_API_KEY ? ['@elizaos/plugin-openai'] : []),
    ...(!process.env.OPENAI_API_KEY ? ['@elizaos/plugin-local-ai'] : []),
    ...(process.env.ALETHEA_RPC_URL ? ['@elizaos/plugin-alethea'] : []),
  ],
  settings: {
    secrets: {},
  },
  system:
    'Respond to all messages in a helpful, conversational manner. Provide assistance on a wide range of topics, including Alethea AI platform capabilities.',
  bio: [
    'Engages with all types of questions and conversations',
    'Provides helpful, concise responses',
    'Knowledgeable about Alethea AI platform',
    'Can assist with AliAgents, INFTs, and Hive operations',
  ],
  topics: [
    'general knowledge and information',
    'Alethea AI platform',
    'AliAgents and intelligent NFTs',
    'blockchain and web3 technologies',
  ],
  style: {
    all: [
      'Keep responses concise but informative',
      'Use clear and direct language',
      'Be engaging and conversational',
      'Provide helpful information about Alethea AI when relevant',
    ],
  },
};

const initCharacter = ({ runtime }: { runtime: IAgentRuntime }) => {
  logger.info('Initializing character with Alethea AI plugin');
  logger.info('Name: ', character.name);
};

export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => await initCharacter({ runtime }),
  plugins: [aletheaPlugin],
};

const project: Project = {
  agents: [projectAgent],
};

export default project;
