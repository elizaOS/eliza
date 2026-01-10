/**
 * elizaOS Agentic Game of Life
 *
 * A multi-agent simulation where 40+ autonomous agents live on a grid world.
 * Agents have DNA (traits), consume energy, hunt for food, reproduce, and evolve.
 * 
 * Features:
 * - 40x40 grid world with wraparound edges (torus topology)
 * - 40+ agents with unique DNA (speed, vision, aggression, metabolism)
 * - Self-replication when energy threshold is met
 * - Mutation during reproduction = evolution over generations
 * - Food spawns randomly, creating ecosystems
 * - No LLM needed - pure algorithmic decision making via custom model handlers
 *
 * Usage:
 *   bun run examples/game-of-life/typescript/game.ts
 *   bun run examples/game-of-life/typescript/game.ts --fast    # 10x speed
 *   bun run examples/game-of-life/typescript/game.ts --stats   # Show statistics
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || "fatal";

import * as clack from "@clack/prompts";
import {
  AgentRuntime,
  bootstrapPlugin,
  type Plugin,
  type IAgentRuntime,
  ModelType,
} from "@elizaos/core";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // World settings
  WORLD_WIDTH: 40,
  WORLD_HEIGHT: 25,
  
  // Population settings
  INITIAL_AGENTS: 40,
  MAX_AGENTS: 100,
  
  // Energy settings
  STARTING_ENERGY: 100,
  MAX_ENERGY: 200,
  REPRODUCTION_THRESHOLD: 150,
  REPRODUCTION_COST: 60,
  MOVE_COST: 1,
  IDLE_COST: 0.5,
  
  // Food settings
  FOOD_SPAWN_RATE: 0.02, // Probability per empty cell per tick
  FOOD_ENERGY: 30,
  MAX_FOOD_DENSITY: 0.15, // Max % of cells with food
  
  // Mutation settings
  MUTATION_RATE: 0.2,
  MUTATION_MAGNITUDE: 0.3,
  
  // Display settings
  TICK_DELAY_MS: 150,
  MAX_GENERATIONS: 500,
};

// ============================================================================
// TYPES
// ============================================================================

interface DNA {
  speed: number;      // 1-3: How many cells can move per turn
  vision: number;     // 1-5: How far can see
  aggression: number; // 0-1: Fight vs flee tendency
  metabolism: number; // 0.5-2: Energy efficiency (lower = more efficient)
  hue: number;        // 0-360: Color for display
}

interface Agent {
  id: string;
  x: number;
  y: number;
  energy: number;
  dna: DNA;
  age: number;
  generation: number;
  children: number;
  kills: number;
}

interface Food {
  x: number;
  y: number;
  energy: number;
}

interface WorldState {
  tick: number;
  agents: Map<string, Agent>;
  food: Map<string, Food>;
  deadCount: number;
  bornCount: number;
}

type Direction = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' | 'STAY';

const DIRECTIONS: Record<Direction, [number, number]> = {
  'N':  [0, -1],
  'NE': [1, -1],
  'E':  [1, 0],
  'SE': [1, 1],
  'S':  [0, 1],
  'SW': [-1, 1],
  'W':  [-1, 0],
  'NW': [-1, -1],
  'STAY': [0, 0],
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateId(): string {
  return Math.random().toString(36).substring(2, 8);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function wrapCoord(value: number, max: number): number {
  return ((value % max) + max) % max;
}

function posKey(x: number, y: number): string {
  return `${x},${y}`;
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  // Torus distance (wraparound)
  const dx = Math.min(
    Math.abs(x1 - x2),
    CONFIG.WORLD_WIDTH - Math.abs(x1 - x2)
  );
  const dy = Math.min(
    Math.abs(y1 - y2),
    CONFIG.WORLD_HEIGHT - Math.abs(y1 - y2)
  );
  return Math.sqrt(dx * dx + dy * dy);
}

function randomDNA(): DNA {
  return {
    speed: Math.floor(Math.random() * 3) + 1,
    vision: Math.floor(Math.random() * 5) + 1,
    aggression: Math.random(),
    metabolism: 0.5 + Math.random() * 1.5,
    hue: Math.floor(Math.random() * 360),
  };
}

function mutateDNA(parent: DNA): DNA {
  const mutate = (value: number, min: number, max: number): number => {
    if (Math.random() < CONFIG.MUTATION_RATE) {
      const delta = (Math.random() - 0.5) * 2 * CONFIG.MUTATION_MAGNITUDE * (max - min);
      return clamp(value + delta, min, max);
    }
    return value;
  };

  return {
    speed: Math.round(mutate(parent.speed, 1, 3)),
    vision: Math.round(mutate(parent.vision, 1, 5)),
    aggression: mutate(parent.aggression, 0, 1),
    metabolism: mutate(parent.metabolism, 0.5, 2),
    hue: (parent.hue + (Math.random() < CONFIG.MUTATION_RATE ? Math.floor(Math.random() * 60) - 30 : 0) + 360) % 360,
  };
}

// ============================================================================
// AGENT DECISION MAKING - THE "BRAIN"
// ============================================================================

interface AgentPerception {
  nearbyFood: Array<{ x: number; y: number; distance: number; energy: number }>;
  nearbyAgents: Array<{ x: number; y: number; distance: number; energy: number; aggression: number }>;
  canReproduce: boolean;
  energy: number;
  age: number;
}

function perceive(agent: Agent, world: WorldState): AgentPerception {
  const nearbyFood: AgentPerception['nearbyFood'] = [];
  const nearbyAgents: AgentPerception['nearbyAgents'] = [];

  // Scan for food within vision range
  for (const food of world.food.values()) {
    const dist = distance(agent.x, agent.y, food.x, food.y);
    if (dist <= agent.dna.vision) {
      nearbyFood.push({ x: food.x, y: food.y, distance: dist, energy: food.energy });
    }
  }

  // Scan for other agents within vision range
  for (const other of world.agents.values()) {
    if (other.id === agent.id) continue;
    const dist = distance(agent.x, agent.y, other.x, other.y);
    if (dist <= agent.dna.vision) {
      nearbyAgents.push({
        x: other.x,
        y: other.y,
        distance: dist,
        energy: other.energy,
        aggression: other.dna.aggression,
      });
    }
  }

  // Sort by distance
  nearbyFood.sort((a, b) => a.distance - b.distance);
  nearbyAgents.sort((a, b) => a.distance - b.distance);

  return {
    nearbyFood,
    nearbyAgents,
    canReproduce: agent.energy >= CONFIG.REPRODUCTION_THRESHOLD && world.agents.size < CONFIG.MAX_AGENTS,
    energy: agent.energy,
    age: agent.age,
  };
}

function decideAction(agent: Agent, perception: AgentPerception): { move: Direction; reproduce: boolean } {
  let targetX = agent.x;
  let targetY = agent.y;
  let reproduce = false;

  // Priority 1: If can reproduce and no immediate threats, reproduce
  if (perception.canReproduce && perception.energy > CONFIG.REPRODUCTION_THRESHOLD + 20) {
    const nearThreat = perception.nearbyAgents.find(
      a => a.aggression > agent.dna.aggression && a.distance < 2
    );
    if (!nearThreat) {
      reproduce = true;
    }
  }

  // Priority 2: If low energy, seek food aggressively
  if (perception.energy < CONFIG.STARTING_ENERGY * 0.5 && perception.nearbyFood.length > 0) {
    const closest = perception.nearbyFood[0];
    targetX = closest.x;
    targetY = closest.y;
  }
  // Priority 3: If there's nearby food, go for it
  else if (perception.nearbyFood.length > 0) {
    const closest = perception.nearbyFood[0];
    targetX = closest.x;
    targetY = closest.y;
  }
  // Priority 4: Avoid aggressive agents if we're not aggressive
  else if (agent.dna.aggression < 0.5 && perception.nearbyAgents.length > 0) {
    const threat = perception.nearbyAgents.find(a => a.aggression > 0.6);
    if (threat) {
      // Move away from threat
      const dx = agent.x - threat.x;
      const dy = agent.y - threat.y;
      targetX = agent.x + Math.sign(dx) * agent.dna.speed;
      targetY = agent.y + Math.sign(dy) * agent.dna.speed;
    }
  }
  // Priority 5: If aggressive and see weaker agent, chase
  else if (agent.dna.aggression > 0.6 && perception.nearbyAgents.length > 0) {
    const prey = perception.nearbyAgents.find(a => a.energy < agent.energy * 0.8);
    if (prey) {
      targetX = prey.x;
      targetY = prey.y;
    }
  }
  // Priority 6: Random exploration
  else {
    const dirs = Object.keys(DIRECTIONS) as Direction[];
    const randomDir = dirs[Math.floor(Math.random() * (dirs.length - 1))]; // Exclude STAY
    const [dx, dy] = DIRECTIONS[randomDir];
    targetX = agent.x + dx * agent.dna.speed;
    targetY = agent.y + dy * agent.dna.speed;
  }

  // Convert target to direction
  const move = getDirectionToward(agent.x, agent.y, targetX, targetY, agent.dna.speed);

  return { move, reproduce };
}

function getDirectionToward(fromX: number, fromY: number, toX: number, toY: number, maxSpeed: number): Direction {
  let dx = toX - fromX;
  let dy = toY - fromY;

  // Handle wraparound
  if (Math.abs(dx) > CONFIG.WORLD_WIDTH / 2) {
    dx = dx > 0 ? dx - CONFIG.WORLD_WIDTH : dx + CONFIG.WORLD_WIDTH;
  }
  if (Math.abs(dy) > CONFIG.WORLD_HEIGHT / 2) {
    dy = dy > 0 ? dy - CONFIG.WORLD_HEIGHT : dy + CONFIG.WORLD_HEIGHT;
  }

  // Clamp to speed
  dx = clamp(Math.round(dx), -maxSpeed, maxSpeed);
  dy = clamp(Math.round(dy), -maxSpeed, maxSpeed);

  if (dx === 0 && dy === 0) return 'STAY';

  // Find closest direction
  let bestDir: Direction = 'STAY';
  let bestDist = Infinity;

  for (const [dir, [ddx, ddy]] of Object.entries(DIRECTIONS)) {
    const dist = Math.abs(dx - ddx) + Math.abs(dy - ddy);
    if (dist < bestDist) {
      bestDist = dist;
      bestDir = dir as Direction;
    }
  }

  return bestDir;
}

// ============================================================================
// CUSTOM MODEL HANDLER - NO LLM NEEDED
// ============================================================================

let currentWorld: WorldState | null = null;

async function agentModelHandler(
  _runtime: IAgentRuntime,
  params: { prompt?: string }
): Promise<string> {
  // This handler processes agent decisions based on the current world state
  // The prompt contains the agent ID we need to process
  if (!params.prompt || !currentWorld) {
    return JSON.stringify({ move: 'STAY', reproduce: false });
  }

  const agentId = params.prompt.trim();
  const agent = currentWorld.agents.get(agentId);

  if (!agent) {
    return JSON.stringify({ move: 'STAY', reproduce: false });
  }

  const perception = perceive(agent, currentWorld);
  const decision = decideAction(agent, perception);

  return JSON.stringify(decision);
}

// ============================================================================
// GAME OF LIFE PLUGIN
// ============================================================================

const gameOfLifePlugin: Plugin = {
  name: "game-of-life",
  description: "Agentic Game of Life - emergent behavior simulation",
  priority: 100,

  models: {
    [ModelType.TEXT_LARGE]: agentModelHandler,
    [ModelType.TEXT_SMALL]: agentModelHandler,
  },
};

// ============================================================================
// WORLD SIMULATION
// ============================================================================

function createWorld(): WorldState {
  const agents = new Map<string, Agent>();
  const food = new Map<string, Food>();

  // Spawn initial agents
  for (let i = 0; i < CONFIG.INITIAL_AGENTS; i++) {
    const id = generateId();
    agents.set(id, {
      id,
      x: Math.floor(Math.random() * CONFIG.WORLD_WIDTH),
      y: Math.floor(Math.random() * CONFIG.WORLD_HEIGHT),
      energy: CONFIG.STARTING_ENERGY,
      dna: randomDNA(),
      age: 0,
      generation: 0,
      children: 0,
      kills: 0,
    });
  }

  // Spawn initial food
  const foodCount = Math.floor(CONFIG.WORLD_WIDTH * CONFIG.WORLD_HEIGHT * 0.1);
  for (let i = 0; i < foodCount; i++) {
    const x = Math.floor(Math.random() * CONFIG.WORLD_WIDTH);
    const y = Math.floor(Math.random() * CONFIG.WORLD_HEIGHT);
    const key = posKey(x, y);
    if (!food.has(key)) {
      food.set(key, { x, y, energy: CONFIG.FOOD_ENERGY });
    }
  }

  return { tick: 0, agents, food, deadCount: 0, bornCount: 0 };
}

async function simulateTick(world: WorldState, runtime: AgentRuntime): Promise<void> {
  world.tick++;
  const agentsToRemove: string[] = [];
  const agentsToAdd: Agent[] = [];

  // Set current world for model handler
  currentWorld = world;

  // Process each agent
  for (const agent of world.agents.values()) {
    // Get decision from "brain" via model handler
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: agent.id,
    });

    let decision: { move: Direction; reproduce: boolean };
    try {
      decision = JSON.parse(response);
    } catch {
      decision = { move: 'STAY', reproduce: false };
    }

    // Apply movement
    const [dx, dy] = DIRECTIONS[decision.move] || [0, 0];
    const moveMultiplier = Math.min(agent.dna.speed, Math.ceil(Math.abs(dx) + Math.abs(dy)));
    agent.x = wrapCoord(agent.x + dx * moveMultiplier, CONFIG.WORLD_WIDTH);
    agent.y = wrapCoord(agent.y + dy * moveMultiplier, CONFIG.WORLD_HEIGHT);

    // Energy cost for moving
    const moveCost = decision.move === 'STAY' 
      ? CONFIG.IDLE_COST 
      : CONFIG.MOVE_COST * agent.dna.metabolism * moveMultiplier;
    agent.energy -= moveCost;

    // Check for food at current position
    const foodKey = posKey(agent.x, agent.y);
    const foodHere = world.food.get(foodKey);
    if (foodHere) {
      agent.energy = Math.min(CONFIG.MAX_ENERGY, agent.energy + foodHere.energy);
      world.food.delete(foodKey);
    }

    // Check for reproduction
    if (decision.reproduce && agent.energy >= CONFIG.REPRODUCTION_THRESHOLD && world.agents.size < CONFIG.MAX_AGENTS) {
      agent.energy -= CONFIG.REPRODUCTION_COST;
      agent.children++;
      world.bornCount++;

      const childDNA = mutateDNA(agent.dna);
      const childX = wrapCoord(agent.x + Math.floor(Math.random() * 3) - 1, CONFIG.WORLD_WIDTH);
      const childY = wrapCoord(agent.y + Math.floor(Math.random() * 3) - 1, CONFIG.WORLD_HEIGHT);

      agentsToAdd.push({
        id: generateId(),
        x: childX,
        y: childY,
        energy: CONFIG.REPRODUCTION_COST * 0.8,
        dna: childDNA,
        age: 0,
        generation: agent.generation + 1,
        children: 0,
        kills: 0,
      });
    }

    // Age the agent
    agent.age++;

    // Check for death
    if (agent.energy <= 0) {
      agentsToRemove.push(agent.id);
      world.deadCount++;
    }
  }

  // Handle agent collisions (energy transfer based on aggression)
  const positionMap = new Map<string, Agent[]>();
  for (const agent of world.agents.values()) {
    const key = posKey(agent.x, agent.y);
    if (!positionMap.has(key)) positionMap.set(key, []);
    positionMap.get(key)!.push(agent);
  }

  for (const agents of positionMap.values()) {
    if (agents.length > 1) {
      // Sort by aggression * energy (fighting power)
      agents.sort((a, b) => (b.dna.aggression * b.energy) - (a.dna.aggression * a.energy));
      const winner = agents[0];
      for (let i = 1; i < agents.length; i++) {
        const loser = agents[i];
        // Energy transfer based on aggression difference
        const transfer = Math.min(loser.energy * 0.3, 20) * (winner.dna.aggression - loser.dna.aggression + 0.5);
        if (transfer > 0) {
          winner.energy = Math.min(CONFIG.MAX_ENERGY, winner.energy + transfer);
          loser.energy -= transfer;
          if (loser.energy <= 0 && !agentsToRemove.includes(loser.id)) {
            agentsToRemove.push(loser.id);
            world.deadCount++;
            winner.kills++;
          }
        }
      }
    }
  }

  // Remove dead agents
  for (const id of agentsToRemove) {
    world.agents.delete(id);
  }

  // Add new agents
  for (const agent of agentsToAdd) {
    world.agents.set(agent.id, agent);
  }

  // Spawn new food
  const currentFoodDensity = world.food.size / (CONFIG.WORLD_WIDTH * CONFIG.WORLD_HEIGHT);
  if (currentFoodDensity < CONFIG.MAX_FOOD_DENSITY) {
    const spawnAttempts = Math.floor(CONFIG.WORLD_WIDTH * CONFIG.WORLD_HEIGHT * CONFIG.FOOD_SPAWN_RATE);
    for (let i = 0; i < spawnAttempts; i++) {
      const x = Math.floor(Math.random() * CONFIG.WORLD_WIDTH);
      const y = Math.floor(Math.random() * CONFIG.WORLD_HEIGHT);
      const key = posKey(x, y);
      if (!world.food.has(key)) {
        world.food.set(key, { x, y, energy: CONFIG.FOOD_ENERGY });
      }
    }
  }
}

// ============================================================================
// VISUALIZATION
// ============================================================================

function hslToAnsi256(h: number, s: number, l: number): number {
  // Simplified HSL to ANSI 256 color conversion
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;

  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }

  r = Math.round((r + m) * 5);
  g = Math.round((g + m) * 5);
  b = Math.round((b + m) * 5);

  return 16 + 36 * r + 6 * g + b;
}

function renderWorld(world: WorldState, showStats: boolean): string {
  const grid: string[][] = [];

  // Initialize empty grid
  for (let y = 0; y < CONFIG.WORLD_HEIGHT; y++) {
    grid[y] = [];
    for (let x = 0; x < CONFIG.WORLD_WIDTH; x++) {
      grid[y][x] = '\x1b[48;5;234m  \x1b[0m'; // Dark gray background
    }
  }

  // Place food (green dots)
  for (const food of world.food.values()) {
    grid[food.y][food.x] = '\x1b[48;5;22m🌱\x1b[0m'; // Green background with plant
  }

  // Place agents (colored based on DNA hue, brightness based on energy)
  for (const agent of world.agents.values()) {
    const lightness = 0.3 + (agent.energy / CONFIG.MAX_ENERGY) * 0.4;
    const colorCode = hslToAnsi256(agent.dna.hue, 0.8, lightness);
    
    // Choose symbol based on traits
    let symbol = '●';
    if (agent.dna.aggression > 0.7) symbol = '◆'; // Aggressive = diamond
    else if (agent.dna.speed >= 3) symbol = '▲'; // Fast = triangle
    else if (agent.dna.vision >= 4) symbol = '◉'; // Good vision = target
    
    grid[agent.y][agent.x] = `\x1b[38;5;${colorCode}m${symbol} \x1b[0m`;
  }

  // Build output
  let output = '\x1b[2J\x1b[H'; // Clear screen and move cursor to top
  output += '╔' + '══'.repeat(CONFIG.WORLD_WIDTH) + '╗\n';

  for (let y = 0; y < CONFIG.WORLD_HEIGHT; y++) {
    output += '║' + grid[y].join('') + '║\n';
  }

  output += '╚' + '══'.repeat(CONFIG.WORLD_WIDTH) + '╝\n';

  // Stats line
  const avgEnergy = world.agents.size > 0
    ? Math.round([...world.agents.values()].reduce((sum, a) => sum + a.energy, 0) / world.agents.size)
    : 0;
  const avgGen = world.agents.size > 0
    ? Math.round([...world.agents.values()].reduce((sum, a) => sum + a.generation, 0) / world.agents.size * 10) / 10
    : 0;
  const avgAggression = world.agents.size > 0
    ? Math.round([...world.agents.values()].reduce((sum, a) => sum + a.dna.aggression, 0) / world.agents.size * 100)
    : 0;

  output += `\n  Tick: ${world.tick}  |  Agents: ${world.agents.size}  |  Food: ${world.food.size}  |  Born: ${world.bornCount}  |  Died: ${world.deadCount}\n`;
  output += `  Avg Energy: ${avgEnergy}  |  Avg Gen: ${avgGen}  |  Avg Aggression: ${avgAggression}%\n`;
  output += '\n  Legend: ● Normal  ◆ Aggressive  ▲ Fast  ◉ Sharp Vision  🌱 Food\n';

  if (showStats) {
    // Show top agents
    const topAgents = [...world.agents.values()]
      .sort((a, b) => b.children - a.children)
      .slice(0, 5);

    if (topAgents.length > 0) {
      output += '\n  Top Reproducers:\n';
      for (const agent of topAgents) {
        output += `    ${agent.id}: Gen ${agent.generation}, ${agent.children} children, ${agent.kills} kills\n`;
      }
    }
  }

  return output;
}

// ============================================================================
// MAIN SIMULATION LOOP
// ============================================================================

interface SimSession {
  runtime: AgentRuntime;
  world: WorldState;
}

async function createSession(): Promise<SimSession> {
  const task = clack.spinner();
  task.start("Initializing Agentic Game of Life...");

  const runtime = new AgentRuntime({
    plugins: [sqlPlugin, bootstrapPlugin, gameOfLifePlugin],
    settings: {
      PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR || "memory://",
    },
  });

  await runtime.initialize();

  const world = createWorld();

  task.stop(`✅ World created with ${world.agents.size} agents! Evolution begins...`);

  return { runtime, world };
}

function parseArgs(): { fast: boolean; stats: boolean } {
  const args = process.argv.slice(2);
  return {
    fast: args.includes('--fast') || args.includes('-f'),
    stats: args.includes('--stats') || args.includes('-s'),
  };
}

function showIntro(): void {
  clack.intro("🧬 elizaOS Agentic Game of Life");
  console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║                     AGENTIC GAME OF LIFE                               ║
╠════════════════════════════════════════════════════════════════════════╣
║  Watch ${CONFIG.INITIAL_AGENTS} autonomous agents evolve on a ${CONFIG.WORLD_WIDTH}x${CONFIG.WORLD_HEIGHT} world!              ║
║                                                                        ║
║  Each agent has DNA that determines:                                   ║
║  • Speed (1-3): How fast they move                                     ║
║  • Vision (1-5): How far they can see                                  ║
║  • Aggression (0-100%): Fight vs flee tendency                         ║
║  • Metabolism: Energy efficiency                                       ║
║                                                                        ║
║  Agents must:                                                          ║
║  • Find 🌱 food to gain energy                                         ║
║  • Avoid running out of energy (death)                                 ║
║  • Reproduce when energy > ${CONFIG.REPRODUCTION_THRESHOLD} (offspring inherit mutated DNA)     ║
║                                                                        ║
║  Aggressive agents (◆) can steal energy from others!                   ║
║  Over generations, watch evolution favor survival strategies!          ║
╚════════════════════════════════════════════════════════════════════════╝
`);
}

async function main(): Promise<void> {
  const { fast, stats } = parseArgs();

  showIntro();

  const session = await createSession();
  const tickDelay = fast ? CONFIG.TICK_DELAY_MS / 10 : CONFIG.TICK_DELAY_MS;

  console.log('\n  Press Ctrl+C to stop the simulation\n');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Main simulation loop
  while (session.world.tick < CONFIG.MAX_GENERATIONS && session.world.agents.size > 0) {
    await simulateTick(session.world, session.runtime);
    console.log(renderWorld(session.world, stats));
    await new Promise(resolve => setTimeout(resolve, tickDelay));
  }

  // Show final stats
  console.log('\n' + '═'.repeat(60));
  if (session.world.agents.size === 0) {
    console.log('💀 EXTINCTION - All agents have perished!');
  } else {
    console.log(`🏁 Simulation complete after ${session.world.tick} ticks`);
    console.log(`   Final population: ${session.world.agents.size}`);
    console.log(`   Total births: ${session.world.bornCount}`);
    console.log(`   Total deaths: ${session.world.deadCount}`);

    // Find most successful lineage
    const maxGen = Math.max(...[...session.world.agents.values()].map(a => a.generation));
    console.log(`   Highest generation reached: ${maxGen}`);
  }
  console.log('═'.repeat(60) + '\n');

  await session.runtime.stop();
  clack.outro("Thanks for watching evolution! 🧬");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

