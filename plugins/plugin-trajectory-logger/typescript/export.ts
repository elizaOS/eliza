/**
 * Trajectory Export Utilities
 *
 * The original implementation targeted a Babylon-specific database + HuggingFace upload pipeline.
 * In elizaOS core, this module is storage-agnostic and focuses on preparing files for downstream
 * training (JSONL / grouped JSON).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { groupTrajectories, toARTJSONL } from "./art-format";
import type { Trajectory, TrajectoryGroup } from "./types";

export interface ExportOptions {
  // Dataset configuration (kept for API compatibility)
  datasetName: string;
  huggingFaceToken?: string;

  // Data filtering
  startDate?: Date;
  endDate?: Date;
  agentIds?: string[];
  scenarioIds?: string[];
  minReward?: number;
  maxReward?: number;
  includeJudged?: boolean;

  // Limits
  maxTrajectories?: number;

  // Format (currently only jsonl is produced)
  format?: "jsonl" | "parquet" | "arrow";
  splitRatio?: { train: number; validation: number; test: number };

  // elizaOS: provide trajectories directly (no DB dependency)
  trajectories?: Trajectory[];

  // Output path controls
  outputPath?: string;
  outputDir?: string;
}

export interface ExportResult {
  success: boolean;
  trajectoriesExported: number;
  datasetUrl?: string;
  error?: string;
}

export async function exportToHuggingFace(options: ExportOptions): Promise<ExportResult> {
  // In this repo we don't couple to a DB or HuggingFace API.
  // We still keep the function name/signature so existing callers can migrate by
  // passing `trajectories` + `outputPath`.
  return exportForOpenPipeART(options);
}

export async function exportGroupedByScenario(options: ExportOptions): Promise<ExportResult> {
  const trajectories = filterTrajectories(options.trajectories || [], options);
  const outPath = resolveOutputPath(options, "grouped-by-scenario.json");

  const grouped: Record<string, Trajectory[]> = {};
  for (const t of trajectories) {
    const scenarioId = t.scenarioId || "default";
    if (!grouped[scenarioId]) grouped[scenarioId] = [];
    grouped[scenarioId]?.push(t);
  }

  await writeJson(outPath, grouped);
  return { success: true, trajectoriesExported: trajectories.length, datasetUrl: outPath };
}

export async function exportForOpenPipeART(options: ExportOptions): Promise<ExportResult> {
  const trajectories = filterTrajectories(options.trajectories || [], options);
  const outPath = resolveOutputPath(options, "trajectories.art.jsonl");

  const lines = `${trajectories.map((t) => toARTJSONL(t)).join("\n")}\n`;
  await writeText(outPath, lines);

  return { success: true, trajectoriesExported: trajectories.length, datasetUrl: outPath };
}

export async function exportGroupedForGRPO(options: ExportOptions): Promise<ExportResult> {
  const trajectories = filterTrajectories(options.trajectories || [], options);
  const outPath = resolveOutputPath(options, "trajectories.grpo.groups.json");

  const groups: TrajectoryGroup[] = groupTrajectories(trajectories);
  await writeJson(outPath, groups);

  return { success: true, trajectoriesExported: trajectories.length, datasetUrl: outPath };
}

function filterTrajectories(trajectories: Trajectory[], options: ExportOptions): Trajectory[] {
  let out = trajectories.slice();

  if (options.startDate) {
    const startMs = options.startDate.getTime();
    out = out.filter((t) => t.startTime >= startMs);
  }
  if (options.endDate) {
    const endMs = options.endDate.getTime();
    out = out.filter((t) => t.startTime <= endMs);
  }
  if (options.agentIds && options.agentIds.length > 0) {
    const set = new Set(options.agentIds);
    out = out.filter((t) => set.has(t.agentId));
  }
  if (options.scenarioIds && options.scenarioIds.length > 0) {
    const set = new Set(options.scenarioIds);
    out = out.filter((t) => t.scenarioId && set.has(t.scenarioId));
  }
  if (typeof options.minReward === "number") {
    const minReward = options.minReward;
    out = out.filter((t) => t.totalReward >= minReward);
  }
  if (typeof options.maxReward === "number") {
    const maxReward = options.maxReward;
    out = out.filter((t) => t.totalReward <= maxReward);
  }

  const limit = options.maxTrajectories || out.length;
  return out.slice(0, limit);
}

function resolveOutputPath(options: ExportOptions, fallbackFileName: string): string {
  if (options.outputPath) return options.outputPath;
  if (options.outputDir) return join(options.outputDir, fallbackFileName);

  const safeName = options.datasetName.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(process.cwd(), `${safeName}.${fallbackFileName}`);
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeJson(path: string, data: object): Promise<void> {
  await writeText(path, `${JSON.stringify(data, null, 2)}\n`);
}
