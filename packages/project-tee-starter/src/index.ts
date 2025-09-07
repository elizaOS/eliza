import { logger, type IAgentRuntime, type Project, type ProjectAgent } from '@elizaos/core';
import teeStarterPlugin, { StarterService } from './plugin.ts';
import { mrTeeCharacter as character } from './character.ts';

const initCharacter = ({ runtime }: { runtime: IAgentRuntime }) => {
  logger.info(`Initializing character: ${character.name}`);
};

/* Import the TEE plugin if you want to use it for a custom TEE agent */
export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => await initCharacter({ runtime }),
  plugins: [teeStarterPlugin], // Add any additional plugins here
};

const project: Project = {
  agents: [projectAgent],
};

export { character, teeStarterPlugin, StarterService };
export default project;
