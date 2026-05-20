/**
 * Agent Training Harness
 *
 * A framework for running and training agents with different archetypes.
 *
 * @example
 * ```typescript
 * import { runHarness, archetypeAgent, getArchetype } from '@feed/agent-harness';
 *
 * const result = await runHarness({
 *   a2aUrl: 'http://localhost:3001',
 *   agents: [archetypeAgent],
 *   archetypes: [getArchetype('trader'), getArchetype('degen')],
 *   instancesPerAgent: 2,
 *   ticksPerAgent: 10,
 *   parallelAgents: 4,
 *   recordTrajectories: true,
 *   outputDir: './trajectories'
 * });
 * ```
 */

/**
 * Agent Training Harness
 *
 * A framework for running and training agents against Feed's prediction
 * markets. Supports multiple backends:
 *   - Local A2A server (localhost:3001, JSON-RPC)
 *   - Production server (localhost:3000 or feed.market, official A2A SDK)
 *   - Offline simulation (no server required, uses engine's InMemoryStateStore)
 *
 * Built-in agents:
 *   - RandomAgent        — stochastic baseline
 *   - ArchetypeAgent     — rule-based, archetype-influenced
 *   - LLMAgent           — real LLM decisions (Groq/OpenAI/Anthropic)
 *
 * External framework adapters:
 *   - HermesAdapter      — NousResearch Hermes via Python bridge
 *   - OpenClawAdapter    — OpenClaw personal assistant via CLI or gateway
 *
 * @example
 * ```typescript
 * import { runHarness, createLLMAgent, getArchetype } from '@feed/agent-harness';
 *
 * const result = await runHarness({
 *   a2aUrl: 'http://localhost:3001',
 *   agents: [createLLMAgent({ provider: 'groq' })],
 *   archetypes: [getArchetype('trader')],
 *   instancesPerAgent: 1,
 *   ticksPerAgent: 10,
 *   parallelAgents: 4,
 *   recordTrajectories: true,
 *   outputDir: './trajectories',
 * });
 * ```
 */

// ─── A2A Clients ─────────────────────────────────────────────────────────────
export { HarnessA2AClient } from './a2a-client';
export type { HermesAdapterConfig } from './adapters/hermes-adapter';
// ─── External Framework Adapters ─────────────────────────────────────────────
export { createHermesAdapter, HermesAdapter } from './adapters/hermes-adapter';
export type {
  OpenClawAdapterConfig,
  OpenClawMode,
} from './adapters/openclaw-adapter';
export {
  createOpenClawAdapter,
  OpenClawAdapter,
} from './adapters/openclaw-adapter';
// ─── Built-in Agents ─────────────────────────────────────────────────────────
export { ArchetypeAgent, archetypeAgent } from './agents/archetype-agent';
export type { LLMAgentConfig, LLMProvider } from './agents/llm-agent';
export { createLLMAgent, LLMAgent } from './agents/llm-agent';
export { RandomAgent, randomAgent } from './agents/random-agent';
// ─── Archetypes ───────────────────────────────────────────────────────────────
export {
  ARCHETYPES,
  getAllArchetypes,
  getArchetype,
  getArchetypeIds,
} from './archetypes';
// ─── Core Harness ─────────────────────────────────────────────────────────────
export { AgentHarness, runHarness } from './harness';
// ─── Simulation Adapter (offline, no server needed) ──────────────────────────
export type { SimulationConfig, SimulationTickResult } from './offline-adapter';
export { OfflineGameAdapter, SimulationAdapter } from './offline-adapter';
export type { FeedProductionClientConfig } from './production-client';
export { FeedProductionClient } from './production-client';
export type {
  GameState,
  SimulationEngineInterface,
} from './simulation-adapter';
export { SimulationA2AAdapter } from './simulation-adapter';

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  A2AClientInterface,
  ActionResult,
  ActionType,
  AgentConfig,
  AgentContext,
  AgentDecision,
  ArchetypeConfig,
  ArchetypeTraits,
  ClientFactory,
  HarnessConfig,
  HarnessResult,
  Market,
  Position,
  Post,
  Trade,
  TrainableAgent,
  Trajectory,
  TrajectoryStep,
} from './types';
