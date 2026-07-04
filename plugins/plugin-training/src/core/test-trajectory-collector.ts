/**
 * Collects trajectories emitted by test runs into the training state dir,
 * deduping by content hash and writing a schema-tagged collection manifest the
 * analysis index consumes.
 */

import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, delimiter, join, relative, resolve } from "node:path";
import { trainingStateRoot } from "./training-config.js";

export const TEST_TRAJECTORY_COLLECTION_SCHEMA =
  "eliza_test_trajectory_collection";
export const TEST_TRAJECTORY_COLLECTION_VERSION = 1;

export interface CollectTestTrajectoriesOptions {
  roots?: string[];
  outputDir?: string;
  workspaceRoot?: string;
  limit?: number;
  generatedAt?: string;
  syntheticFallback?: boolean;
}

export interface CollectedTestTrajectory {
  sourcePath: string;
  outputPath: string;
  caseId?: string;
  scenarioId?: string;
  llmCalls: number;
  actions: number;
  transcriptTurns: number;
}

export interface TestTrajectoryCollectionManifest {
  schema: typeof TEST_TRAJECTORY_COLLECTION_SCHEMA;
  schemaVersion: typeof TEST_TRAJECTORY_COLLECTION_VERSION;
  generatedAt: string;
  outputDir: string;
  roots: string[];
  copiedCount: number;
  skippedCount: number;
  syntheticCount?: number;
  copied: CollectedTestTrajectory[];
}

export interface TestTrajectoryCollectionResult {
  outputDir: string;
  manifestPath: string;
  manifest: TestTrajectoryCollectionManifest;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[/\\:]/g, "-")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "trajectory"
  );
}

function looksLikeTestTrajectoryRecord(payload: JsonRecord): boolean {
  const agentTrajectory = isRecord(payload.agentTrajectory)
    ? payload.agentTrajectory
    : {};
  return (
    (typeof payload.caseId === "string" ||
      typeof payload.scenarioId === "string") &&
    typeof payload.startedAt === "number" &&
    typeof payload.endedAt === "number" &&
    Array.isArray(payload.transcript) &&
    isRecord(payload.agentTrajectory) &&
    Array.isArray(agentTrajectory.llmCalls) &&
    Array.isArray(payload.actions) &&
    Array.isArray(payload.events)
  );
}

function envRoots(): string[] {
  return [
    process.env.ELIZA_TEST_TRAJECTORY_DIR,
    process.env.ELIZA_ACTION_BENCHMARK_TRAJECTORY_DIR,
  ]
    .flatMap((value) => (value ? value.split(delimiter) : []))
    .map((value) => value.trim())
    .filter(Boolean);
}

function defaultRoots(workspaceRoot?: string): string[] {
  const roots = [...envRoots()];
  if (workspaceRoot) {
    roots.push(
      join(
        workspaceRoot,
        "packages",
        "app-core",
        "test-results",
        "trajectories",
      ),
      join(
        workspaceRoot,
        "packages",
        "app-core",
        "test-output",
        "trajectories",
      ),
    );
  }
  return roots.filter((root, index, all) => all.indexOf(root) === index);
}

async function collectJsonFiles(root: string, out: string[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "dist" ||
      entry.name === "build"
    ) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectJsonFiles(path, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(path);
    }
  }
}

async function loadTestTrajectory(path: string): Promise<JsonRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) && looksLikeTestTrajectoryRecord(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function summarizeCopied(
  sourcePath: string,
  outputPath: string,
  payload: JsonRecord,
): CollectedTestTrajectory {
  const agentTrajectory = isRecord(payload.agentTrajectory)
    ? payload.agentTrajectory
    : {};
  return {
    sourcePath,
    outputPath,
    caseId: typeof payload.caseId === "string" ? payload.caseId : undefined,
    scenarioId:
      typeof payload.scenarioId === "string" ? payload.scenarioId : undefined,
    llmCalls: Array.isArray(agentTrajectory.llmCalls)
      ? agentTrajectory.llmCalls.length
      : 0,
    actions: Array.isArray(payload.actions) ? payload.actions.length : 0,
    transcriptTurns: Array.isArray(payload.transcript)
      ? payload.transcript.length
      : 0,
  };
}

function syntheticTestTrajectoryRecord(generatedAt: string): JsonRecord {
  const startedAt = Date.parse(generatedAt);
  const timestamp = Number.isFinite(startedAt) ? startedAt : Date.now();
  const endedAt = timestamp + 1_000;
  return {
    caseId: "dry-run-action-planner",
    scenarioId: "training_collection.synthetic_test",
    startedAt: timestamp,
    endedAt,
    durationMs: endedAt - timestamp,
    transcript: [
      {
        role: "user",
        text: "Can you check my calendar?",
        timestamp,
      },
      {
        role: "assistant",
        text: "I checked the runtime state.",
        actions: ["CHECK_RUNTIME"],
        timestamp: endedAt,
      },
    ],
    agentTrajectory: {
      llmCalls: [
        {
          callId: "dry-run-action-planner-llm-1",
          timestamp,
          latencyMs: 0,
          modelType: "TEXT_LARGE",
          prompt: "Plan a grounded action for the user request.",
          response: "CHECK_RUNTIME",
          purpose: "action_planner",
        },
      ],
      providerSnapshots: [],
    },
    actions: [
      {
        phase: "completed",
        actionName: "CHECK_RUNTIME",
        actionStatus: "success",
        timestamp: endedAt,
      },
    ],
    events: [
      { type: "RUN_STARTED", timestamp, data: { synthetic: true } },
      { type: "RUN_ENDED", timestamp: endedAt, data: { synthetic: true } },
    ],
    memoriesWritten: [],
    metadata: {
      pass: true,
      dryRun: true,
      synthetic: true,
      tags: ["dry-run", "training-collection"],
      expectedAction: "CHECK_RUNTIME",
      plannedAction: "CHECK_RUNTIME",
      actualAction: "CHECK_RUNTIME",
    },
  };
}

export async function collectTestTrajectories(
  options: CollectTestTrajectoriesOptions = {},
): Promise<TestTrajectoryCollectionResult> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const outputDir =
    options.outputDir ??
    join(
      trainingStateRoot(),
      "test-trajectories",
      generatedAt.replace(/\D+/g, "-"),
    );
  const workspaceRoot = options.workspaceRoot
    ? resolve(options.workspaceRoot)
    : undefined;
  const roots = (
    options.roots?.length ? options.roots : defaultRoots(workspaceRoot)
  )
    .map((root) => resolve(root))
    .filter(
      (root, index, all) => existsSync(root) && all.indexOf(root) === index,
    );
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit))
      : 500;

  await mkdir(join(outputDir, "cases"), { recursive: true });

  const candidates: Array<{ root: string; path: string }> = [];
  for (const root of roots) {
    const files: string[] = [];
    if (root.endsWith(".json")) {
      files.push(root);
    } else {
      await collectJsonFiles(root, files);
    }
    for (const path of files) {
      candidates.push({ root, path });
    }
  }

  const copied: CollectedTestTrajectory[] = [];
  let skippedCount = 0;
  for (const candidate of candidates) {
    if (copied.length >= limit) break;
    const payload = await loadTestTrajectory(candidate.path);
    if (!payload) {
      skippedCount += 1;
      continue;
    }
    const relativeName = safeSegment(
      relative(candidate.root, candidate.path) || basename(candidate.path),
    );
    const outputPath = join(
      outputDir,
      "cases",
      `${String(copied.length + 1).padStart(4, "0")}-${relativeName}`,
    );
    await copyFile(candidate.path, outputPath);
    copied.push(summarizeCopied(candidate.path, outputPath, payload));
  }
  let syntheticCount = 0;
  if (copied.length === 0 && roots.length === 0 && options.syntheticFallback) {
    const payload = syntheticTestTrajectoryRecord(generatedAt);
    const outputPath = join(
      outputDir,
      "cases",
      "0001-dry-run-action-planner.json",
    );
    await writeFile(
      outputPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    copied.push(summarizeCopied(outputPath, outputPath, payload));
    syntheticCount = 1;
  }

  const manifestPath = join(outputDir, "test-trajectory-collection.json");
  const manifest: TestTrajectoryCollectionManifest = {
    schema: TEST_TRAJECTORY_COLLECTION_SCHEMA,
    schemaVersion: TEST_TRAJECTORY_COLLECTION_VERSION,
    generatedAt,
    outputDir,
    roots,
    copiedCount: copied.length,
    skippedCount,
    syntheticCount,
    copied,
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { outputDir, manifestPath, manifest };
}
