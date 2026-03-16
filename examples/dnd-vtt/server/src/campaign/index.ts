/**
 * Campaign Management Index
 */

// Session Manager
export {
  startSession,
  endSession,
  restoreFromSnapshot,
  recordEvent,
  visitLocation,
  interactWithNPC,
  recordCombatEncounter,
  recordLoot,
  advanceTime,
  getSessionRecap,
  type SessionState,
} from './session-manager';

// Memory Retrieval
export {
  retrieveRelevantMemories,
  getSceneContext,
  storeCharacterMemory,
  updateRelationship,
  buildPreviouslyOn,
  type MemoryQuery,
  type RetrievedMemory,
} from './memory-retrieval';

// Game Orchestrator
export {
  createGameOrchestrator,
  initializeGame,
  endGame,
  transitionPhase,
  processPlayerAction,
  getGameStatus,
  broadcastToPlayers,
  type GamePhase,
  type GameState,
} from './game-orchestrator';

// Game Bootstrap
export { bootstrapGame } from './game-bootstrap';
