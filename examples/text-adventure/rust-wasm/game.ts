/**
 * elizaOS Adventure Game Demo
 *
 * A text adventure game where an AI agent (powered by elizaOS) explores a dungeon,
 * making decisions about which actions to take. Demonstrates:
 * - elizaOS runtime with plugins
 * - Embedded database persistence via PGLite (serverless PostgreSQL)
 * - OpenAI integration for AI decision making
 * - Custom game actions
 * - State management with memories
 *
 * Usage:
 *   LOG_LEVEL=fatal OPENAI_API_KEY=your_key bun run examples/rust-wasm/adventure-game.ts
 *
 * For persistent storage (survives restarts):
 *   PGLITE_DATA_DIR=./adventure-db OPENAI_API_KEY=your_key bun run examples/rust-wasm/adventure-game.ts
 */

// MUST be set before any imports to suppress elizaOS logs and AI SDK warnings
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "fatal";
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;

import * as clack from "@clack/prompts";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// GAME WORLD DEFINITION
// ============================================================================

interface Item {
  id: string;
  name: string;
  description: string;
  usable: boolean;
}

interface Room {
  id: string;
  name: string;
  description: string;
  exits: { [direction: string]: string };
  items: Item[];
  enemy?: Enemy;
  visited: boolean;
}

interface Enemy {
  name: string;
  health: number;
  damage: number;
  description: string;
  defeatedMessage: string;
}

interface GameState {
  currentRoom: string;
  inventory: Item[];
  health: number;
  maxHealth: number;
  score: number;
  turnsPlayed: number;
  gameOver: boolean;
  victory: boolean;
  messages: string[];
}

// Game world definition
const ITEMS: Record<string, Item> = {
  torch: {
    id: "torch",
    name: "Rusty Torch",
    description: "A flickering torch that casts dancing shadows",
    usable: true,
  },
  key: {
    id: "key",
    name: "Golden Key",
    description: "An ornate key with strange symbols",
    usable: true,
  },
  sword: {
    id: "sword",
    name: "Ancient Sword",
    description: "A weathered but sharp blade",
    usable: true,
  },
  potion: {
    id: "potion",
    name: "Health Potion",
    description: "A glowing red liquid that restores health",
    usable: true,
  },
  treasure: {
    id: "treasure",
    name: "Dragon's Treasure",
    description: "A chest overflowing with gold and gems",
    usable: false,
  },
};

const ENEMIES: Record<string, Enemy> = {
  goblin: {
    name: "Cave Goblin",
    health: 30,
    damage: 10,
    description: "A snarling goblin blocks your path, brandishing a crude club",
    defeatedMessage: "The goblin crumples to the ground, defeated!",
  },
  skeleton: {
    name: "Skeletal Guardian",
    health: 40,
    damage: 15,
    description: "Ancient bones rattle as a skeleton warrior rises to face you",
    defeatedMessage: "The skeleton collapses into a pile of bones!",
  },
  dragon: {
    name: "Ancient Dragon",
    health: 100,
    damage: 25,
    description:
      "A massive dragon guards its treasure, smoke curling from its nostrils",
    defeatedMessage:
      "With a final roar, the dragon falls! The treasure is yours!",
  },
};

function createGameWorld(): Record<string, Room> {
  return {
    entrance: {
      id: "entrance",
      name: "Dungeon Entrance",
      description:
        "You stand at the entrance of a dark dungeon. Cold air flows from within, carrying whispers of adventure and danger. Stone steps lead down into darkness.",
      exits: { north: "hallway" },
      items: [{ ...ITEMS.torch }],
      visited: false,
    },
    hallway: {
      id: "hallway",
      name: "Torch-lit Hallway",
      description:
        "A long hallway stretches before you, ancient torches casting flickering light on the stone walls. Cobwebs hang from the ceiling.",
      exits: { south: "entrance", north: "chamber", east: "armory" },
      items: [],
      enemy: { ...ENEMIES.goblin },
      visited: false,
    },
    armory: {
      id: "armory",
      name: "Abandoned Armory",
      description:
        "Rusted weapons line the walls of this forgotten armory. Most are beyond use, but something glints in the corner.",
      exits: { west: "hallway" },
      items: [{ ...ITEMS.sword }, { ...ITEMS.potion }],
      visited: false,
    },
    chamber: {
      id: "chamber",
      name: "Central Chamber",
      description:
        "A vast underground chamber with a domed ceiling. Three passages branch off into darkness. A locked door stands to the north.",
      exits: {
        south: "hallway",
        east: "crypt",
        west: "library",
        north: "throne",
      },
      items: [],
      enemy: { ...ENEMIES.skeleton },
      visited: false,
    },
    library: {
      id: "library",
      name: "Ancient Library",
      description:
        "Dusty tomes fill towering shelves. The air smells of old paper and forgotten knowledge. A golden key lies on a reading table.",
      exits: { east: "chamber" },
      items: [{ ...ITEMS.key }],
      visited: false,
    },
    crypt: {
      id: "crypt",
      name: "Dark Crypt",
      description:
        "Stone sarcophagi line the walls of this burial chamber. The silence is oppressive.",
      exits: { west: "chamber" },
      items: [{ ...ITEMS.potion }],
      visited: false,
    },
    throne: {
      id: "throne",
      name: "Dragon's Throne Room",
      description:
        "A massive cavern dominated by an ancient throne. Piles of gold and gems surround it. This is the dragon's lair!",
      exits: { south: "chamber" },
      items: [{ ...ITEMS.treasure }],
      enemy: { ...ENEMIES.dragon },
      visited: false,
    },
  };
}

// ============================================================================
// GAME ENGINE
// ============================================================================

class AdventureGame {
  private world: Record<string, Room>;
  private state: GameState;

  constructor() {
    this.world = createGameWorld();
    this.state = {
      currentRoom: "entrance",
      inventory: [],
      health: 100,
      maxHealth: 100,
      score: 0,
      turnsPlayed: 0,
      gameOver: false,
      victory: false,
      messages: [],
    };
  }

  getState(): GameState {
    return { ...this.state };
  }

  getCurrentRoom(): Room {
    return this.world[this.state.currentRoom];
  }

  getAvailableActions(): string[] {
    const room = this.getCurrentRoom();
    const actions: string[] = [];

    // Movement
    for (const dir of Object.keys(room.exits)) {
      // Check if north requires key for throne room
      if (dir === "north" && room.id === "chamber") {
        if (this.state.inventory.some((i) => i.id === "key")) {
          actions.push(`go ${dir}`);
        } else {
          // Don't add the action, door is locked
        }
      } else {
        actions.push(`go ${dir}`);
      }
    }

    // Pick up items
    for (const item of room.items) {
      actions.push(`take ${item.name.toLowerCase()}`);
    }

    // Combat
    if (room.enemy && room.enemy.health > 0) {
      actions.push("attack");
      if (this.state.inventory.some((i) => i.id === "sword")) {
        actions.push("attack with sword");
      }
    }

    // Use items
    for (const item of this.state.inventory) {
      if (item.usable) {
        actions.push(`use ${item.name.toLowerCase()}`);
      }
    }

    // Always available
    actions.push("look around");
    actions.push("check inventory");

    return actions;
  }

  executeAction(action: string): string {
    this.state.turnsPlayed++;
    const actionLower = action.toLowerCase().trim();

    // Movement
    if (actionLower.startsWith("go ")) {
      return this.handleMove(actionLower.substring(3));
    }

    // Take item
    if (actionLower.startsWith("take ") || actionLower.startsWith("pick up ")) {
      const itemName = actionLower.startsWith("take ")
        ? actionLower.substring(5)
        : actionLower.substring(8);
      return this.handleTake(itemName);
    }

    // Attack
    if (actionLower.startsWith("attack")) {
      const withSword = actionLower.includes("sword");
      return this.handleAttack(withSword);
    }

    // Use item
    if (actionLower.startsWith("use ")) {
      return this.handleUse(actionLower.substring(4));
    }

    // Look around
    if (actionLower === "look around" || actionLower === "look") {
      return this.describeRoom();
    }

    // Check inventory
    if (
      actionLower === "check inventory" ||
      actionLower === "inventory" ||
      actionLower === "i"
    ) {
      return this.describeInventory();
    }

    return `I don't understand "${action}". Try one of the available actions.`;
  }

  private handleMove(direction: string): string {
    const room = this.getCurrentRoom();

    // Check for locked door
    if (
      direction === "north" &&
      room.id === "chamber" &&
      !this.state.inventory.some((i) => i.id === "key")
    ) {
      return "The door to the north is locked. You need a key to proceed.";
    }

    // Check for enemies blocking the path
    if (room.enemy && room.enemy.health > 0 && direction !== "south") {
      return `The ${room.enemy.name} blocks your path! You must defeat it first or retreat south.`;
    }

    if (room.exits[direction]) {
      const nextRoomId = room.exits[direction];

      // Use key if going to throne room
      if (direction === "north" && room.id === "chamber") {
        const keyIndex = this.state.inventory.findIndex((i) => i.id === "key");
        if (keyIndex >= 0) {
          this.state.inventory.splice(keyIndex, 1);
        }
      }

      this.state.currentRoom = nextRoomId;
      const newRoom = this.getCurrentRoom();
      const firstVisit = !newRoom.visited;
      newRoom.visited = true;

      if (firstVisit) {
        this.state.score += 10;
      }

      let result = `You move ${direction}.\n\n${this.describeRoom()}`;

      if (newRoom.enemy && newRoom.enemy.health > 0) {
        result += `\n\n⚔️ DANGER! ${newRoom.enemy.description}`;
      }

      return result;
    }

    return `You cannot go ${direction} from here.`;
  }

  private handleTake(itemName: string): string {
    const room = this.getCurrentRoom();
    const itemIndex = room.items.findIndex((i) =>
      i.name.toLowerCase().includes(itemName.toLowerCase()),
    );

    if (itemIndex >= 0) {
      const item = room.items[itemIndex];
      room.items.splice(itemIndex, 1);
      this.state.inventory.push(item);
      this.state.score += 5;
      return `You pick up the ${item.name}. ${item.description}`;
    }

    return `There is no "${itemName}" here to take.`;
  }

  private handleAttack(withSword: boolean): string {
    const room = this.getCurrentRoom();

    if (!room.enemy || room.enemy.health <= 0) {
      return "There is nothing to attack here.";
    }

    const enemy = room.enemy;
    const playerDamage = withSword ? 35 : 15;
    const weaponText = withSword
      ? "strike with your ancient sword"
      : "punch with your fists";

    enemy.health -= playerDamage;

    let result = `You ${weaponText}, dealing ${playerDamage} damage!`;

    if (enemy.health <= 0) {
      result += `\n\n🎉 ${enemy.defeatedMessage}`;
      this.state.score += 50;

      // Victory condition: defeating the dragon
      if (enemy.name === "Ancient Dragon") {
        this.state.victory = true;
        this.state.gameOver = true;
        this.state.score += 200;
        result +=
          "\n\n🏆 VICTORY! You have conquered the dungeon and claimed the dragon's treasure!";
        result += `\n\nFinal Score: ${this.state.score} points in ${this.state.turnsPlayed} turns.`;
      }
    } else {
      // Enemy counterattacks
      this.state.health -= enemy.damage;
      result += `\nThe ${enemy.name} strikes back for ${enemy.damage} damage!`;
      result += `\nYour health: ${this.state.health}/${this.state.maxHealth} | Enemy health: ${enemy.health}`;

      if (this.state.health <= 0) {
        this.state.gameOver = true;
        result += `\n\n💀 GAME OVER! You have been defeated by the ${enemy.name}.`;
        result += `\n\nFinal Score: ${this.state.score} points in ${this.state.turnsPlayed} turns.`;
      }
    }

    return result;
  }

  private handleUse(itemName: string): string {
    const itemIndex = this.state.inventory.findIndex((i) =>
      i.name.toLowerCase().includes(itemName.toLowerCase()),
    );

    if (itemIndex < 0) {
      return `You don't have "${itemName}" in your inventory.`;
    }

    const item = this.state.inventory[itemIndex];

    switch (item.id) {
      case "potion": {
        const healAmount = Math.min(
          50,
          this.state.maxHealth - this.state.health,
        );
        this.state.health += healAmount;
        this.state.inventory.splice(itemIndex, 1);
        return `You drink the health potion and restore ${healAmount} health! Health: ${this.state.health}/${this.state.maxHealth}`;
      }

      case "torch":
        return "The torch illuminates your surroundings. You can see more clearly now.";

      case "key":
        return "The key looks like it would fit a large lock. Perhaps there's a locked door somewhere.";

      case "sword":
        return "You swing the ancient sword through the air. It feels well-balanced and deadly.";

      default:
        return `You can't use the ${item.name} right now.`;
    }
  }

  describeRoom(): string {
    const room = this.getCurrentRoom();
    let description = `📍 ${room.name}\n\n${room.description}`;

    if (room.items.length > 0) {
      description += `\n\n📦 Items here: ${room.items.map((i) => i.name).join(", ")}`;
    }

    const exits = Object.keys(room.exits);
    description += `\n\n🚪 Exits: ${exits.join(", ")}`;

    if (
      room.id === "chamber" &&
      !this.state.inventory.some((i) => i.id === "key")
    ) {
      description += "\n(The door to the north is locked)";
    }

    return description;
  }

  describeInventory(): string {
    if (this.state.inventory.length === 0) {
      return "🎒 Your inventory is empty.";
    }

    const items = this.state.inventory
      .map((i) => `  - ${i.name}: ${i.description}`)
      .join("\n");
    return `🎒 Inventory:\n${items}\n\n❤️ Health: ${this.state.health}/${this.state.maxHealth} | ⭐ Score: ${this.state.score}`;
  }

  getStatusLine(): string {
    return `❤️ ${this.state.health}/${this.state.maxHealth} | ⭐ ${this.state.score} | 🔄 Turn ${this.state.turnsPlayed}`;
  }
}

// ============================================================================
// AI AGENT INTEGRATION
// ============================================================================

interface AppConfiguration {
  openaiApiKey: string;
  postgresUrl: string;
  pgliteDataDir: string;
}

interface GameSession {
  runtime: AgentRuntime;
  game: AdventureGame;
  roomId: UUID;
  agentId: UUID;
  worldId: UUID;
  gameMasterId: UUID; // The "dungeon master" sending game state messages
}

class Configuration {
  static load(): AppConfiguration {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey || !openaiKey.trim()) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    return {
      openaiApiKey: openaiKey,
      postgresUrl: process.env.POSTGRES_URL || "",
      pgliteDataDir: process.env.PGLITE_DATA_DIR || "memory://",
    };
  }
}

class AdventureAgent {
  private static createCharacter() {
    return createCharacter({
      name: "Eliza the Adventurer",
      username: "eliza_adventurer",
      bio: [
        "A brave AI adventurer exploring dangerous dungeons.",
        "Known for clever problem-solving and careful exploration.",
        "Prefers to be well-prepared before combat.",
      ],
      adjectives: ["brave", "curious", "strategic", "cautious"],
      style: {
        all: [
          "Think carefully about each situation",
          "Consider available options before acting",
          "Prioritize survival and gathering resources",
        ],
        chat: ["Be descriptive about your reasoning"],
      },
    });
  }

  static async initialize(): Promise<GameSession> {
    const task = clack.spinner();

    task.start("Initializing adventure...");

    const config = Configuration.load();
    const character = AdventureAgent.createCharacter();
    const agentId = stringToUuid(character.name);

    task.message("Creating AI adventurer...");
    // The sqlPlugin will handle database setup and migrations automatically
    // actionPlanning: false ensures only one action is executed per turn,
    // which is critical for game scenarios where state changes after each action
    const runtime = new AgentRuntime({
      character,
      plugins: [sqlPlugin, openaiPlugin],
      settings: {
        OPENAI_API_KEY: config.openaiApiKey,
        POSTGRES_URL: config.postgresUrl || undefined,
        PGLITE_DATA_DIR: config.pgliteDataDir,
      },
      actionPlanning: false, // Single action per turn for game state consistency
    });

    await runtime.initialize();

    const game = new AdventureGame();
    const roomId = stringToUuid("adventure-game-room");
    const worldId = stringToUuid("adventure-game-world");
    const gameMasterId = stringToUuid("dungeon-master");

    // Set up proper connection for message handling pipeline
    task.message("Setting up game room...");
    await runtime.ensureConnection({
      entityId: gameMasterId,
      roomId,
      worldId,
      userName: "Dungeon Master",
      source: "adventure-game",
      channelId: "adventure-room",
      serverId: "game-server",
      type: ChannelType.DM,
    } as Parameters<typeof runtime.ensureConnection>[0]);

    task.stop("✅ Adventure ready!");

    return { runtime, game, roomId, agentId, worldId, gameMasterId };
  }

  static async decideAction(session: GameSession): Promise<string> {
    const { runtime, game, roomId, gameMasterId } = session;

    const state = game.getState();
    const room = game.getCurrentRoom();
    const actions = game.getAvailableActions();

    // Build the game state message from the Dungeon Master
    const gameContext = `DUNGEON MASTER UPDATE:

GAME STATE:
- Location: ${room.name}
- Health: ${state.health}/${state.maxHealth}
- Inventory: ${state.inventory.map((i) => i.name).join(", ") || "empty"}
- Score: ${state.score}
- Turn: ${state.turnsPlayed}

CURRENT SCENE:
${game.describeRoom()}

${room.enemy && room.enemy.health > 0 ? `⚠️ ENEMY PRESENT: ${room.enemy.name} (Health: ${room.enemy.health})` : ""}

AVAILABLE ACTIONS:
${actions.map((a, i) => `${i + 1}. ${a}`).join("\n")}

INSTRUCTIONS:
You are playing a text adventure game. Your goal is to explore the dungeon, collect items, defeat enemies, and find the dragon's treasure.

Think strategically:
- Explore to find items and the key before facing the dragon
- Pick up weapons (sword) before combat
- Use health potions when low on health
- The dragon is the final boss - be prepared!

Based on the current situation, choose the best action. Consider:
- If there's an enemy, do you have a weapon? Should you fight or flee?
- Are there useful items to pick up?
- Have you explored all areas?
- Is your health low? Do you have healing items?

Respond with ONLY the exact action text you want to take (e.g., "go north" or "attack with sword").
`;

    // Create a proper message memory from the Dungeon Master
    const message = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: gameMasterId,
      roomId,
      content: { text: gameContext },
    });

    // Use the message service to handle the message through the full pipeline
    // This gives the agent access to recent messages, providers, etc.
    let chosenAction = "look around"; // Default fallback

    if (runtime.messageService) {
      const result = await runtime.messageService.handleMessage(
        runtime,
        message,
        async (content) => {
          if (content.text) {
            chosenAction = content.text.trim();
          }
          return [];
        },
      );

      // If the agent responded, extract the action from the response
      if (result.responseContent?.text) {
        chosenAction = result.responseContent.text.trim();
      }
    }

    // Validate the action is in available actions (case-insensitive match)
    const matchedAction = actions.find(
      (a) => a.toLowerCase() === chosenAction.toLowerCase(),
    );

    if (matchedAction) {
      return matchedAction;
    }

    // Try to find a partial match
    const partialMatch = actions.find(
      (a) =>
        a.toLowerCase().includes(chosenAction.toLowerCase()) ||
        chosenAction.toLowerCase().includes(a.toLowerCase()),
    );

    if (partialMatch) {
      return partialMatch;
    }

    // Default to looking around if no valid action found
    return "look around";
  }

  /**
   * Save a game result message so the agent can see the outcome
   */
  static async saveGameResult(
    session: GameSession,
    result: string,
  ): Promise<void> {
    const { runtime, roomId, gameMasterId } = session;

    const resultMessage = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: gameMasterId,
      roomId,
      content: { text: `GAME RESULT: ${result}` },
    });

    // Save to memory so it appears in conversation history
    await runtime.createMemory(resultMessage, "messages");
  }
}

// ============================================================================
// GAME DISPLAY
// ============================================================================

class GameDisplay {
  static showIntro(): void {
    clack.intro("🏰 elizaOS Adventure Game Demo");
    console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                   THE DUNGEON OF DOOM                              ║
╠════════════════════════════════════════════════════════════════════╣
║  Watch as Eliza the AI Adventurer explores a dangerous dungeon!    ║
║                                                                    ║
║  The AI will:                                                      ║
║  • Explore rooms and collect items                                 ║
║  • Fight monsters using strategic decisions                        ║
║  • Manage health and inventory                                     ║
║  • Seek the dragon's treasure!                                     ║
║                                                                    ║
║  Database: PGLite (embedded, serverless) via @elizaos/plugin-sql   ║
║  AI: OpenAI via @elizaos/plugin-openai                             ║
╚════════════════════════════════════════════════════════════════════╝
`);
  }

  static showTurn(turnNumber: number, action: string): void {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`🎮 TURN ${turnNumber}`);
    console.log(`${"─".repeat(60)}`);
    console.log(`🤖 Eliza decides: "${action}"`);
    console.log(`${"─".repeat(60)}`);
  }

  static showResult(result: string, status: string): void {
    console.log(result);
    console.log(`\n${status}`);
  }

  static showGameOver(victory: boolean, score: number, turns: number): void {
    console.log(`\n${"═".repeat(60)}`);
    if (victory) {
      console.log("🏆 VICTORY! Eliza has conquered the dungeon!");
    } else {
      console.log("💀 GAME OVER! Eliza has fallen...");
    }
    console.log(`Final Score: ${score} points in ${turns} turns`);
    console.log(`${"═".repeat(60)}\n`);
  }
}

// ============================================================================
// MAIN GAME LOOP
// ============================================================================

async function runAdventureGame(): Promise<void> {
  GameDisplay.showIntro();

  const session = await AdventureAgent.initialize();
  const { game } = session;

  // Show initial room
  console.log("\n📜 The adventure begins...\n");
  const initialDescription = game.describeRoom();
  console.log(initialDescription);

  // Save initial room description as a message so agent has context
  await AdventureAgent.saveGameResult(session, initialDescription);

  const delayMs = 2000; // Delay between turns for readability

  while (!game.getState().gameOver) {
    // Get AI's decision
    const action = await AdventureAgent.decideAction(session);

    // Display and execute the action
    GameDisplay.showTurn(game.getState().turnsPlayed + 1, action);

    const result = game.executeAction(action);
    GameDisplay.showResult(result, game.getStatusLine());

    // Save the game result as a message so the agent can learn from outcomes
    await AdventureAgent.saveGameResult(session, result);

    // Small delay for readability
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    // Safety limit
    if (game.getState().turnsPlayed > 100) {
      console.log("\n⏰ Game exceeded 100 turns. Ending...");
      break;
    }
  }

  const finalState = game.getState();
  GameDisplay.showGameOver(
    finalState.victory,
    finalState.score,
    finalState.turnsPlayed,
  );

  await session.runtime.stop();
  clack.outro("Thanks for watching! 🎮");
}

// ============================================================================
// INTERACTIVE MODE (User guides the AI)
// ============================================================================

async function runInteractiveMode(): Promise<void> {
  GameDisplay.showIntro();

  const session = await AdventureAgent.initialize();
  const { game } = session;

  console.log("\n📜 INTERACTIVE MODE: Guide Eliza through the dungeon!\n");
  console.log(
    "You can type actions yourself, or type 'ai' to let Eliza decide.\n",
  );
  const initialDescription = game.describeRoom();
  console.log(initialDescription);

  // Save initial room description as a message
  await AdventureAgent.saveGameResult(session, initialDescription);

  while (!game.getState().gameOver) {
    console.log(`\n${game.getStatusLine()}`);
    console.log("Available actions:", game.getAvailableActions().join(", "));

    const input = await clack.text({
      message: "Your command (or 'ai' for AI choice, 'quit' to exit):",
      placeholder: "go north",
    });

    if (clack.isCancel(input) || input === "quit" || input === "exit") {
      break;
    }

    let action: string;
    if (input === "ai") {
      const spinner = clack.spinner();
      spinner.start("Eliza is thinking...");
      action = await AdventureAgent.decideAction(session);
      spinner.stop(`Eliza chooses: "${action}"`);
    } else {
      action = input;
    }

    const result = game.executeAction(action);
    console.log(`\n${result}`);

    // Save game result as message so agent can learn from outcomes
    await AdventureAgent.saveGameResult(session, result);
  }

  const finalState = game.getState();
  if (finalState.gameOver) {
    GameDisplay.showGameOver(
      finalState.victory,
      finalState.score,
      finalState.turnsPlayed,
    );
  }

  await session.runtime.stop();
  clack.outro("Thanks for playing! 🎮");
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
  const mode = await clack.select({
    message: "Choose game mode:",
    options: [
      {
        value: "auto",
        label: "Watch AI Play",
        hint: "Eliza plays automatically",
      },
      {
        value: "interactive",
        label: "Interactive",
        hint: "Guide Eliza or play yourself",
      },
    ],
  });

  if (clack.isCancel(mode)) {
    clack.outro("Goodbye! 👋");
    return;
  }

  if (mode === "auto") {
    await runAdventureGame();
  } else {
    await runInteractiveMode();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
