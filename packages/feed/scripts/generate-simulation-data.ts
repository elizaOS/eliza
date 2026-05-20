#!/usr/bin/env bun

/**
 * Generate Simulation Data
 *
 * Unified command to run N hours of Feed simulation and export EVERYTHING
 * to reviewable files: all LLM inputs/outputs, agent trajectories, world
 * narratives, actor state, NPC decisions, posts, trades, messages.
 *
 * Usage:
 *   bun run sim:generate -- --hours=2                        # 2 hours (40 cycles)
 *   bun run sim:generate -- --ticks=10 --parallel=5          # 10 cycles, 5 agents at once
 *   bun run sim:generate -- --ticks=20 --fast                # fast: skip world ticks entirely
 *   bun run sim:generate -- --ticks=10 --world-tick-every=5  # world tick every 5th cycle
 *   bun run sim:generate -- --ticks=5 --delay=200            # faster batching (200ms between)
 *
 * Speed guide:
 *   --fast                Skip world ticks (saves ~10-30s per cycle)
 *   --world-tick-every=N  Run world tick only every Nth cycle (default: 3)
 *   --delay=200           Reduce inter-batch delay (default: 500ms, was 2000ms)
 *   --parallel=8          Increase batch size (default: 5, limited by Groq rate limit)
 *
 * Output: runs/simulation-data/<timestamp>/
 *
 * Mapping: 1 hour ≈ 20 tick cycles (each cycle = 1 world tick + 1 agent round).
 * Override with --ticks-per-hour=N.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  agentRuntimeManager,
  autonomousCoordinator,
  createTestAgent,
} from '@feed/agents';
import {
  db,
  desc,
  eq,
  gte,
  inArray,
  llmCallLogs,
  posts,
  trajectories,
  users,
  worldEvents,
} from '@feed/db';
import { executeGameTick } from '@feed/engine';
import { sleep } from '@feed/shared';
import type { IAgentRuntime } from '@elizaos/core';
import { config as loadDotenv } from 'dotenv';
import {
  type FeedCharacterSheet,
  buildCanonicalSimulationRoster,
  type CharacterMessageExampleTurn,
  writeLocalCharacterSheets,
} from '../packages/agents/src/character-roster/local-roster';
import { upsertAgentConfig } from '../packages/agents/src/shared/agent-config';
import {
  getLLMCallCallback,
  type LLMCallInput,
  setLLMCallCallback,
} from '../packages/engine/src/dag-trace';

loadDotenv({ path: path.resolve(process.cwd(), '.env') });
loadDotenv({ path: path.resolve(process.cwd(), '.env.local') });

// Force trajectory recording and enable posting
process.env.RECORD_AGENT_TRAJECTORIES = 'true';
process.env.FEED_ENABLE_PLAYER_POSTING = '1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SimOptions {
  hours: number;
  ticks: number;
  ticksPerHour: number;
  parallel: number;
  delayMs: number;
  outputDir: string;
  fast: boolean;
  worldTickEvery: number;
}

interface AgentTickResult {
  agentId: string;
  username: string;
  characterId: string;
  success: boolean;
  trajectoryId?: string;
  error?: string;
  durationMs: number;
}

interface CycleSummary {
  cycleNumber: number;
  worldTick: {
    durationMs: number;
    postsCreated: number;
    eventsCreated: number;
    marketsUpdated: number;
    questionsCreated: number;
  };
  agentRound: {
    durationMs: number;
    total: number;
    successful: number;
    failed: number;
    trajectoriesCaptured: number;
    results: AgentTickResult[];
  };
  llmCallsInCycle: number;
}

type RuntimeCharacter = IAgentRuntime['character'] & {
  username?: string;
  lore?: string[];
  topics?: string[];
  adjectives?: string[];
  postExamples?: string[];
  messageExamples?: CharacterMessageExampleTurn[][];
  settings?: Record<string, string | number>;
};

type RuntimeWithSettings = IAgentRuntime & {
  settings?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseOptions(): SimOptions {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      hours: { type: 'string', default: '1' },
      ticks: { type: 'string', default: '0' },
      'ticks-per-hour': { type: 'string', default: '20' },
      parallel: { type: 'string', default: '5' },
      delay: { type: 'string', default: '500' },
      fast: { type: 'boolean', default: false },
      'world-tick-every': { type: 'string', default: '3' },
      output: { type: 'string', default: '' },
    },
    strict: true,
    allowPositionals: false,
  });

  const hours = Math.max(0, parseFloat(values.hours ?? '1'));
  const ticksPerHour = Math.max(
    1,
    parseInt(values['ticks-per-hour'] ?? '20', 10)
  );
  const explicitTicks = parseInt(values.ticks ?? '0', 10);
  const ticks =
    explicitTicks > 0
      ? explicitTicks
      : Math.max(1, Math.round(hours * ticksPerHour));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultDir = path.resolve(
    process.cwd(),
    'runs',
    'simulation-data',
    stamp
  );

  return {
    hours,
    ticks,
    ticksPerHour,
    parallel: Math.max(1, parseInt(values.parallel ?? '5', 10)),
    delayMs: Math.max(0, parseInt(values.delay ?? '500', 10)),
    fast: values.fast ?? false,
    worldTickEvery: Math.max(
      1,
      parseInt(values['world-tick-every'] ?? '3', 10)
    ),
    outputDir: values.output
      ? path.resolve(process.cwd(), values.output)
      : defaultDir,
  };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function appendJsonl(filePath: string, record: unknown): void {
  writeFileSync(filePath, JSON.stringify(record) + '\n', { flag: 'a' });
}

// ---------------------------------------------------------------------------
// Character / agent setup (mirrors run-local-character-simulation.ts)
// ---------------------------------------------------------------------------

function inferModelTier(sheet: FeedCharacterSheet): 'free' | 'pro' {
  return sheet.settings.groq.large.startsWith('llama-') ? 'free' : 'pro';
}

function buildAgentPersonalitySummary(sheet: FeedCharacterSheet): string {
  return [
    `${sheet.feed.alignment} ${sheet.feed.team} posture`,
    sheet.feed.socialStyle,
    `scam:${sheet.feed.scamProfile.replaceAll('_', ' ')}`,
    `caution:${sheet.feed.caution}`,
    `deception:${sheet.feed.deception}`,
  ].join(' | ');
}

function buildConfigStyle(sheet: FeedCharacterSheet) {
  return {
    all: sheet.style.all,
    chat: sheet.style.chat,
    post: sheet.style.post,
    feed: {
      sheetId: sheet.id,
      username: sheet.username,
      bio: sheet.bio,
      lore: sheet.lore,
      topics: sheet.topics,
      adjectives: sheet.adjectives,
      postExamples: sheet.postExamples,
      models: sheet.settings.groq,
      metadata: sheet.feed,
    },
  };
}

async function ensureCharacterAgent(
  sheet: FeedCharacterSheet
): Promise<{ agentId: string; username: string }> {
  const result = await createTestAgent(sheet.id, {
    username: sheet.username,
    displayName: sheet.name,
    virtualBalance: 25000,
    autonomousTrading: sheet.feed.autonomy.trading,
    autonomousPosting: sheet.feed.autonomy.posting,
    autonomousCommenting: sheet.feed.autonomy.commenting,
    autonomousDMs: sheet.feed.autonomy.dms,
    autonomousGroupChats: sheet.feed.autonomy.groups,
    systemPrompt: sheet.system,
  });

  await db
    .update(users)
    .set({
      displayName: sheet.name,
      bio: sheet.bio.join('\n'),
      updatedAt: new Date(),
    })
    .where(eq(users.id, result.agentId));

  await upsertAgentConfig(result.agentId, {
    systemPrompt: sheet.system,
    personality: buildAgentPersonalitySummary(sheet),
    tradingStrategy: sheet.feed.tradingStyle,
    style: buildConfigStyle(sheet),
    messageExamples: sheet.messageExamples,
    personaPrompt: JSON.stringify(sheet),
    goals: {
      motivations: sheet.feed.motivations,
      fears: sheet.feed.fears,
      topics: sheet.topics,
    },
    directives: sheet.style.all,
    constraints: [
      `alignment:${sheet.feed.alignment}`,
      `team:${sheet.feed.team}`,
      `scam_profile:${sheet.feed.scamProfile}`,
      `deception:${sheet.feed.deception}`,
      `competence:${sheet.feed.competence}`,
    ],
    planningHorizon: sheet.feed.autonomy.groups
      ? sheet.feed.autonomy.dms
        ? 'campaign'
        : sheet.feed.team === 'gray'
          ? 'swing'
          : 'campaign'
      : 'single',
    riskTolerance:
      sheet.feed.caution === 'paranoid'
        ? 'low'
        : sheet.feed.caution === 'reckless'
          ? 'high'
          : sheet.settings.temperature > 0.75
            ? 'high'
            : sheet.settings.temperature < 0.6
              ? 'low'
              : 'medium',
    maxActionsPerTick:
      sheet.feed.caution === 'paranoid'
        ? 2
        : sheet.feed.caution === 'careful'
          ? 3
          : 5,
    modelTier: inferModelTier(sheet),
    autonomousTrading: sheet.feed.autonomy.trading,
    autonomousPosting: sheet.feed.autonomy.posting,
    autonomousCommenting: sheet.feed.autonomy.commenting,
    autonomousDMs: sheet.feed.autonomy.dms,
    autonomousGroupChats: sheet.feed.autonomy.groups,
    a2aEnabled: false,
    updatedAt: new Date(),
  });

  return { agentId: result.agentId, username: result.agent.username };
}

function applySheetToRuntime(
  runtime: IAgentRuntime,
  sheet: FeedCharacterSheet
): void {
  const rc = runtime.character as RuntimeCharacter;
  rc.name = sheet.name;
  rc.system = sheet.system;
  rc.bio = [...sheet.bio];
  rc.username = sheet.username;
  rc.lore = [...sheet.lore];
  rc.topics = [...sheet.topics];
  rc.adjectives = [...sheet.adjectives];
  rc.postExamples = [...sheet.postExamples];
  rc.messageExamples = sheet.messageExamples;
  rc.style = buildConfigStyle(sheet);
  rc.settings = {
    ...(rc.settings || {}),
    GROQ_PRIMARY_MODEL: sheet.settings.groq.primary,
    GROQ_SMALL_MODEL: sheet.settings.groq.small,
    GROQ_LARGE_MODEL: sheet.settings.groq.large,
    MODEL_VERSION: sheet.settings.groq.primary,
    TEMPERATURE: String(sheet.settings.temperature),
    MAX_TOKENS: String(sheet.settings.maxTokens),
  };
  const rws = runtime as RuntimeWithSettings;
  rws.settings = {
    ...(rws.settings || {}),
    GROQ_PRIMARY_MODEL: sheet.settings.groq.primary,
    GROQ_SMALL_MODEL: sheet.settings.groq.small,
    GROQ_LARGE_MODEL: sheet.settings.groq.large,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseOptions();
  const runStartedAt = new Date();

  console.log('='.repeat(72));
  console.log('  FEED SIMULATION DATA GENERATOR');
  console.log('='.repeat(72));
  console.log(`  Hours requested : ${opts.hours}`);
  console.log(`  Total cycles    : ${opts.ticks}`);
  console.log(`  Ticks per hour  : ${opts.ticksPerHour}`);
  console.log(`  Parallelism     : ${opts.parallel}`);
  console.log(`  Delay (ms)      : ${opts.delayMs}`);
  console.log(
    `  Fast mode       : ${opts.fast ? 'YES (no world ticks)' : 'no'}`
  );
  console.log(
    `  World tick every: ${opts.fast ? 'N/A' : `${opts.worldTickEvery} cycles`}`
  );
  console.log(`  Output dir      : ${opts.outputDir}`);
  console.log('='.repeat(72));
  console.log('');

  // Create output directories
  const dirs = {
    root: opts.outputDir,
    actors: path.join(opts.outputDir, 'actors'),
    worldTicks: path.join(opts.outputDir, 'world-ticks'),
    agentTicks: path.join(opts.outputDir, 'agent-ticks'),
    llmCalls: path.join(opts.outputDir, 'llm-calls'),
    narratives: path.join(opts.outputDir, 'narratives'),
    trajectories: path.join(opts.outputDir, 'trajectories'),
  };
  for (const dir of Object.values(dirs)) {
    ensureDir(dir);
  }

  // Initialize JSONL files (empty)
  const jsonlFiles = {
    llmCallsAll: path.join(dirs.root, 'llm-calls-all.jsonl'),
    posts: path.join(dirs.narratives, 'posts.jsonl'),
    events: path.join(dirs.narratives, 'events.jsonl'),
    trades: path.join(dirs.narratives, 'trades.jsonl'),
    agentActions: path.join(dirs.narratives, 'agent-actions.jsonl'),
    trajectoriesAll: path.join(dirs.root, 'trajectories-all.jsonl'),
  };

  // -----------------------------------------------------------------------
  // LLM call capture - intercept engine LLM calls (world tick phase)
  // Agent LLM calls are captured separately via the trajectory DB.
  // -----------------------------------------------------------------------
  let llmCallSequence = 0;
  let currentCycle = 0;
  let engineTokens = 0;
  const enginePromptTypes: Record<string, number> = {};
  const engineModels: Record<string, number> = {};

  const priorCallback = getLLMCallCallback();
  setLLMCallCallback((call: LLMCallInput) => {
    llmCallSequence++;

    const captured = {
      ...call,
      capturedAt: new Date().toISOString(),
      source: 'engine',
      sequenceNumber: llmCallSequence,
      cycleNumber: currentCycle,
    };

    engineTokens += call.totalTokens || 0;
    const pt = call.promptType || 'unknown';
    enginePromptTypes[pt] = (enginePromptTypes[pt] || 0) + 1;
    const mdl = call.model || 'unknown';
    engineModels[mdl] = (engineModels[mdl] || 0) + 1;

    // Write individual LLM call file
    const callFileName = `${String(llmCallSequence).padStart(6, '0')}-${call.promptType || 'unknown'}.json`;
    writeJson(path.join(dirs.llmCalls, callFileName), captured);

    // Append to master JSONL
    appendJsonl(jsonlFiles.llmCallsAll, captured);

    // Forward to any prior callback
    priorCallback?.(call);
  });

  // -----------------------------------------------------------------------
  // Build character roster and create agents
  // -----------------------------------------------------------------------
  console.log('Loading character roster...');
  const roster = buildCanonicalSimulationRoster();
  await writeLocalCharacterSheets();

  console.log(`Characters: ${roster.length} canonical agents`);
  console.log('');

  // Write all actor/character sheets
  for (const sheet of roster) {
    writeJson(path.join(dirs.actors, `${sheet.id}.json`), {
      characterSheet: sheet,
      summary: {
        name: sheet.name,
        username: sheet.username,
        alignment: sheet.feed.alignment,
        team: sheet.feed.team,
        scamProfile: sheet.feed.scamProfile,
        competence: sheet.feed.competence,
        caution: sheet.feed.caution,
        deception: sheet.feed.deception,
        socialStyle: sheet.feed.socialStyle,
        tradingStyle: sheet.feed.tradingStyle,
        autonomy: sheet.feed.autonomy,
        model: sheet.settings.groq.primary,
        temperature: sheet.settings.temperature,
      },
    });
  }

  // Create/ensure agents in DB
  const idByCharacterId = new Map<string, string>();
  const usernameByAgentId = new Map<string, string>();

  for (const sheet of roster) {
    try {
      const agent = await ensureCharacterAgent(sheet);
      idByCharacterId.set(sheet.id, agent.agentId);
      usernameByAgentId.set(agent.agentId, agent.username);
      console.log(
        `  Ready: ${sheet.name} (@${sheet.username}) -> ${agent.agentId}`
      );
    } catch (err) {
      console.error(`  FAILED to create agent for ${sheet.name}: ${err}`);
    }
  }

  console.log('');

  // -----------------------------------------------------------------------
  // Run simulation cycles
  // -----------------------------------------------------------------------
  const cycleSummaries: CycleSummary[] = [];
  const allTrajectoryIds: string[] = [];

  for (let cycle = 1; cycle <= opts.ticks; cycle++) {
    currentCycle = cycle;
    const llmCallsBefore = llmCallSequence;

    console.log(`--- Cycle ${cycle}/${opts.ticks} ---`);

    // --- World tick (skip in --fast mode, or only run every N cycles) ---
    const runWorldTick =
      !opts.fast && (cycle === 1 || cycle % opts.worldTickEvery === 0);

    const worldStart = Date.now();
    let worldResult = {
      postsCreated: 0,
      eventsCreated: 0,
      marketsUpdated: 0,
      questionsCreated: 0,
    };

    if (!runWorldTick) {
      console.log('  World: skipped');
    }

    try {
      if (!runWorldTick) throw null; // skip to catch
      const tickResult = await executeGameTick(false);
      worldResult = {
        postsCreated: tickResult.postsCreated ?? 0,
        eventsCreated: tickResult.eventsCreated ?? 0,
        marketsUpdated: tickResult.marketsUpdated ?? 0,
        questionsCreated: tickResult.questionsCreated ?? 0,
      };

      // Write world tick result
      writeJson(
        path.join(
          dirs.worldTicks,
          `cycle-${String(cycle).padStart(4, '0')}.json`
        ),
        {
          cycle,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - worldStart,
          result: tickResult,
        }
      );

      console.log(
        `  World: posts=${worldResult.postsCreated} events=${worldResult.eventsCreated} ` +
          `markets=${worldResult.marketsUpdated} questions=${worldResult.questionsCreated} ` +
          `(${Date.now() - worldStart}ms)`
      );
    } catch (err) {
      if (err !== null) {
        console.error(`  World tick FAILED: ${err}`);
        writeJson(
          path.join(
            dirs.worldTicks,
            `cycle-${String(cycle).padStart(4, '0')}.json`
          ),
          { cycle, error: String(err), timestamp: new Date().toISOString() }
        );
      }
    }
    const worldDurationMs = Date.now() - worldStart;

    // --- Agent tick round ---
    const agentStart = Date.now();
    const agentResults: AgentTickResult[] = [];
    const cycleTrajectoryIds: string[] = [];

    const roundDir = path.join(
      dirs.agentTicks,
      `round-${String(cycle).padStart(4, '0')}`
    );
    ensureDir(roundDir);

    for (
      let batchStart = 0;
      batchStart < roster.length;
      batchStart += opts.parallel
    ) {
      const batch = roster.slice(batchStart, batchStart + opts.parallel);

      const batchResults = await Promise.all(
        batch.map(async (sheet) => {
          const agentId = idByCharacterId.get(sheet.id);
          if (!agentId) {
            return {
              agentId: '',
              username: sheet.username,
              characterId: sheet.id,
              success: false,
              error: `No agent created for ${sheet.id}`,
              durationMs: 0,
            } satisfies AgentTickResult;
          }

          const tickStart = Date.now();
          try {
            const runtime = await agentRuntimeManager.getRuntime(agentId);
            applySheetToRuntime(runtime, sheet);

            const result = await autonomousCoordinator.executeAutonomousTick(
              agentId,
              runtime,
              true // capture trajectory
            );

            const tickResult: AgentTickResult = {
              agentId,
              username: sheet.username,
              characterId: sheet.id,
              success: result.success,
              trajectoryId: result.trajectoryId,
              error: result.error,
              durationMs: Date.now() - tickStart,
            };

            if (result.trajectoryId) {
              cycleTrajectoryIds.push(result.trajectoryId);
            }

            // Write individual agent tick result
            writeJson(path.join(roundDir, `${sheet.username}.json`), {
              ...tickResult,
              characterSheet: sheet.id,
              timestamp: new Date().toISOString(),
            });

            return tickResult;
          } catch (err) {
            const tickResult: AgentTickResult = {
              agentId,
              username: sheet.username,
              characterId: sheet.id,
              success: false,
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - tickStart,
            };
            writeJson(path.join(roundDir, `${sheet.username}.json`), {
              ...tickResult,
              timestamp: new Date().toISOString(),
            });
            return tickResult;
          }
        })
      );

      agentResults.push(...batchResults);

      if (batchStart + opts.parallel < roster.length && opts.delayMs > 0) {
        await sleep(opts.delayMs);
      }
    }

    const agentSuccessful = agentResults.filter((r) => r.success).length;
    const agentWithTrajectory = agentResults.filter(
      (r) => r.trajectoryId
    ).length;
    const agentDurationMs = Date.now() - agentStart;

    console.log(
      `  Agents: ${agentSuccessful}/${agentResults.length} ok, ` +
        `${agentWithTrajectory} trajectories (${agentDurationMs}ms)`
    );

    allTrajectoryIds.push(...cycleTrajectoryIds);

    // Cycle summary
    const llmCallsInCycle = llmCallSequence - llmCallsBefore;
    const summary: CycleSummary = {
      cycleNumber: cycle,
      worldTick: { durationMs: worldDurationMs, ...worldResult },
      agentRound: {
        durationMs: agentDurationMs,
        total: agentResults.length,
        successful: agentSuccessful,
        failed: agentResults.length - agentSuccessful,
        trajectoriesCaptured: agentWithTrajectory,
        results: agentResults,
      },
      llmCallsInCycle,
    };
    cycleSummaries.push(summary);

    console.log(`  LLM calls this cycle: ${llmCallsInCycle}`);
    console.log('');
  }

  // -----------------------------------------------------------------------
  // Export trajectories from DB
  // -----------------------------------------------------------------------
  console.log('Exporting trajectory data from database...');

  if (allTrajectoryIds.length > 0) {
    try {
      const trajectoryRows = await db
        .select()
        .from(trajectories)
        .where(inArray(trajectories.trajectoryId, allTrajectoryIds))
        .orderBy(desc(trajectories.createdAt));

      for (const row of trajectoryRows) {
        const username = usernameByAgentId.get(row.agentId) ?? row.agentId;
        writeJson(
          path.join(dirs.trajectories, `${username}-${row.trajectoryId}.json`),
          row
        );
        appendJsonl(jsonlFiles.trajectoriesAll, row);
      }
      console.log(`  Trajectories exported: ${trajectoryRows.length}`);

      // Export linked LLM call logs from DB
      const dbLlmCalls = await db
        .select()
        .from(llmCallLogs)
        .where(inArray(llmCallLogs.trajectoryId, allTrajectoryIds))
        .orderBy(desc(llmCallLogs.createdAt));

      if (dbLlmCalls.length > 0) {
        const dbLlmCallsFile = path.join(dirs.root, 'db-llm-call-logs.jsonl');
        for (const row of dbLlmCalls) {
          appendJsonl(dbLlmCallsFile, row);
        }
        console.log(`  DB LLM call logs exported: ${dbLlmCalls.length}`);
      }
    } catch (err) {
      console.error(`  Failed to export trajectories: ${err}`);
    }
  }

  // -----------------------------------------------------------------------
  // Extract narratives from trajectories + DB
  // -----------------------------------------------------------------------
  console.log('Extracting narratives...');

  let narrativePosts = 0;
  let narrativeTrades = 0;
  let narrativeActions = 0;

  if (allTrajectoryIds.length > 0) {
    try {
      // Extract actions from trajectory stepsJson
      const trajectoryRows = await db
        .select({
          stepsJson: trajectories.stepsJson,
          agentId: trajectories.agentId,
          trajectoryId: trajectories.trajectoryId,
        })
        .from(trajectories)
        .where(inArray(trajectories.trajectoryId, allTrajectoryIds));

      for (const row of trajectoryRows) {
        try {
          const steps = JSON.parse(row.stepsJson);
          const username = usernameByAgentId.get(row.agentId) ?? row.agentId;
          for (const step of steps) {
            const action = step.action;
            if (!action) continue;

            narrativeActions++;
            appendJsonl(jsonlFiles.agentActions, {
              trajectoryId: row.trajectoryId,
              agentId: row.agentId,
              username,
              stepNumber: step.stepNumber,
              actionType: action.actionType,
              success: action.success,
              reasoning: action.reasoning,
              parameters: action.parameters,
              result: action.result,
              reward: step.reward,
              timestamp: step.timestamp,
            });

            if (action.actionType === 'TRADE' && action.success) {
              narrativeTrades++;
              appendJsonl(jsonlFiles.trades, {
                agentId: row.agentId,
                username,
                marketId: action.parameters?.marketId,
                side: action.parameters?.side,
                amount: action.parameters?.amount,
                shares: action.result?.shares,
                reasoning: action.reasoning,
                timestamp: step.timestamp,
              });
            }

            if (action.actionType === 'POST' && action.success) {
              narrativePosts++;
              appendJsonl(jsonlFiles.posts, {
                agentId: row.agentId,
                username,
                content: action.parameters?.content,
                postId: action.result?.postId,
                timestamp: step.timestamp,
              });
            }
          }
        } catch (parseErr) {
          console.warn(
            `  Skipped malformed stepsJson for trajectory ${row.trajectoryId}: ${parseErr}`
          );
        }
      }
      console.log(
        `  Actions: ${narrativeActions}, Trades: ${narrativeTrades}, Posts: ${narrativePosts}`
      );
    } catch (err) {
      console.error(`  Failed to extract narratives: ${err}`);
    }

    // Extract world events created during this run
    try {
      const eventRows = await db
        .select()
        .from(worldEvents)
        .where(gte(worldEvents.createdAt, runStartedAt))
        .orderBy(desc(worldEvents.createdAt));

      for (const row of eventRows) {
        appendJsonl(jsonlFiles.events, row);
      }
      if (eventRows.length > 0) {
        console.log(`  World events: ${eventRows.length}`);
      }
    } catch {
      /* worldEvents table may not exist */
    }

    // Extract posts created during this run
    try {
      const postRows = await db
        .select()
        .from(posts)
        .where(gte(posts.createdAt, runStartedAt))
        .orderBy(desc(posts.createdAt));

      for (const row of postRows) {
        appendJsonl(jsonlFiles.posts, row);
      }
      if (postRows.length > 0) {
        console.log(`  World posts: ${postRows.length}`);
      }
    } catch {
      /* posts table may not exist */
    }
  }

  // -----------------------------------------------------------------------
  // Write agent LLM calls from DB as individual files too
  // -----------------------------------------------------------------------
  let dbAgentLlmCallCount = 0;
  const agentLlmModels: Record<string, number> = {};
  const agentLlmPurposes: Record<string, number> = {};
  let agentLlmTotalTokens = 0;
  if (allTrajectoryIds.length > 0) {
    try {
      const agentLlmDir = path.join(dirs.llmCalls, 'agent');
      ensureDir(agentLlmDir);
      const dbCalls = await db
        .select()
        .from(llmCallLogs)
        .where(inArray(llmCallLogs.trajectoryId, allTrajectoryIds))
        .orderBy(llmCallLogs.timestamp);

      for (const call of dbCalls) {
        dbAgentLlmCallCount++;
        const model = call.model ?? 'unknown';
        const purpose = call.purpose ?? call.actionType ?? 'unknown';
        agentLlmModels[model] = (agentLlmModels[model] || 0) + 1;
        agentLlmPurposes[purpose] = (agentLlmPurposes[purpose] || 0) + 1;
        agentLlmTotalTokens +=
          (call.promptTokens ?? 0) + (call.completionTokens ?? 0);
        writeJson(
          path.join(
            agentLlmDir,
            `${String(dbAgentLlmCallCount).padStart(6, '0')}-${purpose}.json`
          ),
          call
        );
      }
      if (dbAgentLlmCallCount > 0) {
        console.log(
          `  Agent LLM calls written as individual files: ${dbAgentLlmCallCount}`
        );
      }
    } catch (err) {
      console.error(`  Failed to write agent LLM call files: ${err}`);
    }
  }

  // -----------------------------------------------------------------------
  // Restore callback
  // -----------------------------------------------------------------------
  setLLMCallCallback(priorCallback);

  // -----------------------------------------------------------------------
  // Write manifest and summary
  // -----------------------------------------------------------------------
  const runCompletedAt = new Date();
  const totalDurationMs = runCompletedAt.getTime() - runStartedAt.getTime();

  const totalSuccessful = cycleSummaries.reduce(
    (s, c) => s + c.agentRound.successful,
    0
  );
  const totalFailed = cycleSummaries.reduce(
    (s, c) => s + c.agentRound.failed,
    0
  );
  const totalTrajectories = allTrajectoryIds.length;

  const manifest = {
    version: '1.0.0',
    generatedAt: runCompletedAt.toISOString(),
    startedAt: runStartedAt.toISOString(),
    totalDurationMs,
    totalDurationHuman: `${Math.floor(totalDurationMs / 60000)}m ${Math.floor((totalDurationMs % 60000) / 1000)}s`,
    config: {
      hoursRequested: opts.hours,
      totalCycles: opts.ticks,
      ticksPerHour: opts.ticksPerHour,
      parallel: opts.parallel,
      delayMs: opts.delayMs,
    },
    stats: {
      characters: roster.length,
      totalCycles: cycleSummaries.length,
      totalAgentTickAttempts: totalSuccessful + totalFailed,
      totalAgentTickSuccesses: totalSuccessful,
      totalAgentTickFailures: totalFailed,
      totalTrajectoriesCaptured: totalTrajectories,
      totalLLMCalls: llmCallSequence + dbAgentLlmCallCount,
      engineLLMCalls: llmCallSequence,
      agentLLMCalls: dbAgentLlmCallCount,
      totalTokens: engineTokens + agentLlmTotalTokens,
      engineTokens,
      agentTokens: agentLlmTotalTokens,
      narratives: {
        totalActions: narrativeActions,
        trades: narrativeTrades,
        posts: narrativePosts,
      },
      engineLlmByPromptType: Object.fromEntries(
        Object.entries(enginePromptTypes).sort(([, a], [, b]) => b - a)
      ),
      agentLlmByPurpose: Object.fromEntries(
        Object.entries(agentLlmPurposes).sort(([, a], [, b]) => b - a)
      ),
      llmCallsByModel: Object.fromEntries(
        Object.entries({
          ...engineModels,
          ...Object.fromEntries(
            Object.entries(agentLlmModels).map(([k, v]) => [`${k} (agent)`, v])
          ),
        }).sort(([, a], [, b]) => b - a)
      ),
    },
    outputStructure: {
      'actors/': 'Character sheets and config for each agent',
      'world-ticks/': 'World tick results per cycle (posts, events, markets)',
      'agent-ticks/':
        'Per-agent tick results per cycle (trajectory IDs, success/fail)',
      'llm-calls/':
        'Individual JSON file for EVERY engine LLM call (full prompt + response)',
      'llm-calls/agent/':
        'Individual JSON file for EVERY agent LLM call (from trajectory DB)',
      'llm-calls-all.jsonl':
        'All LLM calls in JSONL (one per line, for grep/analysis)',
      'trajectories/': 'Full trajectory records exported from DB',
      'trajectories-all.jsonl': 'All trajectories in JSONL',
      'narratives/': 'Posts, events, trades, agent actions',
      'db-llm-call-logs.jsonl':
        'LLM call logs from DB (linked to trajectories)',
      'cycles.json': 'Per-cycle summary with timing and counts',
      'manifest.json': 'This file - run metadata and aggregate stats',
    },
  };

  writeJson(path.join(dirs.root, 'manifest.json'), manifest);
  writeJson(path.join(dirs.root, 'cycles.json'), cycleSummaries);

  // -----------------------------------------------------------------------
  // Final report
  // -----------------------------------------------------------------------
  console.log('='.repeat(72));
  console.log('  SIMULATION COMPLETE');
  console.log('='.repeat(72));
  console.log(`  Duration         : ${manifest.totalDurationHuman}`);
  console.log(`  Cycles completed : ${cycleSummaries.length}`);
  console.log(`  Characters       : ${roster.length}`);
  console.log(
    `  Agent ticks      : ${totalSuccessful} ok / ${totalFailed} failed`
  );
  console.log(`  Trajectories     : ${totalTrajectories}`);
  console.log(`  LLM calls total  : ${llmCallSequence + dbAgentLlmCallCount}`);
  console.log(`    Engine (world) : ${llmCallSequence}`);
  console.log(`    Agent (DB)     : ${dbAgentLlmCallCount}`);
  console.log(
    `  Total tokens     : ${manifest.stats.totalTokens.toLocaleString()}`
  );
  console.log(
    `  Actions          : ${narrativeActions} (${narrativeTrades} trades, ${narrativePosts} posts)`
  );
  console.log('');
  console.log(`  Output: ${opts.outputDir}`);
  console.log('='.repeat(72));
}

main().catch((err) => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
