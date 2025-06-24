import {
  logger,
  type IAgentRuntime,
  type Project,
  type ProjectAgent,
} from '@elizaos/core';
import mrTeePlugin from './plugin';
import { mrTeeCharacter } from './character';

const initCharacter = ({ runtime }: { runtime: IAgentRuntime }) => {
  logger.info(`Initializing character: ${mrTeeCharacter.name}`);
};

export const projectAgent: ProjectAgent = {
  character: mrTeeCharacter,
  init: async (runtime: IAgentRuntime) => await initCharacter({ runtime }),
  plugins: [mrTeePlugin],
};

const project: Project = {
  agents: [projectAgent],
};

export { mrTeeCharacter as character, mrTeePlugin as plugin };
export default project;
