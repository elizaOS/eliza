#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  and,
  db,
  desc,
  gte,
  inArray,
  llmCallLogs,
  rewardJudgments,
  trajectories,
  userAgentConfigs,
  users,
} from '@babylon/db';
import { config as loadDotenv } from 'dotenv';
import {
  type BabylonCharacterSheet,
  buildCanonicalSimulationRoster,
} from '../packages/agents/src/character-roster/local-roster';

loadDotenv({ path: path.resolve(process.cwd(), '.env') });
loadDotenv({ path: path.resolve(process.cwd(), '.env.local') });

interface ExportOptions {
  lookbackHours: number;
  outputDir: string;
}

interface CharacterAgentRecord {
  characterId: string;
  username: string;
  userId: string;
  displayName: string | null;
  createdAt: Date;
}

interface CharacterAgentCandidate {
  userId: string;
  username: string;
  displayName: string | null;
  createdAt: Date;
}

function parseExportOptions(): ExportOptions {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      'lookback-hours': { type: 'string', default: '24' },
      output: { type: 'string', default: 'training-data/local-character-sim' },
    },
    strict: true,
    allowPositionals: false,
  });

  const lookbackHours = parseInt(values['lookback-hours'], 10);

  return {
    lookbackHours:
      Number.isFinite(lookbackHours) && lookbackHours > 0 ? lookbackHours : 24,
    outputDir: path.resolve(process.cwd(), values.output),
  };
}

async function ensureDirectory(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

async function writeJsonFile(targetPath: string, value: object): Promise<void> {
  await writeFile(targetPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

async function writeJsonLines(
  targetPath: string,
  lines: object[]
): Promise<void> {
  const content = lines.map((line) => JSON.stringify(line)).join('\n');
  await writeFile(targetPath, `${content}${content ? '\n' : ''}`, 'utf-8');
}

async function getCharacterAgents(
  roster: BabylonCharacterSheet[],
  cutoff: Date
): Promise<CharacterAgentRecord[]> {
  const usernames = roster.map((sheet) => sheet.username);
  const userRows = await db
    .select({
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(inArray(users.username, usernames))
    .orderBy(desc(users.createdAt));

  const trajectoryCandidates =
    userRows.length > 0
      ? await db
          .select({
            agentId: trajectories.agentId,
            createdAt: trajectories.createdAt,
          })
          .from(trajectories)
          .where(
            and(
              inArray(
                trajectories.agentId,
                userRows.map((row) => row.userId)
              ),
              gte(trajectories.createdAt, cutoff)
            )
          )
      : [];

  const trajectoryStatsByAgentId = new Map<
    string,
    { count: number; latestCreatedAt: Date }
  >();
  for (const row of trajectoryCandidates) {
    const existing = trajectoryStatsByAgentId.get(row.agentId);
    if (!existing) {
      trajectoryStatsByAgentId.set(row.agentId, {
        count: 1,
        latestCreatedAt: row.createdAt,
      });
      continue;
    }

    existing.count += 1;
    if (row.createdAt > existing.latestCreatedAt) {
      existing.latestCreatedAt = row.createdAt;
    }
  }

  const candidatesByUsername = new Map<string, CharacterAgentCandidate[]>();
  for (const userRow of userRows) {
    const current = candidatesByUsername.get(userRow.username) ?? [];
    current.push(userRow);
    candidatesByUsername.set(userRow.username, current);
  }

  return roster.flatMap((sheet) => {
    const candidates = candidatesByUsername.get(sheet.username) ?? [];
    const userRow = [...candidates].sort((left, right) => {
      const leftStats = trajectoryStatsByAgentId.get(left.userId);
      const rightStats = trajectoryStatsByAgentId.get(right.userId);
      const leftCount = leftStats?.count ?? 0;
      const rightCount = rightStats?.count ?? 0;
      if (leftCount !== rightCount) {
        return rightCount - leftCount;
      }
      const leftLatest = leftStats?.latestCreatedAt?.getTime() ?? 0;
      const rightLatest = rightStats?.latestCreatedAt?.getTime() ?? 0;
      if (leftLatest !== rightLatest) {
        return rightLatest - leftLatest;
      }
      return right.createdAt.getTime() - left.createdAt.getTime();
    })[0];
    if (!userRow) {
      return [];
    }

    return [
      {
        characterId: sheet.id,
        username: sheet.username,
        userId: userRow.userId,
        displayName: userRow.displayName,
        createdAt: userRow.createdAt,
      },
    ];
  });
}

async function main(): Promise<void> {
  const options = parseExportOptions();
  const roster = buildCanonicalSimulationRoster();
  const characterSheetsDir = path.join(options.outputDir, 'character-sheets');
  const exportStamp = new Date().toISOString().replaceAll(':', '-');
  const exportDir = path.join(options.outputDir, exportStamp);
  const cutoff = new Date(Date.now() - options.lookbackHours * 60 * 60 * 1000);
  const characterAgents = await getCharacterAgents(roster, cutoff);

  await ensureDirectory(exportDir);
  await ensureDirectory(characterSheetsDir);

  for (const sheet of roster) {
    await writeJsonFile(
      path.join(characterSheetsDir, `${sheet.id}.json`),
      sheet
    );
  }

  const agentIds = characterAgents.map((record) => record.userId);

  if (agentIds.length === 0) {
    throw new Error('No canonical roster agents found in the current database');
  }

  const trajectoryRows = await db
    .select()
    .from(trajectories)
    .where(
      and(
        inArray(trajectories.agentId, agentIds),
        gte(trajectories.createdAt, cutoff)
      )
    )
    .orderBy(desc(trajectories.createdAt));

  const trajectoryIds = trajectoryRows.map((row) => row.trajectoryId);

  const llmCallRows =
    trajectoryIds.length > 0
      ? await db
          .select()
          .from(llmCallLogs)
          .where(inArray(llmCallLogs.trajectoryId, trajectoryIds))
          .orderBy(desc(llmCallLogs.createdAt))
      : [];

  const rewardRows =
    trajectoryIds.length > 0
      ? await db
          .select()
          .from(rewardJudgments)
          .where(inArray(rewardJudgments.trajectoryId, trajectoryIds))
          .orderBy(desc(rewardJudgments.judgedAt))
      : [];

  const configRows = await db
    .select({
      userId: userAgentConfigs.userId,
      systemPrompt: userAgentConfigs.systemPrompt,
      personality: userAgentConfigs.personality,
      tradingStrategy: userAgentConfigs.tradingStrategy,
      style: userAgentConfigs.style,
      messageExamples: userAgentConfigs.messageExamples,
      personaPrompt: userAgentConfigs.personaPrompt,
      goals: userAgentConfigs.goals,
      directives: userAgentConfigs.directives,
      constraints: userAgentConfigs.constraints,
      planningHorizon: userAgentConfigs.planningHorizon,
      riskTolerance: userAgentConfigs.riskTolerance,
      maxActionsPerTick: userAgentConfigs.maxActionsPerTick,
      modelTier: userAgentConfigs.modelTier,
      autonomousTrading: userAgentConfigs.autonomousTrading,
      autonomousPosting: userAgentConfigs.autonomousPosting,
      autonomousCommenting: userAgentConfigs.autonomousCommenting,
      autonomousDMs: userAgentConfigs.autonomousDMs,
      autonomousGroupChats: userAgentConfigs.autonomousGroupChats,
      updatedAt: userAgentConfigs.updatedAt,
    })
    .from(userAgentConfigs)
    .where(inArray(userAgentConfigs.userId, agentIds));

  await writeJsonFile(path.join(exportDir, 'manifest.json'), {
    exportedAt: new Date().toISOString(),
    lookbackHours: options.lookbackHours,
    canonicalCharacterCount: roster.length,
    matchedAgentCount: characterAgents.length,
    trajectoryCount: trajectoryRows.length,
    llmCallCount: llmCallRows.length,
    rewardJudgmentCount: rewardRows.length,
  });

  await writeJsonFile(path.join(exportDir, 'character-agents.json'), {
    characterAgents,
  });

  await writeJsonFile(path.join(exportDir, 'agent-configs.json'), {
    agentConfigs: configRows,
  });

  await writeJsonLines(
    path.join(exportDir, 'trajectories.jsonl'),
    trajectoryRows
  );
  await writeJsonLines(
    path.join(exportDir, 'llm-call-logs.jsonl'),
    llmCallRows
  );
  await writeJsonLines(
    path.join(exportDir, 'reward-judgments.jsonl'),
    rewardRows
  );

  console.log(`Export complete: ${exportDir}`);
  console.log(`Canonical characters: ${roster.length}`);
  console.log(`Matched agents: ${characterAgents.length}`);
  console.log(`Trajectories: ${trajectoryRows.length}`);
  console.log(`LLM call logs: ${llmCallRows.length}`);
  console.log(`Reward judgments: ${rewardRows.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
