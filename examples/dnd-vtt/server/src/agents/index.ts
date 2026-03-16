/**
 * Agents Index
 * Exports all agent configurations
 */

// DM Agent
export { dmCharacter, createDMAgent, dmPlugin } from './dm-agent';

// Player Agent
export { 
  createPlayerAgent, 
  createPlayerCharacter,
  playerPlugin,
  type PersonalityArchetype,
  type PlayerPersonality,
} from './player-agent';
