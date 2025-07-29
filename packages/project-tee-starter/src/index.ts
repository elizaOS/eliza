import { logger, type IAgentRuntime, type Project, type ProjectAgent } from '@elizaos/core';
// import mrTeePlugin from './plugin.ts';
import { mrTeeCharacter as character } from './character.ts';

const initCharacter = ({ runtime }: { runtime: IAgentRuntime }) => {
  logger.info(`Initializing character: ${character.name}`);
};

export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => await initCharacter({ runtime }),
  // plugins: [mrTeePlugin],
};

const project: Project = {
  agents: [projectAgent],
};

export { character };
export default project;
