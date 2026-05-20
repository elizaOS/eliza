#!/usr/bin/env bun

import { existsSync, promises as fs, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnvFile } from 'dotenv';
import { Client } from 'pg';

type CliOptions = {
  envFile: string;
  count: number;
  minSteps: number;
  minLlmCalls: number;
  outputDir: string;
};

type CandidateAgentRow = {
  id: string;
  username: string | null;
  virtualBalance: string;
};

type ValidationRow = {
  trajectoryId: string;
  createdAt: Date | string;
  episodeLength: number;
  stepsJson: string;
  totalReward: number | string;
  finalPnL: number | string | null;
};

type LlmCountRow = {
  count: string;
};

type CollectedTrajectorySummary = {
  agent_id: string;
  agent_username: string | null;
  trajectory_id: string;
  created_at: string;
  episode_length: number;
  llm_call_count: number;
  total_reward: number;
  final_pnl: number | null;
};

type CollectionManifest = {
  source: {
    env_file: string;
    started_at: string;
    completed_at: string;
    requested_count: number;
  };
  validation: {
    min_steps: number;
    min_llm_calls: number;
  };
  trajectories: CollectedTrajectorySummary[];
};

function printUsage(): void {
  console.log(`
Collect and validate fresh complete production trajectories.

Usage:
  bun run scripts/collect-complete-production-trajectories.ts [options]

Options:
  --env-file <path>       Env file with POSTGRES_URL (default: .env.production.local)
  --count <n>             Number of validated trajectories to collect (default: 3)
  --min-steps <n>         Minimum episodeLength required (default: 1)
  --min-llm-calls <n>     Minimum llm_call_logs rows required (default: 1)
  --output-dir <path>     Output directory (default: training-data/production-trajectories/validated-runs/<timestamp>)
  -h, --help              Show this help
`);
}

function readArgValue(args: string[], name: string): string | null {
  const exactIndex = args.findIndex((arg) => arg === name);
  if (exactIndex !== -1) {
    const value = args[exactIndex + 1];
    if (!value) {
      throw new Error(`Missing value after ${name}`);
    }
    return value.trim();
  }

  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (!prefixed) {
    return null;
  }

  const value = prefixed.slice(name.length + 1).trim();
  if (!value) {
    throw new Error(`${name} cannot be empty`);
  }

  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:]/g, '-').replace(/\..+$/, 'Z');
}

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printUsage();
    process.exit(0);
  }

  const now = new Date();
  const defaultOutputDir = path.join(
    'training-data',
    'production-trajectories',
    'validated-runs',
    timestampForPath(now)
  );

  return {
    envFile: readArgValue(args, '--env-file') ?? '.env.production.local',
    count: parsePositiveInteger(
      readArgValue(args, '--count') ?? '3',
      '--count'
    ),
    minSteps: parsePositiveInteger(
      readArgValue(args, '--min-steps') ?? '1',
      '--min-steps'
    ),
    minLlmCalls: parsePositiveInteger(
      readArgValue(args, '--min-llm-calls') ?? '1',
      '--min-llm-calls'
    ),
    outputDir: readArgValue(args, '--output-dir') ?? defaultOutputDir,
  };
}

function ensureDirectory(directoryPath: string): void {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
}

function normalizeTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function normalizeNumber(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === 'number' ? value : Number(value);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const envResult = loadEnvFile({ path: options.envFile, override: true });
  if (envResult.error) {
    throw envResult.error;
  }

  if (!process.env.POSTGRES_URL) {
    throw new Error(`POSTGRES_URL not found in ${options.envFile}`);
  }
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = process.env.POSTGRES_URL;
  }

  const startedAt = new Date();
  const outputRoot = path.resolve(options.outputDir);
  ensureDirectory(outputRoot);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    statement_timeout: 120000,
  });
  await client.connect();
  const candidateResult = await client.query<CandidateAgentRow>(
    `
      SELECT
        u.id,
        u.username,
        u."virtualBalance"
      FROM "User" u
      INNER JOIN "UserAgentConfig" cfg ON u.id = cfg."userId"
      WHERE
        u."isAgent" = true
        AND u."virtualBalance" >= 1
        AND (
          cfg."autonomousTrading" = true
          OR cfg."autonomousPosting" = true
          OR cfg."autonomousCommenting" = true
          OR cfg."autonomousDMs" = true
          OR cfg."autonomousGroupChats" = true
        )
      ORDER BY u."virtualBalance" DESC
      LIMIT $1
    `,
    [options.count * 2 + 2]
  );
  await client.end();
  const candidates = candidateResult.rows;

  if (candidates.length === 0) {
    throw new Error('No eligible autonomous agents found');
  }

  const dbMod = await import('@feed/db');
  const agentsMod = await import('@feed/agents');

  const summaries: CollectedTrajectorySummary[] = [];

  for (let index = 0; index < options.count; index++) {
    const candidate = candidates[index % candidates.length];
    if (!candidate) {
      throw new Error('Candidate agent missing during collection');
    }

    console.log(
      `[${index + 1}/${options.count}] Collecting validated trajectory for ${candidate.username || candidate.id}`
    );

    const runtime = await agentsMod.agentRuntimeManager.getRuntime(
      candidate.id
    );
    const result = await agentsMod.autonomousCoordinator.executeAutonomousTick(
      candidate.id,
      runtime,
      true,
      false
    );

    if (!result.trajectoryId) {
      throw new Error(
        `Tick for ${candidate.id} did not return a trajectory id`
      );
    }

    const trajectoryRows = (await dbMod.db
      .select({
        trajectoryId: dbMod.trajectories.trajectoryId,
        createdAt: dbMod.trajectories.createdAt,
        episodeLength: dbMod.trajectories.episodeLength,
        stepsJson: dbMod.trajectories.stepsJson,
        totalReward: dbMod.trajectories.totalReward,
        finalPnL: dbMod.trajectories.finalPnL,
      })
      .from(dbMod.trajectories)
      .where(dbMod.eq(dbMod.trajectories.trajectoryId, result.trajectoryId))
      .limit(1)) as ValidationRow[];

    const trajectory = trajectoryRows[0];
    if (!trajectory) {
      throw new Error(`Trajectory row not found for ${result.trajectoryId}`);
    }

    const llmCountRows = (await dbMod.db
      .select({
        count: dbMod.sql<string>`COUNT(*)`,
      })
      .from(dbMod.llmCallLogs)
      .where(
        dbMod.eq(dbMod.llmCallLogs.trajectoryId, result.trajectoryId)
      )) as LlmCountRow[];

    const llmCallCount = Number(llmCountRows[0]?.count ?? '0');
    const hasSteps = trajectory.stepsJson !== '[]';

    if (!hasSteps || trajectory.episodeLength < options.minSteps) {
      throw new Error(
        `Trajectory ${result.trajectoryId} failed validation: episodeLength=${trajectory.episodeLength}, hasSteps=${hasSteps}`
      );
    }

    if (llmCallCount < options.minLlmCalls) {
      throw new Error(
        `Trajectory ${result.trajectoryId} failed validation: llmCallCount=${llmCallCount}`
      );
    }

    const summary: CollectedTrajectorySummary = {
      agent_id: candidate.id,
      agent_username: candidate.username,
      trajectory_id: result.trajectoryId,
      created_at: normalizeTimestamp(trajectory.createdAt),
      episode_length: trajectory.episodeLength,
      llm_call_count: llmCallCount,
      total_reward: normalizeNumber(trajectory.totalReward) ?? 0,
      final_pnl: normalizeNumber(trajectory.finalPnL),
    };

    summaries.push(summary);
    console.log(
      `  validated ${summary.trajectory_id} with ${summary.episode_length} steps and ${summary.llm_call_count} llm calls`
    );
  }

  const manifest: CollectionManifest = {
    source: {
      env_file: options.envFile,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      requested_count: options.count,
    },
    validation: {
      min_steps: options.minSteps,
      min_llm_calls: options.minLlmCalls,
    },
    trajectories: summaries,
  };

  await fs.writeFile(
    path.join(outputRoot, 'collection-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  console.log('');
  console.log(`Validated ${summaries.length} fresh trajectories`);
  console.log(`Output: ${outputRoot}`);
  console.log(`Since timestamp: ${startedAt.toISOString()}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
