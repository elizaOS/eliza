/**
 * Manifest schema and writers for Feed training artifacts — trajectory exports
 * and parallel-generation runs. Each writer stamps a versioned, tagged sidecar
 * JSON next to the produced data so downstream training/scoring tools can
 * discover and validate a run's provenance. Consumed by the `train` and
 * `train-parallel` CLI commands.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const FEED_TRAJECTORY_EXPORT_SCHEMA = "feed_training_trajectory_export";
export const FEED_PARALLEL_GENERATION_SCHEMA = "feed_parallel_generation";
export const FEED_TRAINING_ARTIFACT_VERSION = 1;

export interface FeedTrajectoryExportManifestInput {
  exportPath: string;
  archetype: string;
  trajectoryCount: number;
  scenarioIds: string[];
  agentIds: string[];
  generatedAt?: string;
}

export interface FeedTrajectoryExportManifest {
  schema: typeof FEED_TRAJECTORY_EXPORT_SCHEMA;
  schemaVersion: typeof FEED_TRAINING_ARTIFACT_VERSION;
  generatedAt: string;
  exportPath: string;
  manifestPath: string;
  source: {
    kind: "feed_train_archetype_export";
    archetype: string;
  };
  counts: {
    trajectories: number;
  };
  scenarioIds: string[];
  agentIds: string[];
}

export interface FeedParallelGenerationManifestInput {
  outputDir: string;
  exportPath?: string | null;
  archetypes: string[];
  agentsCreated: string[];
  trajectoryIds: string[];
  totalTicks: number;
  durationMs: number;
  archetypeStats: Record<
    string,
    { agents: number; trajectories: number; avgTicksPerAgent: number }
  >;
  errors: string[];
  cleanup: boolean;
  generatedAt?: string;
}

export interface FeedParallelGenerationManifest {
  schema: typeof FEED_PARALLEL_GENERATION_SCHEMA;
  schemaVersion: typeof FEED_TRAINING_ARTIFACT_VERSION;
  generatedAt: string;
  outputDir: string;
  exportPath?: string | null;
  manifestPath: string;
  source: {
    kind: "feed_train_parallel_generation";
    archetypes: string[];
  };
  counts: {
    agentsCreated: number;
    trajectories: number;
    totalTicks: number;
    errors: number;
  };
  durationMs: number;
  cleanup: boolean;
  agentsCreated: string[];
  trajectoryIds: string[];
  archetypeStats: FeedParallelGenerationManifestInput["archetypeStats"];
  errors: string[];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function manifestPathForExport(exportPath: string): string {
  return exportPath.endsWith(".jsonl")
    ? `${exportPath.slice(0, -".jsonl".length)}.manifest.json`
    : `${exportPath}.manifest.json`;
}

export async function writeFeedTrajectoryExportManifest(
  input: FeedTrajectoryExportManifestInput,
): Promise<FeedTrajectoryExportManifest> {
  const manifestPath = manifestPathForExport(input.exportPath);
  const manifest: FeedTrajectoryExportManifest = {
    schema: FEED_TRAJECTORY_EXPORT_SCHEMA,
    schemaVersion: FEED_TRAINING_ARTIFACT_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    exportPath: input.exportPath,
    manifestPath,
    source: {
      kind: "feed_train_archetype_export",
      archetype: input.archetype,
    },
    counts: {
      trajectories: input.trajectoryCount,
    },
    scenarioIds: uniqueSorted(input.scenarioIds),
    agentIds: uniqueSorted(input.agentIds),
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export async function writeFeedParallelGenerationManifest(
  input: FeedParallelGenerationManifestInput,
): Promise<FeedParallelGenerationManifest> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const manifestPath = `${input.outputDir.replace(/\/+$/, "")}/feed-parallel-${generatedAt.replace(/[:.]/g, "-")}.manifest.json`;
  const manifest: FeedParallelGenerationManifest = {
    schema: FEED_PARALLEL_GENERATION_SCHEMA,
    schemaVersion: FEED_TRAINING_ARTIFACT_VERSION,
    generatedAt,
    outputDir: input.outputDir,
    exportPath: input.exportPath ?? null,
    manifestPath,
    source: {
      kind: "feed_train_parallel_generation",
      archetypes: uniqueSorted(input.archetypes),
    },
    counts: {
      agentsCreated: input.agentsCreated.length,
      trajectories: input.trajectoryIds.length,
      totalTicks: input.totalTicks,
      errors: input.errors.length,
    },
    durationMs: input.durationMs,
    cleanup: input.cleanup,
    agentsCreated: [...input.agentsCreated],
    trajectoryIds: [...input.trajectoryIds],
    archetypeStats: input.archetypeStats,
    errors: [...input.errors],
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}
