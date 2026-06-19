#!/usr/bin/env bun

/**
 * Agent Harness CLI
 *
 * Run parallel agent training with different archetypes.
 *
 * Usage:
 *   bun run src/cli.ts train --archetypes trader,degen --ticks 20
 *   bun run src/cli.ts test --agent random
 *   bun run src/cli.ts list-archetypes
 */

import { archetypeAgent } from "./agents/archetype-agent";
import { randomAgent } from "./agents/random-agent";
import { getAllArchetypes, getArchetype } from "./archetypes";
import { runHarness } from "./harness";
import type { ArchetypeConfig, TrainableAgent } from "./types";

const A2A_URL = process.env.A2A_URL || "http://localhost:3001";

// Available agents
const AGENTS: Record<string, TrainableAgent> = {
  random: randomAgent,
  archetype: archetypeAgent,
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  switch (command) {
    case "train":
      await runTrain(args.slice(1));
      break;
    case "test":
      await runTest(args.slice(1));
      break;
    case "list-archetypes":
      listArchetypes();
      break;
    case "list-agents":
      listAgents();
      break;
    default:
      showHelp();
  }
}

async function runTrain(args: string[]) {
  // Parse arguments
  const archetypeArg = getArg(args, "--archetypes", "-a") || "trader,degen";
  const agentArg = getArg(args, "--agents", "-g") || "archetype";
  const ticksArg = getArg(args, "--ticks", "-t") || "10";
  const parallelArg = getArg(args, "--parallel", "-p") || "4";
  const instancesArg = getArg(args, "--instances", "-i") || "1";
  const outputArg = getArg(args, "--output", "-o") || "./trajectories";
  const intervalArg = getArg(args, "--interval") || "2000";

  // Parse archetype list
  let archetypes: ArchetypeConfig[];
  if (archetypeArg === "all") {
    archetypes = getAllArchetypes();
  } else {
    archetypes = archetypeArg.split(",").map((id) => getArchetype(id.trim()));
  }

  // Parse agent list
  const agentIds = agentArg.split(",").map((id) => id.trim());
  const agents: TrainableAgent[] = agentIds.map((id) => {
    const agent = AGENTS[id];
    if (!agent) {
      console.error(
        `Unknown agent: ${id}. Available: ${Object.keys(AGENTS).join(", ")}`,
      );
      process.exit(1);
    }
    return agent;
  });

  console.log("\n🎯 Training Configuration:");
  console.log(`   A2A URL: ${A2A_URL}`);
  console.log(`   Agents: ${agentIds.join(", ")}`);
  console.log(`   Archetypes: ${archetypes.map((a) => a.id).join(", ")}`);
  console.log(`   Instances per combo: ${instancesArg}`);
  console.log(`   Ticks per agent: ${ticksArg}`);
  console.log(`   Parallel: ${parallelArg}`);
  console.log(`   Output: ${outputArg}`);

  const result = await runHarness({
    a2aUrl: A2A_URL,
    agents,
    archetypes,
    instancesPerAgent: parseInt(instancesArg, 10),
    ticksPerAgent: parseInt(ticksArg, 10),
    parallelAgents: parseInt(parallelArg, 10),
    tickInterval: parseInt(intervalArg, 10),
    recordTrajectories: true,
    outputDir: outputArg,
  });

  // Print summary
  console.log("\n📊 Training Summary:");
  console.log(`   Total agents run: ${result.agentsRun}`);
  console.log(`   Total ticks: ${result.totalTicks}`);
  console.log(`   Trajectories: ${result.trajectories.length}`);
  console.log(`   Duration: ${(result.duration / 1000).toFixed(1)}s`);
  console.log(`   Errors: ${result.errors.length}`);

  console.log("\n📈 By Archetype:");
  for (const [id, stats] of Object.entries(result.stats.byArchetype)) {
    console.log(
      `   ${id}: ${stats.agents} agents, ${stats.ticks} ticks, avg reward: ${stats.avgReward.toFixed(2)}`,
    );
  }

  console.log("\n📈 By Agent:");
  for (const [id, stats] of Object.entries(result.stats.byAgent)) {
    console.log(
      `   ${id}: ${stats.instances} instances, ${stats.ticks} ticks, avg reward: ${stats.avgReward.toFixed(2)}`,
    );
  }

  if (result.errors.length > 0) {
    console.log("\n❌ Errors:");
    for (const error of result.errors.slice(0, 5)) {
      console.log(`   ${error}`);
    }
    if (result.errors.length > 5) {
      console.log(`   ... and ${result.errors.length - 5} more`);
    }
  }
}

async function runTest(args: string[]) {
  const agentArg = getArg(args, "--agent", "-a") || "random";
  const ticksArg = getArg(args, "--ticks", "-t") || "5";

  const agent = AGENTS[agentArg];
  if (!agent) {
    console.error(
      `Unknown agent: ${agentArg}. Available: ${Object.keys(AGENTS).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`\n🧪 Testing ${agent.name}...`);

  const result = await runHarness({
    a2aUrl: A2A_URL,
    agents: [agent],
    archetypes: [getArchetype("trader")], // Use trader as test archetype
    instancesPerAgent: 1,
    ticksPerAgent: parseInt(ticksArg, 10),
    parallelAgents: 1,
    tickInterval: 1000,
    recordTrajectories: false,
  });

  console.log(`\n✅ Test complete!`);
  console.log(`   Ticks: ${result.totalTicks}`);
  console.log(`   Errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.error("\n❌ Test failed with errors:");
    for (const error of result.errors) {
      console.error(`   ${error}`);
    }
    process.exit(1);
  }
}

function listArchetypes() {
  console.log("\n📋 Available Archetypes:\n");
  for (const archetype of getAllArchetypes()) {
    console.log(`   ${archetype.id.padEnd(20)} ${archetype.name}`);
    console.log(`   ${"".padEnd(20)} ${archetype.description}`);
    console.log(
      `   ${"".padEnd(20)} Risk: ${archetype.riskTolerance.toFixed(1)} | Ethics: ${archetype.traits.ethics.toFixed(1)}`,
    );
    console.log("");
  }
}

function listAgents() {
  console.log("\n🤖 Available Agents:\n");
  for (const [id, agent] of Object.entries(AGENTS)) {
    console.log(`   ${id.padEnd(20)} ${agent.name} (${agent.language})`);
  }
  console.log("");
}

function showHelp() {
  console.log(`
🎯 Agent Training Harness CLI

COMMANDS:
  train              Run parallel agent training
  test               Test a single agent
  list-archetypes    Show available archetypes
  list-agents        Show available agents
  help               Show this help

TRAIN OPTIONS:
  --archetypes, -a   Comma-separated archetype IDs (or 'all')
  --agents, -g       Comma-separated agent IDs
  --ticks, -t        Ticks per agent (default: 10)
  --parallel, -p     Max parallel agents (default: 4)
  --instances, -i    Instances per agent/archetype combo (default: 1)
  --output, -o       Output directory for trajectories
  --interval         Tick interval in ms (default: 2000)

TEST OPTIONS:
  --agent, -a        Agent ID to test
  --ticks, -t        Number of ticks (default: 5)

EXAMPLES:
  # Run training with specific archetypes
  bun run src/cli.ts train --archetypes trader,degen,scammer --ticks 20

  # Run all archetypes
  bun run src/cli.ts train -a all -t 10 -p 6

  # Test an agent
  bun run src/cli.ts test --agent archetype --ticks 5

  # List available options
  bun run src/cli.ts list-archetypes
  bun run src/cli.ts list-agents

ENVIRONMENT:
  A2A_URL            A2A server URL (default: http://localhost:3001)
`);
}

function getArg(
  args: string[],
  long: string,
  short?: string,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === long || (short && args[i] === short)) {
      return args[i + 1];
    }
    if (args[i].startsWith(`${long}=`)) {
      return args[i].split("=")[1];
    }
    if (short && args[i].startsWith(`${short}=`)) {
      return args[i].split("=")[1];
    }
  }
  return undefined;
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
