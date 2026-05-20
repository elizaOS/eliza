# @babylon/agent-harness

A framework for running autonomous agents against Babylon's prediction markets. Records agent trajectories for training, benchmarking, and ScamBench evaluation.

## Overview

The harness connects any `TrainableAgent` implementation to Babylon's A2A (Agent-to-Agent) protocol and runs it through a configurable loop of ticks. Each tick:

1. Gathers context (portfolio, markets, feed) from the A2A server.
2. Asks the agent to decide an action.
3. Executes the action.
4. Records the step with a reward signal.

At the end of the run, trajectories are saved as JSON files for downstream training.

## Prerequisites

```bash
# From the babylon repo root
bun install
bun run agent-frameworks:bootstrap   # clones Hermes, OpenClaw, ElizaOS, ClawBench
```

You'll need one of:
- `GROQ_API_KEY` — fastest, free tier available
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

And one of:
- **Local A2A server** at `localhost:3001` (`bun run dev` in `packages/examples/local-a2a-server`)
- **Full Babylon dev stack** at `localhost:3000` (`bun run dev` from repo root)

## Quick Start

```typescript
import {
  runHarness,
  createLLMAgent,
  getArchetype,
} from '@babylon/agent-harness';

const result = await runHarness({
  a2aUrl: 'http://localhost:3001',
  agents: [createLLMAgent({ provider: 'groq' })],
  archetypes: [getArchetype('trader'), getArchetype('degen')],
  instancesPerAgent: 1,
  ticksPerAgent: 20,
  parallelAgents: 4,
  recordTrajectories: true,
  outputDir: './trajectories',
});

console.log(`Ran ${result.agentsRun} agents, ${result.totalTicks} ticks`);
```

Or use the CLI:

```bash
# From this directory
bun run train -- --archetypes trader,degen --ticks 20
bun run test:agents -- --a2a-url http://localhost:3001
```

## Agents

### RandomAgent

Stochastic baseline that makes uniformly random decisions. Good as a floor for benchmarking.

```typescript
import { randomAgent } from '@babylon/agent-harness';
```

### ArchetypeAgent

Rule-based agent influenced by archetype traits (greed, fear, confidence, ethics). Deterministic-ish — reproducible without an LLM key.

```typescript
import { archetypeAgent } from '@babylon/agent-harness';
```

### LLMAgent

Sends the full game context to a real LLM and parses its JSON decision. Supports Groq, OpenAI, and Anthropic.

```typescript
import { createLLMAgent } from '@babylon/agent-harness';

const agent = createLLMAgent({
  provider: 'groq',                         // 'groq' | 'openai' | 'anthropic'
  model: 'llama-3.3-70b-versatile',        // optional, uses provider default
  temperature: 0.7,
});
```

Auto-detects the provider from available env keys (`GROQ_API_KEY` takes priority, then `OPENAI_API_KEY`, then `ANTHROPIC_API_KEY`).

### HermesAdapter

Runs [Hermes](https://github.com/NousResearch/hermes-agent) (NousResearch) via the Python bridge script. Requires bootstrap.

```typescript
import { createHermesAdapter } from '@babylon/agent-harness';

const agent = createHermesAdapter({
  model: 'llama-3.3-70b-versatile',
  baseUrl: 'https://api.groq.com/openai/v1',
  persistent: true,   // keep Python process alive between ticks (faster)
});
```

### OpenClawAdapter

Runs [OpenClaw](https://openclaw.ai) in CLI mode (`openclaw agent --message ...`) or connects to its HTTP gateway.

```typescript
import { createOpenClawAdapter } from '@babylon/agent-harness';

// CLI mode — no gateway required
const agent = createOpenClawAdapter({ mode: 'cli', model: 'gpt-4o' });

// Gateway mode — requires `openclaw gateway` running
const agent = createOpenClawAdapter({
  mode: 'gateway',
  gatewayUrl: 'http://localhost:18789',
});
```

## A2A Clients

### HarnessA2AClient (default)

JSON-RPC client targeting the local A2A server (`localhost:3001`). Uses Anvil-style private keys for signing. This is the default when no `clientFactory` is provided.

### BabylonProductionClient

Official A2A SDK client targeting the real Babylon server (`localhost:3000` or `babylon.market`). Uses the `@a2a-js/sdk` `message/send` protocol.

```typescript
import { BabylonProductionClient, runHarness, createLLMAgent, getArchetype } from '@babylon/agent-harness';

const client = new BabylonProductionClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.BABYLON_API_KEY!,
});

const result = await runHarness({
  a2aUrl: 'http://localhost:3000',
  clientFactory: () => client,
  agents: [createLLMAgent()],
  archetypes: [getArchetype('trader')],
  instancesPerAgent: 1,
  ticksPerAgent: 10,
  parallelAgents: 1,
  recordTrajectories: true,
});
```

### SimulationA2AAdapter (offline)

No server required — uses the engine's `InMemoryStateStore` for a fully local simulation.

```typescript
import {
  SimulationA2AAdapter,
  SimulationAdapter,
  runHarness,
  createLLMAgent,
  getArchetype,
} from '@babylon/agent-harness';

let idx = 0;

const result = await runHarness({
  a2aUrl: '',                  // unused in offline mode
  clientFactory: () => {
    const engine = new SimulationAdapter({ numPredictionMarkets: 5, numAgents: 20 });
    return new SimulationA2AAdapter(engine, `agent-${idx++}`);
  },
  agents: [createLLMAgent()],
  archetypes: [getArchetype('trader')],
  instancesPerAgent: 1,
  ticksPerAgent: 10,
  parallelAgents: 2,
  recordTrajectories: true,
});
```

## Archetypes

Archetypes define personality traits (greed, fear, patience, confidence, ethics) and action-weight distributions that influence how agents behave.

```typescript
import { getArchetype, getAllArchetypes, getArchetypeIds } from '@babylon/agent-harness';

getArchetypeIds();
// → ['trader', 'degen', 'hodler', 'scammer', 'whale', 'analyst', ...]

const trader = getArchetype('trader');
// → { id, name, description, system, traits, riskTolerance, actionWeights }
```

The `system` field is a plain-English prompt suffix injected into LLM-based agents.

## Trajectory Format

Each run produces one JSON file per agent instance and a `summary.json`:

```
trajectories/
  traj-1712345678-0.json   # full trajectory with all steps
  traj-1712345678-1.json
  summary.json             # aggregate stats
```

A trajectory file:
```json
{
  "id": "traj-1712345678-0",
  "agentId": "agent-31337-123456",
  "archetype": "trader",
  "startTime": "2026-04-07T00:00:00.000Z",
  "endTime": "2026-04-07T00:01:30.000Z",
  "totalReward": 14.5,
  "metadata": { "agentType": "llm-agent", "language": "typescript" },
  "steps": [
    {
      "tick": 1,
      "timestamp": "...",
      "context": { "balance": 1000, "positions": [], "markets": [...], "posts": [...] },
      "decision": { "action": "BUY_YES", "params": { "marketId": "...", "amount": 50 }, "reasoning": "..." },
      "result": { "success": true, "action": "BUY_YES", "data": { ... } },
      "reward": 3.0
    }
  ]
}
```

These are the inputs to the Python ScamBench training pipeline — see `packages/training/SCAMBENCH_RUNBOOK.md`.

## ScamBench Integration

The harness is the TypeScript entry point for collecting Babylon-native trajectories for ScamBench:

1. **Generate trajectories** using `LLMAgent` or `HermesAdapter` against the real dev server.
2. **Export** with `scripts/export-trust-experiment-trajectories.ts`.
3. **Train** via `packages/training/python/scripts/train_local.py`.
4. **Benchmark** via `packages/training/python/scripts/run_scambench_local.py`.

See `packages/training/SCAMBENCH_RUNBOOK.md` for the full pipeline.

## CLI Reference

```
bun run dev -- [command] [options]

Commands:
  train           Run a full training session (default)
  test            Run a quick 3-tick test
  list-archetypes List all available archetypes
  list-agents     List available built-in agents

Options:
  --a2a-url       A2A server URL (default: http://localhost:3001)
  --archetypes    Comma-separated archetype IDs (default: trader,degen,analyst)
  --ticks         Ticks per agent (default: 10)
  --parallel      Max parallel agents (default: 5)
  --output-dir    Directory for trajectory output (default: ./trajectories)
```

## Implementing a Custom Agent

```typescript
import type { TrainableAgent, AgentContext, AgentDecision, AgentConfig } from '@babylon/agent-harness';

class MyAgent implements TrainableAgent {
  readonly id = 'my-agent';
  readonly name = 'My Agent';
  readonly language = 'typescript';

  async initialize(config: AgentConfig): Promise<void> {
    // setup
  }

  async decide(context: AgentContext): Promise<AgentDecision> {
    return {
      action: 'BUY_YES',
      params: { marketId: context.markets[0]?.id, amount: 10 },
      reasoning: 'always buy YES',
    };
  }

  async cleanup(): Promise<void> {
    // teardown
  }
}
```
