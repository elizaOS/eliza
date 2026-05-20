#!/usr/bin/env bun

/**
 * Live integration test: LLMAgent + ArchetypeAgent against the local A2A server.
 *
 * Requires:
 *   - Local A2A server running on localhost:3001
 *   - GROQ_API_KEY in environment
 *
 * Run: bun run tests/live-llm-integration.ts
 */

import { archetypeAgent } from '../src/agents/archetype-agent';
import { createLLMAgent } from '../src/agents/llm-agent';
import { getArchetype } from '../src/archetypes';
import { runHarness } from '../src/harness';

const A2A_URL = 'http://localhost:3001';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ─── Pre-flight checks ────────────────────────────────────────────────────────

async function checkServer(): Promise<boolean> {
  try {
    const r = await fetch(`${A2A_URL}/health`);
    const j = (await r.json()) as { status?: string };
    return r.ok && j.status === 'ok';
  } catch {
    return false;
  }
}

const serverUp = await checkServer();
if (!serverUp) {
  console.error(`${RED}✗ Local A2A server not running on ${A2A_URL}${RESET}`);
  console.error(
    '  Start it with: cd packages/examples/local-a2a-server && bun run src/server.ts'
  );
  process.exit(1);
}
console.log(`${GREEN}✓ A2A server up${RESET} at ${A2A_URL}\n`);

const hasGroq = !!process.env.GROQ_API_KEY;
const hasOpenAI = !!process.env.OPENAI_API_KEY;
if (!hasGroq && !hasOpenAI) {
  console.error(
    `${RED}✗ No LLM key found. Set GROQ_API_KEY or OPENAI_API_KEY.${RESET}`
  );
  process.exit(1);
}
const provider = hasGroq ? 'groq' : 'openai';
console.log(`${GREEN}✓ LLM provider${RESET}: ${provider}\n`);

// ─── Test 1: ArchetypeAgent against all archetypes ─────────────────────────────

console.log(
  `${BOLD}${CYAN}Test 1: ArchetypeAgent × 4 archetypes × 3 ticks${RESET}`
);

const archetypes = ['trader', 'degen', 'researcher', 'scammer'].map(
  getArchetype
);

const r1 = await runHarness({
  a2aUrl: A2A_URL,
  agents: [archetypeAgent],
  archetypes,
  instancesPerAgent: 1,
  ticksPerAgent: 3,
  parallelAgents: 4,
  tickInterval: 200,
  recordTrajectories: false,
});

let pass1 = true;

if (r1.agentsRun !== 4) {
  console.error(`${RED}✗ Expected 4 agents, got ${r1.agentsRun}${RESET}`);
  pass1 = false;
}
if (r1.totalTicks !== 12) {
  console.error(`${RED}✗ Expected 12 ticks, got ${r1.totalTicks}${RESET}`);
  pass1 = false;
}
if (r1.errors.length > 0) {
  console.error(`${RED}✗ Errors:${RESET}`, r1.errors);
  pass1 = false;
}

for (const t of r1.trajectories) {
  if (t.steps.length !== 3) {
    console.error(
      `${RED}✗ Trajectory ${t.archetype} has ${t.steps.length} steps, expected 3${RESET}`
    );
    pass1 = false;
  }
  for (const s of t.steps) {
    if (!s.decision.action) {
      console.error(`${RED}✗ Step missing action${RESET}`);
      pass1 = false;
    }
    if (typeof s.reward !== 'number') {
      console.error(`${RED}✗ Step missing reward${RESET}`);
      pass1 = false;
    }
  }
}

for (const arch of ['trader', 'degen', 'researcher', 'scammer']) {
  if (!r1.stats.byArchetype[arch]) {
    console.error(`${RED}✗ Missing stats for ${arch}${RESET}`);
    pass1 = false;
  }
}

if (pass1) {
  console.log(
    `${GREEN}✓ ArchetypeAgent test passed${RESET} — ${r1.agentsRun} agents, ${r1.totalTicks} ticks, 0 errors\n`
  );
} else {
  console.log(`${RED}✗ ArchetypeAgent test FAILED${RESET}\n`);
}

// ─── Test 2: LLMAgent vs real GROQ/OpenAI ─────────────────────────────────────

console.log(
  `${BOLD}${CYAN}Test 2: LLMAgent (${provider}) × trader + degen × 3 ticks${RESET}`
);

const llmAgent = createLLMAgent({ provider: provider as 'groq' | 'openai' });

const r2 = await runHarness({
  a2aUrl: A2A_URL,
  agents: [llmAgent],
  archetypes: [getArchetype('trader'), getArchetype('degen')],
  instancesPerAgent: 1,
  ticksPerAgent: 3,
  parallelAgents: 2,
  tickInterval: 300,
  recordTrajectories: false,
});

let pass2 = true;

if (r2.agentsRun !== 2) {
  console.error(`${RED}✗ Expected 2 agents, got ${r2.agentsRun}${RESET}`);
  pass2 = false;
}
if (r2.totalTicks !== 6) {
  console.error(`${RED}✗ Expected 6 ticks, got ${r2.totalTicks}${RESET}`);
  pass2 = false;
}

// Each step should have a non-empty reasoning string
for (const t of r2.trajectories) {
  for (const s of t.steps) {
    if (!s.decision.reasoning) {
      console.error(`${RED}✗ LLM step has no reasoning${RESET}`);
      pass2 = false;
    }
    if (!s.decision.action) {
      console.error(`${RED}✗ LLM step has no action${RESET}`);
      pass2 = false;
    }
  }
}

// Count actual LLM decisions (non-HOLD, non-error)
const llmActions = r2.trajectories.flatMap((t) =>
  t.steps.map((s) => s.decision.action)
);
const holdCount = llmActions.filter((a) => a === 'HOLD').length;
const realActions = llmActions.length - holdCount;
console.log(`${DIM}  LLM actions: ${llmActions.join(', ')}${RESET}`);

if (r2.errors.length > 0) {
  console.log(`${RED}  Errors: ${r2.errors.join(', ')}${RESET}`);
}

if (pass2) {
  console.log(
    `${GREEN}✓ LLMAgent test passed${RESET} — ${realActions}/${llmActions.length} real actions (${holdCount} HOLDs)\n`
  );
  for (const t of r2.trajectories) {
    console.log(
      `${DIM}  [${t.archetype}] reward=${t.totalReward.toFixed(1)}${RESET}`
    );
    for (const s of t.steps) {
      const icon = s.result.success ? '✅' : '❌';
      console.log(
        `    ${icon} ${s.decision.action.padEnd(18)} ${s.decision.reasoning.slice(0, 70)}`
      );
    }
  }
} else {
  console.log(`${RED}✗ LLMAgent test FAILED${RESET}\n`);
}

// ─── Test 3: clientFactory offline (SimulationA2AAdapter) ────────────────────

console.log(
  `\n${BOLD}${CYAN}Test 3: Offline mode (SimulationA2AAdapter) — no server needed${RESET}`
);

import { SimulationAdapter } from '../src/offline-adapter';

let simIdx = 0;

const r3 = await runHarness({
  a2aUrl: '',
  agents: [archetypeAgent],
  archetypes: [getArchetype('trader'), getArchetype('researcher')],
  instancesPerAgent: 1,
  ticksPerAgent: 5,
  parallelAgents: 2,
  tickInterval: 0,
  recordTrajectories: false,
  clientFactory: () =>
    new SimulationAdapter({
      numPredictionMarkets: 3,
      numPerpMarkets: 2,
      numAgents: 5,
      seed: 42 + simIdx++,
    }),
});

let pass3 = true;
if (r3.agentsRun !== 2) {
  console.error(`${RED}✗ Expected 2 sim agents, got ${r3.agentsRun}${RESET}`);
  pass3 = false;
}
if (r3.totalTicks !== 10) {
  console.error(`${RED}✗ Expected 10 sim ticks, got ${r3.totalTicks}${RESET}`);
  pass3 = false;
}

if (pass3) {
  console.log(
    `${GREEN}✓ Offline simulation passed${RESET} — ${r3.agentsRun} agents, ${r3.totalTicks} ticks, no server\n`
  );
} else {
  console.log(`${RED}✗ Offline simulation FAILED${RESET}\n`);
}

// ─── Test 4: harness CLI smoke test ──────────────────────────────────────────

console.log(`${BOLD}${CYAN}Test 4: CLI smoke test${RESET}`);
const cliProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'list-archetypes'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdout: 'pipe',
  stderr: 'pipe',
});
const cliExit = await cliProc.exited;
const cliOut = await new Response(cliProc.stdout).text();
const cliOk = cliExit === 0 && cliOut.includes('trader');

if (cliOk) {
  console.log(`${GREEN}✓ CLI list-archetypes works${RESET}`);
} else {
  console.error(`${RED}✗ CLI failed (exit ${cliExit})${RESET}`);
  console.error(cliOut.slice(0, 200));
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const allPass = pass1 && pass2 && pass3 && cliOk;
console.log(
  `\n${BOLD}${allPass ? GREEN + '✅ ALL TESTS PASSED' : RED + '❌ SOME TESTS FAILED'}${RESET}\n`
);
process.exit(allPass ? 0 : 1);
