#!/usr/bin/env bun

/**
 * @deprecated Use the Python export instead:
 *   python packages/training/python/scripts/data-prep/export_scam_defense_trajectories.py
 *
 * The Python export is the primary export path — it supports held-out splits,
 * format recovery, external data merging, and multiple output formats.
 * This TypeScript version is kept for backward compatibility but will be removed.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  and,
  closeDatabase,
  db,
  desc,
  eq,
  gte,
  inArray,
  llmCallLogs,
  rewardJudgments,
  trajectories,
  userAgentConfigs,
  users,
} from '@babylon/db';
import { config as loadDotenv } from 'dotenv';

const BABYLON_REPO_ROOT = path.resolve(import.meta.dir, '..');
loadDotenv({ path: path.join(BABYLON_REPO_ROOT, '.env') });
loadDotenv({ path: path.join(BABYLON_REPO_ROOT, '.env.local') });

interface ExportOptions {
  manifestPath: string;
  lookbackHours: number;
  outputDir: string;
}

interface ManifestFile {
  generatedAt?: string;
  experimentRunId?: string;
  batchId?: string;
  agents?: Array<{
    instanceId?: string;
    username?: string;
    modelSize?: string;
    trainingProfile?: string;
  }>;
}

interface ManifestAgentRecord {
  instanceId: string;
  username: string;
  modelSize: string;
  trainingProfile: string;
}

interface RegisteredAgentRecord {
  instanceId: string;
  userId: string;
  username: string;
  displayName: string;
  modelSize: string;
  trainingProfile: string;
}

interface UserCandidate {
  userId: string;
  username: string;
  displayName: string | null;
  createdAt: Date;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function formatExportWarning(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code =
      (error as { cause?: { code?: string }; code?: string }).cause?.code ??
      (error as { code?: string }).code;
    if (code === 'ECONNREFUSED') {
      return 'Database connection refused while exporting trust experiment trajectories.';
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Failed query:')) {
    return 'Database query failed while exporting trust experiment trajectories. Check database availability and connection settings.';
  }

  return message;
}

function parseOptions(): ExportOptions {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      manifest: { type: 'string' },
      'lookback-hours': { type: 'string', default: '24' },
      output: {
        type: 'string',
        default: 'training-data/trust-experiment-exports',
      },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.manifest) {
    throw new Error('--manifest is required');
  }

  const lookbackHours = parseInt(values['lookback-hours'], 10);

  return {
    manifestPath: path.resolve(process.cwd(), values.manifest as string),
    lookbackHours:
      Number.isFinite(lookbackHours) && lookbackHours > 0 ? lookbackHours : 24,
    outputDir: path.resolve(process.cwd(), values.output as string),
  };
}

async function readManifest(manifestPath: string): Promise<{
  generatedAt?: Date;
  experimentRunId?: string;
  batchId?: string;
  agents: ManifestAgentRecord[];
}> {
  const raw = JSON.parse(await readFile(manifestPath, 'utf-8')) as ManifestFile;
  const generatedAt =
    raw.generatedAt && !Number.isNaN(new Date(raw.generatedAt).getTime())
      ? new Date(raw.generatedAt)
      : undefined;

  return {
    generatedAt,
    experimentRunId:
      typeof raw.experimentRunId === 'string' && raw.experimentRunId.trim()
        ? raw.experimentRunId.trim()
        : undefined,
    batchId:
      typeof raw.batchId === 'string' && raw.batchId.trim()
        ? raw.batchId.trim()
        : undefined,
    agents: (raw.agents ?? []).flatMap((agent) =>
      agent.instanceId && agent.username
        ? [
            {
              instanceId: agent.instanceId,
              username: agent.username,
              modelSize: agent.modelSize ?? 'unknown',
              trainingProfile: agent.trainingProfile ?? 'unknown',
            },
          ]
        : []
    ),
  };
}

async function readRegisteredAgents(
  manifestPath: string
): Promise<Map<string, RegisteredAgentRecord>> {
  const registeredPath = path.join(
    path.dirname(manifestPath),
    'registered-agents.json'
  );

  try {
    const raw = JSON.parse(await readFile(registeredPath, 'utf-8')) as {
      agents?: Array<{
        instanceId?: string;
        agentId?: string;
        username?: string;
        displayName?: string;
        modelSize?: string;
        trainingProfile?: string;
      }>;
    };

    return new Map(
      (raw.agents ?? []).flatMap((agent) =>
        agent.instanceId && agent.agentId && agent.username
          ? [
              [
                agent.instanceId,
                {
                  instanceId: agent.instanceId,
                  userId: agent.agentId,
                  username: agent.username,
                  displayName: agent.displayName ?? agent.username,
                  modelSize: agent.modelSize ?? 'unknown',
                  trainingProfile: agent.trainingProfile ?? 'unknown',
                } satisfies RegisteredAgentRecord,
              ] as const,
            ]
          : []
      )
    );
  } catch {
    return new Map();
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  const manifest = await readManifest(options.manifestPath);
  const agents = manifest.agents;
  const registeredAgentsByInstanceId = await readRegisteredAgents(
    options.manifestPath
  );
  if (agents.length === 0) {
    throw new Error('Manifest did not contain any agents');
  }

  const exportStamp = new Date().toISOString().replaceAll(':', '-');
  const exportDir = path.join(options.outputDir, exportStamp);
  await mkdir(exportDir, { recursive: true });

  const usernames = agents.map((agent) => agent.username);
  let matchedAgents: Array<
    ManifestAgentRecord & {
      userId: string;
      displayName: string | null;
      createdAt: Date;
    }
  > = [];
  let trajectoryRows: (typeof trajectories.$inferSelect)[] = [];
  let llmCallRows: (typeof llmCallLogs.$inferSelect)[] = [];
  let rewardRows: (typeof rewardJudgments.$inferSelect)[] = [];
  let configRows: Array<{
    userId: string;
    systemPrompt: string | null;
    personality: string | null;
    tradingStrategy: string | null;
    style: string | null;
    goals: string | null;
    constraints: string | null;
    modelTier: string | null;
    updatedAt: Date;
  }> = [];
  let exportWarning: string | null = null;
  const exactBatchId = manifest.batchId ?? manifest.experimentRunId;
  const selectionStrategy = exactBatchId
    ? 'exact_batch_id'
    : 'lookback_heuristic';

  try {
    const registeredAgentIds = Array.from(
      new Set(
        Array.from(registeredAgentsByInstanceId.values()).map(
          (agent) => agent.userId
        )
      )
    );
    const userRowsByUsername =
      usernames.length > 0
        ? await db
            .select({
              userId: users.id,
              username: users.username,
              displayName: users.displayName,
              createdAt: users.createdAt,
            })
            .from(users)
            .where(inArray(users.username, usernames))
            .orderBy(desc(users.createdAt))
        : [];
    const userRowsById =
      registeredAgentIds.length > 0
        ? await db
            .select({
              userId: users.id,
              username: users.username,
              displayName: users.displayName,
              createdAt: users.createdAt,
            })
            .from(users)
            .where(inArray(users.id, registeredAgentIds))
            .orderBy(desc(users.createdAt))
        : [];

    const userRows = Array.from(
      new Map(
        [...userRowsByUsername, ...userRowsById].map((row) => [row.userId, row])
      ).values()
    );

    const lookbackCutoff = new Date(
      Date.now() - options.lookbackHours * 60 * 60 * 1000
    );
    const cutoff =
      manifest.generatedAt && manifest.generatedAt > lookbackCutoff
        ? manifest.generatedAt
        : lookbackCutoff;

    const trajectoryCandidates = exactBatchId
      ? await db
          .select({
            agentId: trajectories.agentId,
            createdAt: trajectories.createdAt,
          })
          .from(trajectories)
          .where(eq(trajectories.batchId, exactBatchId))
      : userRows.length > 0
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

    const userRowsByUserId = new Map<string, UserCandidate>(
      userRows.map((row) => [row.userId, row])
    );
    const candidatesByUsername = new Map<string, UserCandidate[]>();
    for (const userRow of userRows) {
      const current = candidatesByUsername.get(userRow.username) ?? [];
      current.push(userRow);
      candidatesByUsername.set(userRow.username, current);
    }

    matchedAgents = agents.flatMap((agent) => {
      const exactRegistered = registeredAgentsByInstanceId.get(
        agent.instanceId
      );
      if (exactRegistered) {
        const registeredUser = userRowsByUserId.get(exactRegistered.userId);
        if (!registeredUser) {
          return [];
        }

        return [
          {
            ...agent,
            userId: registeredUser.userId,
            displayName: registeredUser.displayName,
            createdAt: registeredUser.createdAt,
          },
        ];
      }

      const candidates = candidatesByUsername.get(agent.username) ?? [];
      const selected = [...candidates].sort((left, right) => {
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

      if (!selected) {
        return [];
      }

      return [
        {
          ...agent,
          userId: selected.userId,
          displayName: selected.displayName,
          createdAt: selected.createdAt,
        },
      ];
    });

    const agentIds = matchedAgents.map((agent) => agent.userId);
    if (agentIds.length === 0) {
      exportWarning = exactBatchId
        ? `No trust experiment users matched the database for batch ${exactBatchId}.`
        : 'No trust experiment users matched the current database.';
    } else {
      trajectoryRows = await db
        .select()
        .from(trajectories)
        .where(
          exactBatchId
            ? and(
                inArray(trajectories.agentId, agentIds),
                eq(trajectories.batchId, exactBatchId)
              )
            : and(
                inArray(trajectories.agentId, agentIds),
                gte(trajectories.createdAt, cutoff)
              )
        )
        .orderBy(desc(trajectories.createdAt));

      const trajectoryIds = trajectoryRows.map((row) => row.trajectoryId);
      llmCallRows =
        trajectoryIds.length > 0
          ? await db
              .select()
              .from(llmCallLogs)
              .where(inArray(llmCallLogs.trajectoryId, trajectoryIds))
              .orderBy(desc(llmCallLogs.createdAt))
          : [];

      rewardRows =
        trajectoryIds.length > 0
          ? await db
              .select()
              .from(rewardJudgments)
              .where(inArray(rewardJudgments.trajectoryId, trajectoryIds))
              .orderBy(desc(rewardJudgments.judgedAt))
          : [];

      configRows = await db
        .select({
          userId: userAgentConfigs.userId,
          systemPrompt: userAgentConfigs.systemPrompt,
          personality: userAgentConfigs.personality,
          tradingStrategy: userAgentConfigs.tradingStrategy,
          style: userAgentConfigs.style,
          goals: userAgentConfigs.goals,
          constraints: userAgentConfigs.constraints,
          modelTier: userAgentConfigs.modelTier,
          updatedAt: userAgentConfigs.updatedAt,
        })
        .from(userAgentConfigs)
        .where(inArray(userAgentConfigs.userId, agentIds));
    }
  } catch (error) {
    exportWarning = formatExportWarning(error);
  }

  await writeFile(
    path.join(exportDir, 'manifest.json'),
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        sourceManifest: options.manifestPath,
        lookbackHours: options.lookbackHours,
        sourceExperimentRunId: manifest.experimentRunId ?? null,
        sourceBatchId: manifest.batchId ?? manifest.experimentRunId ?? null,
        selectionStrategy,
        requestedAgentCount: agents.length,
        matchedAgentCount: matchedAgents.length,
        manifestGeneratedAt: manifest.generatedAt?.toISOString() ?? null,
        trajectoryCount: trajectoryRows.length,
        llmCallCount: llmCallRows.length,
        rewardJudgmentCount: rewardRows.length,
        warning: exportWarning,
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  await writeFile(
    path.join(exportDir, 'matched-agents.json'),
    JSON.stringify({ agents: matchedAgents }, null, 2) + '\n',
    'utf-8'
  );
  await writeFile(
    path.join(exportDir, 'agent-configs.json'),
    JSON.stringify({ agentConfigs: configRows }, null, 2) + '\n',
    'utf-8'
  );
  const rewardRowsByTrajectoryId = new Map<string, typeof rewardRows>();
  for (const rewardRow of rewardRows) {
    const current = rewardRowsByTrajectoryId.get(rewardRow.trajectoryId) ?? [];
    current.push(rewardRow);
    rewardRowsByTrajectoryId.set(rewardRow.trajectoryId, current);
  }
  const enrichedTrajectoryRows = trajectoryRows.map((row) => {
    const metadata = parseJsonObject(row.metadataJson);
    const rowRewardJudgments =
      rewardRowsByTrajectoryId.get(row.trajectoryId) ?? [];
    if (rowRewardJudgments.length > 0) {
      metadata.rewardJudgmentCount = rowRewardJudgments.length;
      metadata.latestRewardJudgmentScore =
        rowRewardJudgments[0]?.overallScore ?? null;
      metadata.rewardJudgmentSource = 'sidecar_export';
    }
    return {
      ...row,
      metadata,
      rewardJudgments: rowRewardJudgments,
    };
  });
  await writeFile(
    path.join(exportDir, 'trajectories.jsonl'),
    `${enrichedTrajectoryRows.map((row) => JSON.stringify(row)).join('\n')}${enrichedTrajectoryRows.length ? '\n' : ''}`,
    'utf-8'
  );
  await writeFile(
    path.join(exportDir, 'llm-call-logs.jsonl'),
    `${llmCallRows.map((row) => JSON.stringify(row)).join('\n')}${llmCallRows.length ? '\n' : ''}`,
    'utf-8'
  );
  await writeFile(
    path.join(exportDir, 'reward-judgments.jsonl'),
    `${rewardRows.map((row) => JSON.stringify(row)).join('\n')}${rewardRows.length ? '\n' : ''}`,
    'utf-8'
  );

  console.log(`Export complete: ${exportDir}`);
  console.log(`Matched agents: ${matchedAgents.length}/${agents.length}`);
  console.log(`Trajectories: ${trajectoryRows.length}`);
  if (exportWarning) {
    console.warn(`Warning: ${exportWarning}`);
  }
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      await closeDatabase();
    } catch (closeError) {
      console.error('Failed to close database connections:', closeError);
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  }
})();
