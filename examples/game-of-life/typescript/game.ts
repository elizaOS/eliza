/**
 * elizaOS Agentic Game of Life
 *
 * Each entity is a REAL elizaOS AgentRuntime with:
 * - Its own character (DNA encoded in character settings)
 * - Custom actions: MOVE_TO_FOOD, FLEE, ATTACK, EAT, REPRODUCE
 * - Rule-based model handlers (no LLM)
 * - In-memory database adapter
 *
 * Usage:
 *   bun run examples/game-of-life/typescript/game.ts
 *   bun run examples/game-of-life/typescript/game.ts --fast
 *   bun run examples/game-of-life/typescript/game.ts --agents 20
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || "fatal";

import { randomUUID } from "node:crypto";
import {
  type Action,
  type ActionResult,
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Plugin,
  type State,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
// Import the in-memory database adapter directly from plugin source (bun handles .ts)
import { InMemoryDatabaseAdapter } from "../../../plugins/plugin-inmemorydb/typescript/adapter";
import { MemoryStorage } from "../../../plugins/plugin-inmemorydb/typescript/storage-memory";

// Disable the full bootstrap plugin - we'll use our own minimal version
process.env.IGNORE_BOOTSTRAP = "true";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  WORLD_WIDTH: 30,
  WORLD_HEIGHT: 20,
  INITIAL_AGENTS: 25,
  MAX_AGENTS: 60,
  STARTING_ENERGY: 100,
  MAX_ENERGY: 200,
  REPRODUCTION_THRESHOLD: 150,
  REPRODUCTION_COST: 60,
  MOVE_COST: 2,
  FOOD_ENERGY: 35,
  FOOD_SPAWN_RATE: 0.03,
  MAX_FOOD: 80,
  ATTACK_DAMAGE: 25,
  ATTACK_STEAL: 15,
  TICK_DELAY_MS: 200,
  MAX_TICKS: 300,
  MUTATION_RATE: 0.25,
};

// ============================================================================
// TYPES
// ============================================================================

interface Position {
  x: number;
  y: number;
}

interface DNA {
  speed: number; // 1-3
  vision: number; // 2-6
  aggression: number; // 0-1
  efficiency: number; // 0.5-1.5 (lower = better)
  hue: number; // 0-360
}

interface AgentState {
  id: string;
  position: Position;
  energy: number;
  dna: DNA;
  age: number;
  generation: number;
  isAlive: boolean;
}

interface WorldState {
  tick: number;
  width: number;
  height: number;
  food: Map<string, Position>;
  agents: Map<string, AgentState>;
}

// Global world state shared by all agents
let world: WorldState;

// Shared storage for all agents
const sharedStorage = new MemoryStorage();

// Shared simulation room/world + environment entity (the "world" speaks to agents)
const SIM_ROOM_ID = stringToUuid("game-of-life");
const SIM_WORLD_ID = stringToUuid("game-of-life-world");
const ENV_ENTITY_ID = stringToUuid("game-of-life-environment");

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function posKey(x: number, y: number): string {
  return `${x},${y}`;
}

function wrapCoord(v: number, max: number): number {
  return ((v % max) + max) % max;
}

function distance(p1: Position, p2: Position): number {
  const dx = Math.min(
    Math.abs(p1.x - p2.x),
    CONFIG.WORLD_WIDTH - Math.abs(p1.x - p2.x),
  );
  const dy = Math.min(
    Math.abs(p1.y - p2.y),
    CONFIG.WORLD_HEIGHT - Math.abs(p1.y - p2.y),
  );
  return Math.sqrt(dx * dx + dy * dy);
}

function getAgentState(runtime: IAgentRuntime): AgentState | null {
  const id = runtime.agentId;
  return world.agents.get(id) || null;
}

function randomDNA(): DNA {
  return {
    speed: Math.floor(Math.random() * 3) + 1,
    vision: Math.floor(Math.random() * 5) + 2,
    aggression: Math.random(),
    efficiency: 0.5 + Math.random(),
    hue: Math.floor(Math.random() * 360),
  };
}

function mutateDNA(parent: DNA): DNA {
  const mutate = (v: number, min: number, max: number) => {
    if (Math.random() < CONFIG.MUTATION_RATE) {
      return Math.max(
        min,
        Math.min(max, v + (Math.random() - 0.5) * (max - min) * 0.4),
      );
    }
    return v;
  };
  return {
    speed: Math.round(mutate(parent.speed, 1, 3)),
    vision: Math.round(mutate(parent.vision, 2, 6)),
    aggression: mutate(parent.aggression, 0, 1),
    efficiency: mutate(parent.efficiency, 0.5, 1.5),
    hue:
      (parent.hue +
        (Math.random() < CONFIG.MUTATION_RATE
          ? Math.floor(Math.random() * 40) - 20
          : 0) +
        360) %
      360,
  };
}

// ============================================================================
// ACTIONS
// ============================================================================

const moveTowardFoodAction: Action = {
  name: "MOVE_TOWARD_FOOD",
  description: "Move toward the nearest visible food",
  similes: ["SEEK_FOOD", "HUNT_FOOD", "FORAGE"],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const state = getAgentState(runtime);
    if (!state || !state.isAlive) return false;

    // Find nearest food within vision
    for (const food of world.food.values()) {
      if (distance(state.position, food) <= state.dna.vision) {
        return true;
      }
    }
    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const agentState = getAgentState(runtime);
    if (!agentState) return { success: false };

    // Find nearest food
    let nearest: Position | null = null;
    let nearestDist = Infinity;
    for (const food of world.food.values()) {
      const d = distance(agentState.position, food);
      if (d <= agentState.dna.vision && d < nearestDist) {
        nearestDist = d;
        nearest = food;
      }
    }

    if (nearest) {
      // Move toward food
      let dx = nearest.x - agentState.position.x;
      let dy = nearest.y - agentState.position.y;

      // Handle wraparound
      if (Math.abs(dx) > CONFIG.WORLD_WIDTH / 2) dx = -Math.sign(dx);
      if (Math.abs(dy) > CONFIG.WORLD_HEIGHT / 2) dy = -Math.sign(dy);

      const move = Math.min(agentState.dna.speed, Math.ceil(nearestDist));
      agentState.position.x = wrapCoord(
        agentState.position.x + Math.sign(dx) * move,
        CONFIG.WORLD_WIDTH,
      );
      agentState.position.y = wrapCoord(
        agentState.position.y + Math.sign(dy) * move,
        CONFIG.WORLD_HEIGHT,
      );
      agentState.energy -= CONFIG.MOVE_COST * agentState.dna.efficiency;

      if (callback) {
        callback({
          text: `Moving toward food at ${nearest.x},${nearest.y}`,
          action: "MOVE_TOWARD_FOOD",
        });
      }
    }
    return { success: true };
  },

  examples: [],
};

const eatAction: Action = {
  name: "EAT",
  description: "Eat food at current position",
  similes: ["CONSUME", "FEED"],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const state = getAgentState(runtime);
    if (!state || !state.isAlive) return false;
    return world.food.has(posKey(state.position.x, state.position.y));
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const agentState = getAgentState(runtime);
    if (!agentState) return { success: false };

    const key = posKey(agentState.position.x, agentState.position.y);
    if (world.food.has(key)) {
      world.food.delete(key);
      agentState.energy = Math.min(
        CONFIG.MAX_ENERGY,
        agentState.energy + CONFIG.FOOD_ENERGY,
      );
      if (callback) {
        callback({
          text: `Ate food, energy now ${Math.round(agentState.energy)}`,
          action: "EAT",
        });
      }
    }
    return { success: true };
  },

  examples: [],
};

const fleeAction: Action = {
  name: "FLEE",
  description: "Run away from nearby aggressive agents",
  similes: ["RUN", "ESCAPE", "EVADE"],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const state = getAgentState(runtime);
    if (!state || !state.isAlive) return false;
    if (state.dna.aggression > 0.6) return false; // Aggressive agents don't flee

    // Check for nearby threats
    for (const other of world.agents.values()) {
      if (other.id === state.id || !other.isAlive) continue;
      if (
        other.dna.aggression > 0.5 &&
        distance(state.position, other.position) <= state.dna.vision
      ) {
        return true;
      }
    }
    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const agentState = getAgentState(runtime);
    if (!agentState) return { success: false };

    // Find nearest threat and run opposite direction
    let threat: AgentState | null = null;
    let minDist = Infinity;
    for (const other of world.agents.values()) {
      if (other.id === agentState.id || !other.isAlive) continue;
      const d = distance(agentState.position, other.position);
      if (
        other.dna.aggression > 0.5 &&
        d <= agentState.dna.vision &&
        d < minDist
      ) {
        minDist = d;
        threat = other;
      }
    }

    if (threat) {
      let dx = agentState.position.x - threat.position.x;
      let dy = agentState.position.y - threat.position.y;
      if (Math.abs(dx) > CONFIG.WORLD_WIDTH / 2) dx = -Math.sign(dx);
      if (Math.abs(dy) > CONFIG.WORLD_HEIGHT / 2) dy = -Math.sign(dy);

      const move = agentState.dna.speed;
      agentState.position.x = wrapCoord(
        agentState.position.x + Math.sign(dx) * move,
        CONFIG.WORLD_WIDTH,
      );
      agentState.position.y = wrapCoord(
        agentState.position.y + Math.sign(dy) * move,
        CONFIG.WORLD_HEIGHT,
      );
      agentState.energy -= CONFIG.MOVE_COST * agentState.dna.efficiency * 1.5; // Fleeing costs more

      if (callback) {
        callback({ text: `Fleeing from threat!`, action: "FLEE" });
      }
    }
    return { success: true };
  },

  examples: [],
};

const attackAction: Action = {
  name: "ATTACK",
  description: "Attack a nearby weaker agent to steal energy",
  similes: ["FIGHT", "HUNT_PREY", "ASSAULT"],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const state = getAgentState(runtime);
    if (!state || !state.isAlive) return false;
    if (state.dna.aggression < 0.5) return false; // Only aggressive agents attack

    // Look for weaker prey nearby
    for (const other of world.agents.values()) {
      if (other.id === state.id || !other.isAlive) continue;
      if (
        distance(state.position, other.position) <= 2 &&
        other.energy < state.energy * 0.9
      ) {
        return true;
      }
    }
    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const agentState = getAgentState(runtime);
    if (!agentState) return { success: false };

    // Find weakest nearby prey
    let prey: AgentState | null = null;
    let minEnergy = Infinity;
    for (const other of world.agents.values()) {
      if (other.id === agentState.id || !other.isAlive) continue;
      if (
        distance(agentState.position, other.position) <= 2 &&
        other.energy < minEnergy
      ) {
        minEnergy = other.energy;
        prey = other;
      }
    }

    if (prey) {
      // Move to prey position
      agentState.position.x = prey.position.x;
      agentState.position.y = prey.position.y;

      // Attack!
      const damage = CONFIG.ATTACK_DAMAGE * agentState.dna.aggression;
      const steal = Math.min(prey.energy, CONFIG.ATTACK_STEAL);
      prey.energy -= damage;
      agentState.energy = Math.min(
        CONFIG.MAX_ENERGY,
        agentState.energy + steal,
      );

      if (prey.energy <= 0) {
        prey.isAlive = false;
      }

      if (callback) {
        callback({
          text: `Attacked ${prey.id.slice(0, 6)}, stole ${Math.round(steal)} energy!`,
          action: "ATTACK",
        });
      }
    }
    return { success: true };
  },

  examples: [],
};

const reproduceAction: Action = {
  name: "REPRODUCE",
  description: "Create offspring when energy is high enough",
  similes: ["SPAWN", "BREED", "REPLICATE"],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const state = getAgentState(runtime);
    if (!state || !state.isAlive) return false;
    return (
      state.energy >= CONFIG.REPRODUCTION_THRESHOLD &&
      world.agents.size < CONFIG.MAX_AGENTS
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const agentState = getAgentState(runtime);
    if (!agentState) return { success: false };

    agentState.energy -= CONFIG.REPRODUCTION_COST;

    // Create child with mutated DNA
    const childId = randomUUID() as UUID;
    const childDNA = mutateDNA(agentState.dna);
    const childState: AgentState = {
      id: childId,
      position: {
        x: wrapCoord(
          agentState.position.x + Math.floor(Math.random() * 3) - 1,
          CONFIG.WORLD_WIDTH,
        ),
        y: wrapCoord(
          agentState.position.y + Math.floor(Math.random() * 3) - 1,
          CONFIG.WORLD_HEIGHT,
        ),
      },
      energy: CONFIG.REPRODUCTION_COST * 0.7,
      dna: childDNA,
      age: 0,
      generation: agentState.generation + 1,
      isAlive: true,
    };

    world.agents.set(childId, childState);

    // Create a new runtime for the child (will be done in main loop)
    pendingBirths.push(childState);

    if (callback) {
      callback({
        text: `Reproduced! Child ${childId.slice(0, 6)} born (gen ${childState.generation})`,
        action: "REPRODUCE",
      });
    }
    return { success: true };
  },

  examples: [],
};

const wanderAction: Action = {
  name: "WANDER",
  description: "Move in a random direction when nothing else to do",
  similes: ["EXPLORE", "ROAM", "MOVE_RANDOM"],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const state = getAgentState(runtime);
    return state?.isAlive ?? false;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const agentState = getAgentState(runtime);
    if (!agentState) return { success: false };

    const dx = Math.floor(Math.random() * 3) - 1;
    const dy = Math.floor(Math.random() * 3) - 1;
    const move = Math.ceil(agentState.dna.speed * 0.5);

    agentState.position.x = wrapCoord(
      agentState.position.x + dx * move,
      CONFIG.WORLD_WIDTH,
    );
    agentState.position.y = wrapCoord(
      agentState.position.y + dy * move,
      CONFIG.WORLD_HEIGHT,
    );
    agentState.energy -= CONFIG.MOVE_COST * agentState.dna.efficiency * 0.5;

    return { success: true };
  },

  examples: [],
};

// Pending births to create new runtimes
const pendingBirths: AgentState[] = [];

// ============================================================================
// MODEL HANDLER - DECIDES WHICH ACTION TO TAKE
// ============================================================================

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decisionXml(actionName: string, thought: string, text: string): string {
  // DefaultMessageService expects XML-ish tags like <thought>, <actions>, <text>.
  // We return a minimal, deterministic payload (no LLM) that still flows through
  // the full Eliza message pipeline.
  return [
    "<thought>",
    escapeXml(thought),
    "</thought>",
    "<actions>",
    escapeXml(actionName),
    "</actions>",
    "<text>",
    escapeXml(text),
    "</text>",
  ].join("");
}

type DecisionModelParams = { prompt?: string };

async function decisionModelHandler(
  runtime: IAgentRuntime,
  params: DecisionModelParams,
): Promise<string> {
  const state = getAgentState(runtime);
  if (!state || !state.isAlive) {
    return decisionXml("NONE", "I am not alive; no action.", "NONE");
  }

  // Priority-based action selection (no LLM, pure rules)

  // 1. If standing on food, eat it
  if (world.food.has(posKey(state.position.x, state.position.y))) {
    return decisionXml(
      "EAT",
      "Food is underfoot; eating is the highest value action.",
      "EAT",
    );
  }

  // 2. If can reproduce and safe, do it
  if (
    state.energy >= CONFIG.REPRODUCTION_THRESHOLD &&
    world.agents.size < CONFIG.MAX_AGENTS
  ) {
    // Check if it's safe (no nearby threats)
    let safe = true;
    for (const other of world.agents.values()) {
      if (
        other.id !== state.id &&
        other.isAlive &&
        other.dna.aggression > 0.6
      ) {
        if (distance(state.position, other.position) <= 3) {
          safe = false;
          break;
        }
      }
    }
    if (safe) {
      return decisionXml(
        "REPRODUCE",
        "Energy is high and conditions look safe; reproducing increases lineage fitness.",
        "REPRODUCE",
      );
    }
  }

  // 3. If low aggression and threat nearby, flee
  if (state.dna.aggression < 0.5) {
    for (const other of world.agents.values()) {
      if (
        other.id !== state.id &&
        other.isAlive &&
        other.dna.aggression > 0.5
      ) {
        if (distance(state.position, other.position) <= state.dna.vision) {
          return decisionXml(
            "FLEE",
            "A nearby aggressive agent is within vision; fleeing reduces risk.",
            "FLEE",
          );
        }
      }
    }
  }

  // 4. If aggressive and see weak prey, attack
  if (state.dna.aggression > 0.5) {
    for (const other of world.agents.values()) {
      if (
        other.id !== state.id &&
        other.isAlive &&
        other.energy < state.energy * 0.8
      ) {
        if (distance(state.position, other.position) <= 2) {
          return decisionXml(
            "ATTACK",
            "A weaker agent is within striking range; attacking can steal energy.",
            "ATTACK",
          );
        }
      }
    }
  }

  // 5. If see food, move toward it
  for (const food of world.food.values()) {
    if (distance(state.position, food) <= state.dna.vision) {
      return decisionXml(
        "MOVE_TOWARD_FOOD",
        "Visible food detected; moving toward it improves survival odds.",
        "MOVE_TOWARD_FOOD",
      );
    }
  }

  // 6. Default: wander
  // Include a tiny prompt preview so it’s obvious the agent received environment input
  // via the message pipeline (not bypassed).
  const promptPreview = params.prompt
    ? params.prompt.trim().slice(0, 120)
    : "(no prompt)";
  return decisionXml(
    "WANDER",
    `No immediate opportunities; wandering explores. envPreview=${promptPreview}`,
    "WANDER",
  );
}

// ============================================================================
// GAME OF LIFE PLUGIN
// ============================================================================

const gameOfLifePlugin: Plugin = {
  name: "game-of-life-agent",
  description: "Actions for Game of Life agents",

  actions: [
    moveTowardFoodAction,
    eatAction,
    fleeAction,
    attackAction,
    reproduceAction,
    wanderAction,
  ],

  models: {
    [ModelType.TEXT_SMALL]: decisionModelHandler,
    [ModelType.TEXT_LARGE]: decisionModelHandler,
  },
};

// ============================================================================
// AGENT RUNTIME FACTORY
// ============================================================================

interface LiveAgent {
  runtime: AgentRuntime;
  state: AgentState;
}

async function createAgentRuntime(agentState: AgentState): Promise<LiveAgent> {
  const character = createCharacter({
    id: agentState.id as UUID,
    name: `Agent-${agentState.id.slice(0, 6)}`,
    bio: [
      `Generation ${agentState.generation} agent with ${Math.round(agentState.dna.aggression * 100)}% aggression`,
    ],
    settings: {
      DNA_SPEED: agentState.dna.speed,
      DNA_VISION: agentState.dna.vision,
      DNA_AGGRESSION: agentState.dna.aggression,
      DNA_EFFICIENCY: agentState.dna.efficiency,
      DNA_HUE: agentState.dna.hue,
    },
  });

  // Create the adapter using the shared storage
  const adapter = new InMemoryDatabaseAdapter(
    sharedStorage,
    agentState.id as UUID,
  );
  await adapter.init();

  // Pre-create the agent and entity records
  await adapter.createAgent({
    id: agentState.id as UUID,
    name: character.name,
    enabled: true,
  });

  // Pre-create the entity that the runtime will look for
  await adapter.createEntities([
    {
      id: agentState.id as UUID,
      names: [character.name || "Agent"],
      agentId: agentState.id as UUID,
      metadata: {},
    },
  ]);

  const runtime = new AgentRuntime({
    character,
    agentId: agentState.id as UUID,
    plugins: [gameOfLifePlugin],
    adapter,
  });

  await runtime.initialize({ skipMigrations: true });

  // Ensure the simulation "environment" entity is connected to the same room as the agent.
  // This makes each tick a real inbound message processed via messageService.handleMessage().
  await runtime.ensureConnection({
    entityId: ENV_ENTITY_ID,
    roomId: SIM_ROOM_ID,
    worldId: SIM_WORLD_ID,
    userName: "Environment",
    source: "simulation",
    channelId: "game-of-life",
    type: ChannelType.DM,
  });

  return { runtime, state: agentState };
}

// ============================================================================
// WORLD MANAGEMENT
// ============================================================================

function initializeWorld(): void {
  world = {
    tick: 0,
    width: CONFIG.WORLD_WIDTH,
    height: CONFIG.WORLD_HEIGHT,
    food: new Map(),
    agents: new Map(),
  };

  // Spawn initial food
  for (let i = 0; i < CONFIG.MAX_FOOD / 2; i++) {
    const x = Math.floor(Math.random() * CONFIG.WORLD_WIDTH);
    const y = Math.floor(Math.random() * CONFIG.WORLD_HEIGHT);
    world.food.set(posKey(x, y), { x, y });
  }
}

function spawnFood(): void {
  if (world.food.size >= CONFIG.MAX_FOOD) return;

  const spawns = Math.floor(
    CONFIG.WORLD_WIDTH * CONFIG.WORLD_HEIGHT * CONFIG.FOOD_SPAWN_RATE,
  );
  for (let i = 0; i < spawns; i++) {
    const x = Math.floor(Math.random() * CONFIG.WORLD_WIDTH);
    const y = Math.floor(Math.random() * CONFIG.WORLD_HEIGHT);
    const key = posKey(x, y);
    if (!world.food.has(key)) {
      world.food.set(key, { x, y });
    }
  }
}

// ============================================================================
// VISUALIZATION
// ============================================================================

function hslToAnsi(h: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * 0.8;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  r = Math.round((r + m) * 5);
  g = Math.round((g + m) * 5);
  b = Math.round((b + m) * 5);

  return 16 + 36 * r + 6 * g + b;
}

function render(): string {
  const grid: string[][] = [];

  for (let y = 0; y < CONFIG.WORLD_HEIGHT; y++) {
    grid[y] = [];
    for (let x = 0; x < CONFIG.WORLD_WIDTH; x++) {
      grid[y][x] = "\x1b[48;5;236m  \x1b[0m";
    }
  }

  // Draw food
  for (const food of world.food.values()) {
    grid[food.y][food.x] = "\x1b[38;5;40m🌱\x1b[0m";
  }

  // Draw agents
  for (const agent of world.agents.values()) {
    if (!agent.isAlive) continue;
    const light = 0.35 + (agent.energy / CONFIG.MAX_ENERGY) * 0.35;
    const color = hslToAnsi(agent.dna.hue, light);

    let sym = "●";
    if (agent.dna.aggression > 0.7) sym = "◆";
    else if (agent.dna.speed >= 3) sym = "▲";
    else if (agent.dna.vision >= 5) sym = "◉";

    grid[agent.position.y][agent.position.x] =
      `\x1b[38;5;${color}m${sym} \x1b[0m`;
  }

  let out = "\x1b[2J\x1b[H";
  out += `╔${"══".repeat(CONFIG.WORLD_WIDTH)}╗\n`;
  for (let y = 0; y < CONFIG.WORLD_HEIGHT; y++) {
    out += `║${grid[y].join("")}║\n`;
  }
  out += `╚${"══".repeat(CONFIG.WORLD_WIDTH)}╝\n`;

  const alive = [...world.agents.values()].filter((a) => a.isAlive);
  const avgEnergy =
    alive.length > 0
      ? Math.round(alive.reduce((s, a) => s + a.energy, 0) / alive.length)
      : 0;
  const avgGen =
    alive.length > 0
      ? (alive.reduce((s, a) => s + a.generation, 0) / alive.length).toFixed(1)
      : "0";
  const avgAgg =
    alive.length > 0
      ? Math.round(
          (alive.reduce((s, a) => s + a.dna.aggression, 0) / alive.length) *
            100,
        )
      : 0;

  out += `\n  Tick: ${world.tick}  |  Agents: ${alive.length}  |  Food: ${world.food.size}  |  Avg Energy: ${avgEnergy}\n`;
  out += `  Avg Generation: ${avgGen}  |  Avg Aggression: ${avgAgg}%\n`;
  out += "\n  ● Normal  ◆ Aggressive  ▲ Fast  ◉ Sharp Vision  🌱 Food\n";
  out += "  Each agent is a real elizaOS AgentRuntime!\n";

  return out;
}

// ============================================================================
// MAIN SIMULATION
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fast = args.includes("--fast");
  const stats = args.includes("--stats");
  const agentCountArg = args.find((a) => a.startsWith("--agents="));
  const agentCount = agentCountArg
    ? parseInt(agentCountArg.split("=")[1], 10)
    : CONFIG.INITIAL_AGENTS;

  console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║                     ELIZAOS AGENTIC GAME OF LIFE                       ║
╠════════════════════════════════════════════════════════════════════════╣
║  Each entity is a REAL elizaOS AgentRuntime with:                      ║
║  • Its own Character (DNA encoded in settings)                         ║
║  • Actions: MOVE_TO_FOOD, FLEE, ATTACK, EAT, REPRODUCE, WANDER         ║
║  • Rule-based model handlers (no LLM)                                  ║
║  • In-memory database adapter                                          ║
║                                                                        ║
║  Creating ${agentCount} agent runtimes...                                        ║
╚════════════════════════════════════════════════════════════════════════╝
`);

  // Initialize world
  initializeWorld();

  // Create initial agent runtimes
  const liveAgents: Map<string, LiveAgent> = new Map();

  console.log("  Spawning agents...");
  for (let i = 0; i < agentCount; i++) {
    const id = randomUUID() as UUID;
    const agentState: AgentState = {
      id,
      position: {
        x: Math.floor(Math.random() * CONFIG.WORLD_WIDTH),
        y: Math.floor(Math.random() * CONFIG.WORLD_HEIGHT),
      },
      energy: CONFIG.STARTING_ENERGY,
      dna: randomDNA(),
      age: 0,
      generation: 0,
      isAlive: true,
    };
    world.agents.set(id, agentState);

    const liveAgent = await createAgentRuntime(agentState);
    liveAgents.set(id, liveAgent);
    process.stdout.write(`\r  Created agent ${i + 1}/${agentCount}`);
  }
  console.log("\n  All agents ready!\n");

  await new Promise((r) => setTimeout(r, 1000));

  const tickDelay = fast ? CONFIG.TICK_DELAY_MS / 5 : CONFIG.TICK_DELAY_MS;

  // Main loop
  while (world.tick < CONFIG.MAX_TICKS) {
    world.tick++;

    // Process each live agent
    for (const [id, liveAgent] of liveAgents) {
      const state = world.agents.get(id);
      if (!state || !state.isAlive) continue;

      // Send a real "environment tick" message through the full Eliza pipeline.
      // This MUST go through runtime.messageService.handleMessage (no bypassing).
      const envText = [
        `TICK=${world.tick}`,
        `AGENT_ID=${state.id}`,
        `POS=${state.position.x},${state.position.y}`,
        `ENERGY=${Math.round(state.energy)}`,
        `DNA_SPEED=${state.dna.speed}`,
        `DNA_VISION=${state.dna.vision}`,
        `DNA_AGGRESSION=${state.dna.aggression.toFixed(3)}`,
        `FOOD_COUNT=${world.food.size}`,
      ].join("\n");

      const message = createMessageMemory({
        id: randomUUID() as UUID,
        entityId: ENV_ENTITY_ID,
        roomId: SIM_ROOM_ID,
        content: {
          text: envText,
          source: "simulation",
          channelType: ChannelType.DM,
        },
      });

      if (liveAgent.runtime.messageService) {
        const result = await liveAgent.runtime.messageService.handleMessage(
          liveAgent.runtime,
          message,
          async () => [],
        );

        if (stats && message.id) {
          const decisionActions = result.responseContent?.actions ?? [];
          const decisionThought = result.responseContent?.thought ?? "";
          const executed = liveAgent.runtime.getActionResults(message.id);
          const executedNames = executed
            .map((r) => r.data?.actionName)
            .filter((n): n is string => typeof n === "string");

          // Keep output compact: only print when something executed or every ~25 ticks.
          if (executedNames.length > 0 && (world.tick % 25 === 0 || world.tick <= 5)) {
            console.log(
              `tick=${world.tick} agent=${id.slice(0, 6)} decision=${decisionActions.join(",")} executed=${executedNames.join(",")} thought=${decisionThought.slice(0, 80)}`,
            );
          }
        }
      }

      // Age and energy decay
      state.age++;
      state.energy -= 0.5 * state.dna.efficiency;

      // Check death
      if (state.energy <= 0) {
        state.isAlive = false;
      }
    }

    // Process births - create new runtimes for children
    while (pendingBirths.length > 0) {
      const childState = pendingBirths.shift()!;
      const liveAgent = await createAgentRuntime(childState);
      liveAgents.set(childState.id, liveAgent);
    }

    // Remove dead agents' runtimes
    for (const [id, state] of world.agents) {
      if (!state.isAlive) {
        const liveAgent = liveAgents.get(id);
        if (liveAgent) {
          await liveAgent.runtime.stop();
          liveAgents.delete(id);
        }
        world.agents.delete(id);
      }
    }

    // Spawn food
    spawnFood();

    // Render
    console.log(render());

    // Check extinction
    if (world.agents.size === 0) {
      console.log("\n💀 EXTINCTION - All agents have perished!\n");
      break;
    }

    await new Promise((r) => setTimeout(r, tickDelay));
  }

  // Cleanup
  console.log("\n  Shutting down agent runtimes...");
  for (const [, liveAgent] of liveAgents) {
    await liveAgent.runtime.stop();
  }

  console.log(`
════════════════════════════════════════════════════════════════════════
  Simulation complete!
  Final tick: ${world.tick}
  Surviving agents: ${world.agents.size}
  Each was a real elizaOS AgentRuntime with actions & model handlers!
════════════════════════════════════════════════════════════════════════
`);
}

if (import.meta.main) {
  main().catch(console.error);
}
