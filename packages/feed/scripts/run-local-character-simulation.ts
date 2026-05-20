#!/usr/bin/env bun

import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  agentRuntimeManager,
  autonomousCoordinator,
  createTestAgent,
} from '@babylon/agents';
import { db, eq, users } from '@babylon/db';
import { executeGameTick } from '@babylon/engine';
import { sleep } from '@babylon/shared';
import type { IAgentRuntime } from '@elizaos/core';
import { config as loadDotenv } from 'dotenv';
import {
  type BabylonCharacterSheet,
  buildCanonicalSimulationRoster,
  type CharacterMessageExampleTurn,
  writeLocalCharacterSheets,
} from '../packages/agents/src/character-roster/local-roster';
import { upsertAgentConfig } from '../packages/agents/src/shared/agent-config';

loadDotenv({ path: path.resolve(process.cwd(), '.env') });
loadDotenv({ path: path.resolve(process.cwd(), '.env.local') });

interface SimulationOptions {
  agentTicks: number;
  worldTicks: number;
  parallel: number;
  delayMs: number;
}

interface AgentTickSummary {
  agentId: string;
  username: string;
  success: boolean;
  trajectoryId?: string;
  error?: string;
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

function parseSimulationOptions(): SimulationOptions {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      'agent-ticks': { type: 'string', default: '1' },
      'world-ticks': { type: 'string', default: '1' },
      parallel: { type: 'string', default: '5' },
      delay: { type: 'string', default: '350' },
    },
    strict: true,
    allowPositionals: false,
  });

  const agentTicks = parseInt(values['agent-ticks'], 10);
  const worldTicks = parseInt(values['world-ticks'], 10);
  const parallel = parseInt(values.parallel, 10);
  const delayMs = parseInt(values.delay, 10);

  return {
    agentTicks: Number.isFinite(agentTicks) && agentTicks > 0 ? agentTicks : 1,
    worldTicks: Number.isFinite(worldTicks) && worldTicks > 0 ? worldTicks : 1,
    parallel: Number.isFinite(parallel) && parallel > 0 ? parallel : 5,
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 350,
  };
}

function inferModelTier(sheet: BabylonCharacterSheet): 'free' | 'pro' {
  return sheet.settings.groq.large.startsWith('llama-') ? 'free' : 'pro';
}

function buildAgentPersonalitySummary(sheet: BabylonCharacterSheet): string {
  return [
    `${sheet.babylon.alignment} ${sheet.babylon.team} posture`,
    sheet.babylon.socialStyle,
    `scam:${sheet.babylon.scamProfile.replaceAll('_', ' ')}`,
    `caution:${sheet.babylon.caution}`,
    `deception:${sheet.babylon.deception}`,
  ].join(' | ');
}

function buildConfigStyle(sheet: BabylonCharacterSheet) {
  return {
    all: sheet.style.all,
    chat: sheet.style.chat,
    post: sheet.style.post,
    babylon: {
      sheetId: sheet.id,
      username: sheet.username,
      bio: sheet.bio,
      lore: sheet.lore,
      topics: sheet.topics,
      adjectives: sheet.adjectives,
      postExamples: sheet.postExamples,
      models: sheet.settings.groq,
      metadata: sheet.babylon,
    },
  };
}

async function ensureCharacterAgent(
  sheet: BabylonCharacterSheet
): Promise<{ agentId: string; username: string }> {
  const result = await createTestAgent(sheet.id, {
    username: sheet.username,
    displayName: sheet.name,
    virtualBalance: 25000,
    autonomousTrading: sheet.babylon.autonomy.trading,
    autonomousPosting: sheet.babylon.autonomy.posting,
    autonomousCommenting: sheet.babylon.autonomy.commenting,
    autonomousDMs: sheet.babylon.autonomy.dms,
    autonomousGroupChats: sheet.babylon.autonomy.groups,
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
    tradingStrategy: sheet.babylon.tradingStyle,
    style: buildConfigStyle(sheet),
    messageExamples: sheet.bio,
    personaPrompt: JSON.stringify(sheet),
    goals: {
      motivations: sheet.babylon.motivations,
      fears: sheet.babylon.fears,
      topics: sheet.topics,
    },
    directives: sheet.style.all,
    constraints: [
      `alignment:${sheet.babylon.alignment}`,
      `team:${sheet.babylon.team}`,
      `scam_profile:${sheet.babylon.scamProfile}`,
      `deception:${sheet.babylon.deception}`,
      `competence:${sheet.babylon.competence}`,
    ],
    planningHorizon: sheet.babylon.autonomy.groups
      ? sheet.babylon.autonomy.dms
        ? 'campaign'
        : sheet.babylon.team === 'gray'
          ? 'swing'
          : 'campaign'
      : 'single',
    riskTolerance:
      sheet.babylon.caution === 'paranoid'
        ? 'low'
        : sheet.babylon.caution === 'reckless'
          ? 'high'
          : sheet.settings.temperature > 0.75
            ? 'high'
            : sheet.settings.temperature < 0.6
              ? 'low'
              : 'medium',
    maxActionsPerTick:
      sheet.babylon.caution === 'paranoid'
        ? 2
        : sheet.babylon.caution === 'careful'
          ? 3
          : 5,
    modelTier: inferModelTier(sheet),
    autonomousTrading: sheet.babylon.autonomy.trading,
    autonomousPosting: sheet.babylon.autonomy.posting,
    autonomousCommenting: sheet.babylon.autonomy.commenting,
    autonomousDMs: sheet.babylon.autonomy.dms,
    autonomousGroupChats: sheet.babylon.autonomy.groups,
    a2aEnabled: false,
    updatedAt: new Date(),
  });

  return {
    agentId: result.agentId,
    username: result.agent.username,
  };
}

function applySheetToRuntime(
  runtime: IAgentRuntime,
  sheet: BabylonCharacterSheet
): void {
  const runtimeCharacter = runtime.character as RuntimeCharacter;
  runtimeCharacter.name = sheet.name;
  runtimeCharacter.system = sheet.system;
  runtimeCharacter.bio = [...sheet.bio];
  runtimeCharacter.username = sheet.username;
  runtimeCharacter.lore = [...sheet.lore];
  runtimeCharacter.topics = [...sheet.topics];
  runtimeCharacter.adjectives = [...sheet.adjectives];
  runtimeCharacter.postExamples = [...sheet.postExamples];
  runtimeCharacter.messageExamples = sheet.messageExamples;
  runtimeCharacter.style = buildConfigStyle(sheet);
  runtimeCharacter.settings = {
    ...(runtimeCharacter.settings || {}),
    GROQ_PRIMARY_MODEL: sheet.settings.groq.primary,
    GROQ_SMALL_MODEL: sheet.settings.groq.small,
    GROQ_LARGE_MODEL: sheet.settings.groq.large,
    MODEL_VERSION: sheet.settings.groq.primary,
    TEMPERATURE: String(sheet.settings.temperature),
    MAX_TOKENS: String(sheet.settings.maxTokens),
  };

  const runtimeWithSettings = runtime as RuntimeWithSettings;
  runtimeWithSettings.settings = {
    ...(runtimeWithSettings.settings || {}),
    GROQ_PRIMARY_MODEL: sheet.settings.groq.primary,
    GROQ_SMALL_MODEL: sheet.settings.groq.small,
    GROQ_LARGE_MODEL: sheet.settings.groq.large,
  };
}

async function executeAgentTick(
  sheet: BabylonCharacterSheet,
  agentId: string
): Promise<AgentTickSummary> {
  try {
    const runtime = await agentRuntimeManager.getRuntime(agentId);
    applySheetToRuntime(runtime, sheet);

    const result = await autonomousCoordinator.executeAutonomousTick(
      agentId,
      runtime,
      true
    );

    return {
      agentId,
      username: sheet.username,
      success: result.success,
      trajectoryId: result.trajectoryId,
      error: result.error,
    };
  } catch (error) {
    return {
      agentId,
      username: sheet.username,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runAgentTickRound(
  roster: BabylonCharacterSheet[],
  idByCharacterId: Map<string, string>,
  parallel: number,
  delayMs: number
): Promise<AgentTickSummary[]> {
  const summaries: AgentTickSummary[] = [];

  for (let index = 0; index < roster.length; index += parallel) {
    const batch = roster.slice(index, index + parallel);
    const batchResults = await Promise.all(
      batch.map(async (sheet) => {
        const agentId = idByCharacterId.get(sheet.id);
        if (!agentId) {
          return {
            agentId: '',
            username: sheet.username,
            success: false,
            error: `Missing agent for character ${sheet.id}`,
          } satisfies AgentTickSummary;
        }

        return executeAgentTick(sheet, agentId);
      })
    );

    summaries.push(...batchResults);

    if (index + parallel < roster.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return summaries;
}

async function main(): Promise<void> {
  const options = parseSimulationOptions();
  const roster = buildCanonicalSimulationRoster();
  await writeLocalCharacterSheets();

  console.log('Preparing local character roster...');
  console.log(`Character count: ${roster.length} canonical characters`);
  console.log(
    `Simulation plan: ${options.worldTicks} world tick(s), ${options.agentTicks} agent tick round(s), parallel=${options.parallel}`
  );
  console.log('');

  const idByCharacterId = new Map<string, string>();

  for (const sheet of roster) {
    const agent = await ensureCharacterAgent(sheet);
    idByCharacterId.set(sheet.id, agent.agentId);
    console.log(
      `Ready: ${sheet.name} (@${sheet.username}) -> ${agent.agentId} | ${sheet.settings.groq.primary}`
    );
  }

  console.log('');
  console.log('Warming game state...');
  for (let tickIndex = 0; tickIndex < options.worldTicks; tickIndex++) {
    const tickResult = await executeGameTick(false);
    console.log(
      `World tick ${tickIndex + 1}/${options.worldTicks}: posts=${tickResult.postsCreated} events=${tickResult.eventsCreated} markets=${tickResult.marketsUpdated} questions=${tickResult.questionsCreated}`
    );
  }

  let allSummaries: AgentTickSummary[] = [];

  for (let roundIndex = 0; roundIndex < options.agentTicks; roundIndex++) {
    console.log('');
    console.log(
      `Agent round ${roundIndex + 1}/${options.agentTicks} running for ${roster.length} characters...`
    );

    const roundSummaries = await runAgentTickRound(
      roster,
      idByCharacterId,
      options.parallel,
      options.delayMs
    );
    allSummaries = allSummaries.concat(roundSummaries);

    const successful = roundSummaries.filter((item) => item.success).length;
    const failed = roundSummaries.length - successful;
    const withTrajectory = roundSummaries.filter(
      (item) => item.trajectoryId
    ).length;

    console.log(
      `Round ${roundIndex + 1} complete: success=${successful} failed=${failed} trajectories=${withTrajectory}`
    );
  }

  const totalSuccess = allSummaries.filter((item) => item.success).length;
  const totalFailures = allSummaries.length - totalSuccess;
  const totalTrajectories = allSummaries.filter(
    (item) => item.trajectoryId
  ).length;

  console.log('');
  console.log('Simulation summary');
  console.log(`  Characters: ${roster.length}`);
  console.log(`  Agent tick attempts: ${allSummaries.length}`);
  console.log(`  Successful ticks: ${totalSuccess}`);
  console.log(`  Failed ticks: ${totalFailures}`);
  console.log(`  Trajectories captured: ${totalTrajectories}`);

  if (totalFailures > 0) {
    console.log('');
    console.log('Failures');
    for (const summary of allSummaries.filter((item) => !item.success)) {
      console.log(
        `  @${summary.username}: ${summary.error || 'unknown error'}`
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
