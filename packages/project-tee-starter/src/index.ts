import { logger, type IAgentRuntime, type Project, type ProjectAgent } from '@elizaos/core';
import teeStarterPlugin, { StarterService } from './plugin.ts';
import { mrTeeCharacter as character } from './character.ts';
import ProjectTeeStarterTestSuite from './__tests__/e2e/project-tee-starter.e2e';

const initCharacter = ({ runtime }: { runtime: IAgentRuntime }) => {
  logger.info(`Initializing character: ${character.name}`);
};

/* Import the TEE plugin if you want to use it for a custom TEE agent */
export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => await initCharacter({ runtime }),
  tests: [ProjectTeeStarterTestSuite], // Export tests from ProjectAgent
};

const project: Project = {
  agents: [projectAgent],
};

export { character, teeStarterPlugin, StarterService };
export default project;
