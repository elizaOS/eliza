import {
  logger,
  type Character,
  type IAgentRuntime,
  type Project,
  type ProjectAgent,
} from '@elizaos/core';
import mrTeePlugin from './plugin';
import { mrTeeCharacter } from './character';

/**
 * Represents the default character (Eliza) with her specific attributes and behaviors.
 * Eliza responds to a wide range of messages, is helpful and conversational.
 * She interacts with users in a concise, direct, and helpful manner, using humor and empathy effectively.
 * Eliza's responses are geared towards providing assistance on various topics while maintaining a friendly demeanor.
 */
export const character: Character = mrTeeCharacter;

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

export default project;
