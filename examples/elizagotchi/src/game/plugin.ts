/**
 * Elizagotchi Game State Manager
 * 
 * Manages the game state for the React UI.
 * This is a standalone version - no elizaOS dependencies needed.
 * 
 * Can be integrated with elizaOS as a plugin by uncommenting the plugin export
 * and adding @elizaos/core as a dependency.
 */

import {
  createNewPet,
  tickUpdate,
  performAction,
  checkHatch,
  parseCommand,
  formatStatus,
  getHelp,
} from "./engine";
import type { PetState, Action } from "./types";

// ============================================================================
// GAME STATE MANAGEMENT
// ============================================================================

// In-memory state (singleton for browser)
let gameState: PetState | null = null;
let lastTickTime = 0;
const TICK_INTERVAL = 1000; // Update every second

/**
 * Get the current game state, creating a new pet if none exists
 */
export function getGameState(): PetState {
  if (!gameState) {
    gameState = createNewPet("Elizagotchi");
  }
  return gameState;
}

/**
 * Set the game state (for loading from storage)
 */
export function setGameState(state: PetState): void {
  gameState = state;
}

/**
 * Reset the game with a new pet
 */
export function resetGame(name?: string): PetState {
  gameState = createNewPet(name || "Elizagotchi");
  lastTickTime = Date.now();
  return gameState;
}

/**
 * Update the game state based on time passed
 */
export function updateGame(): PetState {
  const now = Date.now();
  let state = getGameState();
  
  // Check for hatching first
  if (state.stage === "egg") {
    const hatchResult = checkHatch(state);
    if (hatchResult.hatched) {
      state = hatchResult.newState;
      gameState = state;
      return state;
    }
  }
  
  // Apply time-based updates
  if (now - lastTickTime >= TICK_INTERVAL) {
    state = tickUpdate(state);
    gameState = state;
    lastTickTime = now;
  }
  
  return state;
}

/**
 * Execute a game action
 */
export function executeAction(action: Action): {
  success: boolean;
  message: string;
  state: PetState;
} {
  const state = getGameState();
  const result = performAction(state, action);
  gameState = result.newState;
  
  return {
    success: result.success,
    message: result.message,
    state: result.newState,
  };
}

/**
 * Process a text command (for CLI or chat interface)
 */
export function processCommand(text: string): string {
  // Update game state first
  updateGame();
  
  // Parse the command
  const command = parseCommand(text);
  
  if (!command) {
    // Unknown command - show help
    return `I didn't understand that. ${getHelp()}`;
  }
  
  switch (command.action) {
    case "status":
      return formatStatus(getGameState());
    
    case "help":
      return getHelp();
    
    case "reset": {
      const newState = resetGame();
      return `🥚 A new egg appeared!\n\nMeet ${newState.name}!\n` +
             `Take good care of them and watch them grow!`;
    }
    
    case "name": {
      if (command.parameter) {
        const state = getGameState();
        state.name = command.parameter;
        gameState = state;
        return `Your pet is now named "${command.parameter}"! 💕`;
      }
      return `What would you like to name your pet?`;
    }
    
    default: {
      // It's a game action
      const result = executeAction(command.action as Action);
      return result.message + "\n\n" + formatStatus(result.state);
    }
  }
}

// Export for direct use in React components
export {
  formatStatus,
  getHelp,
  parseCommand,
};

// ============================================================================
// ELIZAOS PLUGIN (Optional - uncomment to use with elizaOS runtime)
// ============================================================================
/*
import type { Plugin, IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";

async function elizagotchiModelHandler(
  _runtime: IAgentRuntime,
  params: { prompt?: string; messages?: Array<{ content: string }> }
): Promise<string> {
  let promptText = "";
  if (params.prompt) {
    promptText = params.prompt;
  } else if (params.messages && params.messages.length > 0) {
    promptText = params.messages.map((m) => m.content).join("\n");
  }
  
  if (!promptText) {
    return formatStatus(getGameState());
  }
  
  return processCommand(promptText);
}

export const elizagotchiPlugin: Plugin = {
  name: "elizagotchi",
  description: "Virtual pet game - no LLM needed, pure game logic!",
  priority: 100,
  models: {
    [ModelType.TEXT_LARGE]: elizagotchiModelHandler,
    [ModelType.TEXT_SMALL]: elizagotchiModelHandler,
  },
};
*/
