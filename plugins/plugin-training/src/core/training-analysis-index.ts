import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { BENCHMARK_MATRIX_ARTIFACT_SCHEMA } from "./benchmark-matrix-artifact.js";
import {
  canonicalElizaOneTierSort,
  ELIZA_ONE_BENCHMARK_TIERS,
  normalizeElizaOneBenchmarkTier,
} from "./eliza1-benchmark-recipe.js";
import { EVAL_COMPARISON_ARTIFACT_SCHEMA } from "./eval-comparison-artifact.js";
import { ELIZA1_BUNDLE_STAGE_SCHEMA } from "./eliza1-bundle-stager.js";
import { HUGGINGFACE_DATASET_INGEST_SCHEMA } from "./huggingface-dataset-ingest.js";
import { TRAINING_READINESS_REPORT_SCHEMA } from "./training-readiness-report.js";
import { trainingStateRoot } from "./training-config.js";
import {
  TRAJECTORY_EXPORT_BUNDLE_SCHEMA,
  type TrajectoryExportBundleManifest,
} from "./trajectory-export-bundle.js";
import type { TrainingRunRecord } from "./training-orchestrator.js";

export const TRAINING_ANALYSIS_INDEX_SCHEMA = "eliza_training_analysis_index";
export const TRAINING_ANALYSIS_INDEX_VERSION = 1;
export const TRAINING_JSONL_DATASET_SCHEMA = "eliza_training_jsonl_dataset";
export const ACTION_BENCHMARK_REPORT_SCHEMA =
  "eliza_action_selection_benchmark_report";
const TRAINING_COLLECTION_RUN_SCHEMA = "eliza_training_collection_run";
const JSONL_SAMPLE_LIMIT = 5;
const BUNDLE_LLM_CALL_PREVIEW_LIMIT = 25;

export interface TrainingAnalysisArtifact {
  id: string;
  kind:
    | "trajectory_bundle"
    | "trajectory_dataset"
    | "scenario_run"
    | "collection_run"
    | "training_run"
    | "eval"
    | "benchmark_matrix"
    | "model";
  title: string;
  path: string;
  generatedAt?: string;
  summary: Record<string, unknown>;
  payload: unknown;
}

export interface TrainingAnalysisIndexManifest {
  schema: typeof TRAINING_ANALYSIS_INDEX_SCHEMA;
  schemaVersion: typeof TRAINING_ANALYSIS_INDEX_VERSION;
  generatedAt: string;
  roots: string[];
  outputDir: string;
  indexHtmlPath: string;
  manifestPath: string;
  counts: {
    trajectoryBundles: number;
    trajectoryDatasets: number;
    scenarioRuns: number;
    collectionRuns: number;
    trainingRuns: number;
    evals: number;
    benchmarkMatrices: number;
    models: number;
    artifacts: number;
  };
  coverage: TrainingAnalysisCoverageSummary;
  artifacts: TrainingAnalysisArtifact[];
}

export interface TrainingAnalysisCoverageSummary {
  dataSources: {
    huggingFace: number;
    feed: number;
    natural: number;
    scenarios: number;
    tests: number;
    trainingJsonl: number;
  };
  readableSamples: {
    huggingFace: number;
    feed: number;
    natural: number;
    scenarios: number;
    tests: number;
    trainingJsonl: number;
    total: number;
  };
  evals: {
    artifacts: number;
    comparisons: number;
    scoredComparisons: number;
  };
  benchmarks: {
    matrices: number;
    comparisons: number;
    scoredComparisons: number;
    caseSamples: number;
    tiers: string[];
    allEliza1TiersCovered: boolean;
    tierCoverage: Array<{
      tier: string;
      hasBase: boolean;
      hasTrained: boolean;
      hasReference: boolean;
      hasImprovement: boolean;
      benchmarkCount: number;
      comparisonCount: number;
    }>;
  };
  models: {
    artifacts: number;
    stagedBundles: number;
    inventory: Array<{
      model: string | null;
      tier: string | null;
      variant: string | null;
      baseModel: string | null;
      outputPath: string | null;
      baseEvalScore: number | null;
      trainedEvalScore: number | null;
      evalImprovementPercent: number | null;
    }>;
  };
}

export interface BuildTrainingAnalysisIndexOptions {
  roots?: string[];
  outputDir?: string;
  maxDepth?: number;
  now?: () => Date;
}

export interface TrainingAnalysisIndex {
  outputDir: string;
  indexHtmlPath: string;
  manifestPath: string;
  manifest: TrainingAnalysisIndexManifest;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function resolveManifestPath(
  manifestPath: string,
  value: unknown,
): string | undefined {
  const path = stringValue(value);
  if (!path) return undefined;
  if (isAbsolute(path)) return path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  return resolve(dirname(manifestPath), path);
}

function resolveManifestFilePath(
  manifestPath: string,
  value: unknown,
): string | undefined {
  const path = stringValue(value);
  if (!path) return undefined;
  const resolved = resolveManifestPath(manifestPath, path);
  if (resolved && existsSync(resolved)) return resolved;
  const asWritten = resolve(path);
  if (existsSync(asWritten)) return asWritten;
  return resolved;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function walkJsonFiles(
  root: string,
  maxDepth: number,
): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(path, depth + 1);
        continue;
      }
      if (
        entry.isFile() &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))
      ) {
        out.push(path);
      }
    }
  }

  await walk(root, 0);
  return out.sort();
}

function artifactId(kind: TrainingAnalysisArtifact["kind"], path: string) {
  return `${kind}:${path}`;
}

function relativePath(path: string, roots: readonly string[]): string {
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel && !rel.startsWith("..")) return rel;
  }
  return path;
}

function firstBundleLlmCall(sample: JsonRecord): JsonRecord {
  const steps = Array.isArray(sample.steps) ? sample.steps : [];
  for (const step of steps) {
    if (!isRecord(step) || !Array.isArray(step.llmCalls)) continue;
    const call = step.llmCalls.find(isRecord);
    if (call) return call;
  }
  return {};
}

function bundleLlmCallModel(call: JsonRecord): unknown {
  return (
    call.model ??
    call.modelType ??
    call.provider ??
    call.providerName ??
    call.backend
  );
}

function summarizeBundleSample(sample: JsonRecord): JsonRecord {
  const call = firstBundleLlmCall(sample);
  const steps = Array.isArray(sample.steps) ? sample.steps : [];
  const llmCalls = steps.reduce((count, step) => {
    if (!isRecord(step) || !Array.isArray(step.llmCalls)) return count;
    return count + step.llmCalls.length;
  }, 0);
  return {
    trajectoryId: sample.trajectoryId ?? sample.id ?? sample.run_id,
    agentId: sample.agentId ?? sample.agent,
    durationMs: sample.durationMs,
    steps: steps.length,
    llmCalls,
    purpose: call.purpose ?? sample.kind ?? sample.task_id,
    callId: call.callId ?? sample.callId,
    model: bundleLlmCallModel(call) ?? sample.model,
    systemPrompt: call.systemPrompt ?? sample.systemPrompt,
    input: call.userPrompt ?? call.prompt ?? call.input ?? sample.prompt,
    output: call.response ?? call.output ?? sample.response,
  };
}

function summarizeBundleLlmCallPreviews(sample: JsonRecord): JsonRecord[] {
  const previews: JsonRecord[] = [];
  const steps = Array.isArray(sample.steps) ? sample.steps : [];
  for (const [stepIndex, step] of steps.entries()) {
    if (!isRecord(step) || !Array.isArray(step.llmCalls)) continue;
    for (const [callIndex, rawCall] of step.llmCalls.entries()) {
      if (!isRecord(rawCall)) continue;
      previews.push({
        trajectoryId: sample.trajectoryId ?? sample.id,
        agentId: sample.agentId,
        stepId: step.stepId,
        stepIndex,
        callIndex,
        callId: rawCall.callId,
        purpose: rawCall.purpose,
        model: bundleLlmCallModel(rawCall),
        provider: rawCall.provider ?? rawCall.providerName,
        latencyMs: rawCall.latencyMs,
        systemPrompt: rawCall.systemPrompt,
        input: rawCall.userPrompt ?? rawCall.prompt ?? rawCall.input,
        output: rawCall.response ?? rawCall.output,
      });
      if (previews.length >= BUNDLE_LLM_CALL_PREVIEW_LIMIT) return previews;
    }
  }
  return previews;
}

async function readJsonlSamplePreviews(
  path: string | undefined,
  summarize: (sample: JsonRecord) => JsonRecord,
): Promise<JsonRecord[]> {
  if (!path || !existsSync(path)) return [];
  const previews: JsonRecord[] = [];
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isRecord(parsed)) previews.push(summarize(parsed));
      } catch {
        // Ignore malformed preview rows; full dataset parsing reports errors elsewhere.
      }
      if (previews.length >= JSONL_SAMPLE_LIMIT) break;
    }
  } finally {
    input.destroy();
  }
  return previews;
}

async function readBundleLlmCallPreviews(
  path: string | undefined,
): Promise<JsonRecord[]> {
  if (!path || !existsSync(path)) return [];
  const previews: JsonRecord[] = [];
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isRecord(parsed)) {
          previews.push(...summarizeBundleLlmCallPreviews(parsed));
        }
      } catch {
        // Ignore malformed preview rows; full dataset parsing reports errors elsewhere.
      }
      if (previews.length >= BUNDLE_LLM_CALL_PREVIEW_LIMIT) break;
    }
  } finally {
    input.destroy();
  }
  return previews.slice(0, BUNDLE_LLM_CALL_PREVIEW_LIMIT);
}

async function summarizeBundle(
  path: string,
  payload: TrajectoryExportBundleManifest,
  roots: readonly string[],
): Promise<TrainingAnalysisArtifact> {
  const viewerHtmlPath = resolveManifestFilePath(
    path,
    payload.paths?.viewerHtmlPath,
  );
  const rawJsonlPath = resolveManifestFilePath(path, payload.paths?.rawJsonlPath);
  const sanitizedJsonlPath = resolveManifestFilePath(
    path,
    payload.paths?.sanitizedJsonlPath,
  );
  const taskDatasetSummaryPath = resolveManifestFilePath(
    path,
    payload.paths?.taskDatasetSummaryPath,
  );
  const taskDatasetDir =
    resolveManifestPath(path, payload.paths?.taskDatasetDir) ??
    payload.paths?.taskDatasetDir;
  const samplePreviews = await readJsonlSamplePreviews(
    sanitizedJsonlPath,
    summarizeBundleSample,
  );
  const llmCallPreviews = await readBundleLlmCallPreviews(
    sanitizedJsonlPath,
  );
  return {
    id: artifactId("trajectory_bundle", path),
    kind: "trajectory_bundle",
    title:
      stringValue(payload.runId) ??
      stringValue(payload.source?.kind) ??
      basename(dirname(path)),
    path,
    generatedAt: payload.generatedAt,
    summary: {
      source: payload.source?.kind,
      runId: payload.runId,
      relativePath: relativePath(path, roots),
      viewerHtmlPath,
      rawJsonlPath,
      sanitizedJsonlPath,
      taskDatasetDir,
      taskDatasetSummaryPath,
      inputTrajectoryCount: payload.source?.inputTrajectoryCount,
      sanitizedTrajectoryCount: payload.source?.sanitizedTrajectoryCount,
      taskExamples: payload.counts?.taskExamples,
      llmCalls: payload.counts?.llmCalls,
      uploadedToHuggingFace: payload.cloudUpload?.uploadedToHuggingFace,
      huggingFaceRepo: payload.cloudUpload?.huggingFaceRepo,
      huggingFacePath: payload.cloudUpload?.huggingFacePath,
      taskFiles: Object.entries(payload.tasks ?? {}).map(([task, file]) => ({
        task,
        path: resolveManifestFilePath(path, file.path) ?? file.path,
        exampleCount: file.exampleCount,
        sourceCallCount: file.sourceCallCount,
        sourceTrajectoryCount: file.sourceTrajectoryCount,
      })),
      samplePreviews,
      llmCallPreviews,
    },
    payload,
  };
}

function isScenarioNativeExportManifest(payload: JsonRecord): boolean {
  return payload.schema === "eliza_scenario_native_export";
}

function isFeedTrajectoryDatasetManifest(payload: JsonRecord): boolean {
  return (
    payload.schema === "feed_training_trajectory_export" ||
    payload.schema === "feed_parallel_generation"
  );
}

function isHuggingFaceDatasetManifest(payload: JsonRecord): boolean {
  return payload.schema === HUGGINGFACE_DATASET_INGEST_SCHEMA;
}

function summarizeFeedSample(sample: JsonRecord): JsonRecord {
  const steps = Array.isArray(sample.steps) ? sample.steps : [];
  const firstStep = steps.find(isRecord) ?? {};
  return {
    trajectoryId: sample.trajectory_id ?? sample.trajectoryId,
    agentId: sample.agent_id ?? sample.agentId,
    archetype: sample.archetype,
    scenarioId: sample.scenario_id ?? sample.scenarioId,
    score: sample.score,
    finalPnl: sample.final_pnl ?? sample.finalPnl,
    steps: steps.length,
    firstStep:
      firstStep.action ??
      firstStep.type ??
      firstStep.event ??
      firstStep.kind ??
      firstStep.name,
    firstInput:
      firstStep.input ??
      firstStep.prompt ??
      firstStep.marketId ??
      firstStep.request ??
      firstStep.observation,
    firstOutput:
      firstStep.output ??
      firstStep.response ??
      firstStep.result ??
      firstStep.decision ??
      firstStep.action,
    reasoning: sample.reasoning,
  };
}

function summarizeScenarioNativeSample(sample: JsonRecord): JsonRecord {
  const request = isRecord(sample.request) ? sample.request : {};
  const response = isRecord(sample.response) ? sample.response : {};
  const metadata = isRecord(sample.metadata) ? sample.metadata : {};
  return {
    trajectoryId: sample.trajectoryId ?? metadata.trajectory_id,
    agentId: sample.agentId ?? metadata.agent_id,
    scenarioId: sample.scenarioId ?? metadata.scenario_id,
    purpose: sample.purpose ?? metadata.source_stage_kind,
    taskType: metadata.task_type,
    model: sample.model ?? metadata.source_model,
    provider: sample.provider ?? metadata.source_provider,
    input: request.messages ?? request.prompt,
    output: response.text ?? response.toolCalls,
    toolCalls: Array.isArray(response.toolCalls)
      ? response.toolCalls.length
      : undefined,
  };
}

async function summarizeTrajectoryDataset(
  path: string,
  payload: JsonRecord,
  roots: readonly string[],
): Promise<TrainingAnalysisArtifact> {
  const counts = isRecord(payload.counts) ? payload.counts : {};
  const source = isRecord(payload.source) ? payload.source : {};
  const files = Array.isArray(payload.files) ? payload.files : [];
  const jsonlPath = resolveManifestFilePath(path, payload.jsonlPath);
  const exportPath = resolveManifestFilePath(path, payload.exportPath);
  const outputDir = resolveManifestPath(path, payload.outputDir);
  const runDir = resolveManifestPath(path, payload.runDir);
  const feedSamplePreviews =
    (payload.schema === "feed_training_trajectory_export" ||
      payload.schema === "feed_parallel_generation")
      ? await readJsonlSamplePreviews(
          exportPath ?? jsonlPath,
          summarizeFeedSample,
        )
      : [];
  const hfSamplePreviews =
    payload.schema === HUGGINGFACE_DATASET_INGEST_SCHEMA
      ? await readHuggingFaceSamplePreviews(files, path)
      : [];
  const scenarioNativeSamplePreviews =
    payload.schema === "eliza_scenario_native_export"
      ? await readJsonlSamplePreviews(
          jsonlPath,
          summarizeScenarioNativeSample,
        )
      : [];
  return {
    id: artifactId("trajectory_dataset", path),
    kind: "trajectory_dataset",
    title:
      stringValue(source.kind) ??
      stringValue(payload.schema) ??
      stringValue(payload.source) ??
      basename(dirname(path)),
    path,
    generatedAt: stringValue(payload.generatedAt),
    summary: {
      relativePath: relativePath(path, roots),
      schema: payload.schema,
      source,
      outputDir,
      runDir,
      jsonlPath,
      exportPath,
      manifestPath: payload.manifestPath,
      rows: counts.rows,
      jsonlRows: counts.jsonlRows,
      files: counts.files,
      downloadedFiles: counts.downloadedFiles,
      bytes: counts.bytes,
      trajectories: counts.trajectories,
      trajectoryFiles: counts.trajectoryFiles,
      parsedTrajectories: counts.parsedTrajectories,
      totalTicks: counts.totalTicks,
      errors: counts.errors,
      durationMs: payload.durationMs,
      cleanup: payload.cleanup,
      skippedFiles: counts.skippedFiles,
      runIds: payload.runIds,
      scenarioIds: payload.scenarioIds,
      agentIds: payload.agentIds,
      trajectoryIds: payload.trajectoryIds,
      agentsCreated: payload.agentsCreated,
      archetypeStats: payload.archetypeStats,
      feedSamplePreviews,
      hfSamplePreviews,
      scenarioNativeSamplePreviews,
      hfFiles: files
        .filter((file): file is JsonRecord => isRecord(file))
        .map((file) => ({
          hfPath: file.hfPath,
          localPath: resolveManifestFilePath(path, file.localPath),
          rows: file.rows,
          bytes: file.bytes,
          status: file.status,
        })),
    },
    payload,
  };
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

function summarizeTestTrajectorySample(input: {
  payload: JsonRecord;
  transcript: readonly unknown[];
  llmCalls: readonly unknown[];
  actions: readonly unknown[];
  metadata: JsonRecord;
}): JsonRecord {
  const transcript = input.transcript.filter(isRecord);
  const llmCalls = input.llmCalls.filter(isRecord);
  const actions = input.actions.filter(isRecord);
  const firstUserTurn =
    transcript.find((turn) => turn.role === "user") ?? transcript[0] ?? {};
  const lastAssistantTurn =
    [...transcript].reverse().find((turn) => turn.role === "assistant") ??
    transcript[transcript.length - 1] ??
    {};
  const firstLlmCall = llmCalls[0] ?? {};
  const firstAction = actions[0] ?? {};
  const firstMemoryAction = Array.isArray(input.payload.memoriesWritten)
    ? input.payload.memoriesWritten
        .filter(isRecord)
        .flatMap((memory) => {
          const raw = isRecord(memory.raw) ? memory.raw : {};
          const content = isRecord(raw.content) ? raw.content : {};
          return [
            ...(Array.isArray(memory.contentActions)
              ? memory.contentActions
              : []),
            ...(Array.isArray(content.actions) ? content.actions : []),
          ];
        })
        .map(stringValue)
        .find(Boolean)
    : undefined;
  const actionName =
    stringValue(firstAction.actionName) ??
    stringValue(firstAction.name) ??
    stringValue(firstAction.type) ??
    firstMemoryAction;
  const output =
    stringValue(lastAssistantTurn.text) ??
    stringValue(firstLlmCall.response) ??
    stringValue(input.metadata.actualAction) ??
    stringValue(input.metadata.plannedAction) ??
    actionName;
  return {
    caseId: input.payload.caseId,
    scenarioId: input.payload.scenarioId,
    pass: input.metadata.pass,
    expectedAction: input.metadata.expectedAction,
    actualAction: input.metadata.actualAction,
    input: firstUserTurn.text ?? firstLlmCall.prompt ?? firstLlmCall.userPrompt,
    output,
    llmPurpose: firstLlmCall.purpose,
    llmInput: firstLlmCall.prompt ?? firstLlmCall.userPrompt,
    llmOutput: firstLlmCall.response,
    action: actionName,
    actionStatus: firstAction.actionStatus ?? firstAction.status,
  };
}

function summarizeTestTrajectoryRecord(
  path: string,
  payload: JsonRecord,
  roots: readonly string[],
): TrainingAnalysisArtifact {
  const agentTrajectory = isRecord(payload.agentTrajectory)
    ? payload.agentTrajectory
    : {};
  const llmCalls = Array.isArray(agentTrajectory.llmCalls)
    ? agentTrajectory.llmCalls
    : [];
  const providerSnapshots = Array.isArray(agentTrajectory.providerSnapshots)
    ? agentTrajectory.providerSnapshots
    : [];
  const transcript = Array.isArray(payload.transcript)
    ? payload.transcript
    : [];
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const memoriesWritten = Array.isArray(payload.memoriesWritten)
    ? payload.memoriesWritten
    : [];
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  return {
    id: artifactId("trajectory_dataset", path),
    kind: "trajectory_dataset",
    title:
      stringValue(payload.caseId) ??
      stringValue(payload.scenarioId) ??
      basename(path),
    path,
    generatedAt:
      typeof payload.endedAt === "number"
        ? new Date(payload.endedAt).toISOString()
        : undefined,
    summary: {
      relativePath: relativePath(path, roots),
      schema: "eliza_test_trajectory_record",
      source: { kind: "app_core_test_trajectory" },
      caseId: payload.caseId,
      scenarioId: payload.scenarioId,
      durationMs: payload.durationMs,
      transcriptTurns: transcript.length,
      llmCalls: llmCalls.length,
      providerSnapshots: providerSnapshots.length,
      actions: actions.length,
      memoriesWritten: memoriesWritten.length,
      pass: metadata.pass,
      selectionPass: metadata.selectionPass,
      executionPass: metadata.executionPass,
      expectedAction: metadata.expectedAction,
      plannedAction: metadata.plannedAction,
      actualAction: metadata.actualAction,
      failureMode: metadata.failureMode,
      tags: metadata.tags,
      testSamplePreviews: [
        summarizeTestTrajectorySample({
          payload,
          transcript,
          llmCalls,
          actions,
          metadata,
        }),
      ],
    },
    payload,
  };
}

function summarizeScenarioTurnPreviews(
  scenarios: readonly JsonRecord[],
): JsonRecord[] {
  const previews: JsonRecord[] = [];
  for (const scenario of scenarios) {
    const turns = Array.isArray(scenario.turns) ? scenario.turns : [];
    for (const turn of turns) {
      if (!isRecord(turn)) continue;
      previews.push({
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        turn: turn.name,
        kind: turn.kind,
        input: turn.text,
        output: turn.responseText,
        actions: Array.isArray(turn.actionsCalled)
          ? turn.actionsCalled
              .filter(isRecord)
              .map((action) => action.name ?? action.action ?? action.type)
          : undefined,
        failedAssertions: Array.isArray(turn.failedAssertions)
          ? turn.failedAssertions.length
          : undefined,
      });
      if (previews.length >= JSONL_SAMPLE_LIMIT) return previews;
    }
  }
  return previews;
}

function isScenarioReport(value: unknown): value is JsonRecord {
  const record = isRecord(value) ? value : null;
  return (
    record !== null &&
    typeof record.id === "string" &&
    typeof record.status === "string" &&
    typeof record.durationMs === "number"
  );
}

function looksLikeScenarioRun(payload: JsonRecord, fileName: string): boolean {
  if (payload.schema === "eliza_scenario_run_viewer_v1") return true;
  if (fileName !== "matrix.json" && !/^scenario-run/i.test(fileName)) {
    return false;
  }
  return (
    typeof payload.runId === "string" &&
    Array.isArray(payload.scenarios) &&
    payload.scenarios.some(isScenarioReport) &&
    typeof payload.totalCount === "number" &&
    typeof payload.passedCount === "number" &&
    typeof payload.failedCount === "number"
  );
}

function summarizeScenarioRun(
  path: string,
  payload: JsonRecord,
  roots: readonly string[],
): TrainingAnalysisArtifact {
  const report = isRecord(payload.report) ? payload.report : payload;
  const scenarios = Array.isArray(report.scenarios)
    ? report.scenarios.filter(isScenarioReport)
    : [];
  const statuses = scenarios.reduce<Record<string, number>>((acc, scenario) => {
    const status = String(scenario.status);
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  const runDir =
    resolveManifestPath(path, payload.runDir) ??
    (path.endsWith("matrix.json") ? dirname(path) : undefined);
  const nativeJsonlPath = resolveManifestFilePath(path, payload.nativeJsonlPath);
  const nativeManifestPath = resolveManifestFilePath(
    path,
    payload.nativeManifestPath,
  );
  const nativeExport = isRecord(payload.nativeExport)
    ? payload.nativeExport
    : undefined;
  const nativeManifest = isRecord(nativeExport?.manifest)
    ? nativeExport.manifest
    : undefined;
  const trajectories = isRecord(payload.trajectories)
    ? payload.trajectories
    : undefined;
  const trajectoryFiles = Array.isArray(trajectories?.files)
    ? trajectories.files.length
    : undefined;
  const turnPreviews = summarizeScenarioTurnPreviews(scenarios);

  return {
    id: artifactId("scenario_run", path),
    kind: "scenario_run",
    title:
      stringValue(report.runId) ??
      stringValue(payload.runId) ??
      basename(dirname(path)),
    path,
    generatedAt:
      stringValue(payload.generatedAt) ??
      stringValue(report.completedAtIso) ??
      stringValue(report.startedAtIso),
    summary: {
      relativePath: relativePath(path, roots),
      schema: payload.schema,
      runId: report.runId,
      runDir,
      viewerHtmlPath: runDir ? join(runDir, "viewer", "index.html") : undefined,
      nativeJsonlPath,
      nativeManifestPath,
      providerName: report.providerName,
      totalCount: report.totalCount,
      passedCount: report.passedCount,
      failedCount: report.failedCount,
      skippedCount: report.skippedCount,
      statuses,
      trajectoryFiles,
      nativeRows: isRecord(nativeManifest)
        ? isRecord(nativeManifest.counts)
          ? nativeManifest.counts.rows
          : undefined
        : undefined,
      scenarioIds: scenarios.map((scenario) => scenario.id),
      turnPreviews,
    },
    payload,
  };
}

function summarizeCollectionRun(
  path: string,
  payload: JsonRecord,
  roots: readonly string[],
): TrainingAnalysisArtifact {
  const analysis = isRecord(payload.analysis) ? payload.analysis : {};
  const steps = Array.isArray(payload.steps)
    ? payload.steps.filter(isRecord)
    : [];
  const statuses = steps.reduce<Record<string, number>>((acc, step) => {
    const status = stringValue(step.status) ?? "unknown";
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  const actionBenchmarkStep = steps.find(
    (step) => step.id === "action_benchmark",
  );
  const actionBenchmarkResult = isRecord(actionBenchmarkStep?.result)
    ? actionBenchmarkStep.result
    : {};
  const actionBenchmarkPairs = Array.isArray(actionBenchmarkResult.pairs)
    ? actionBenchmarkResult.pairs.filter(isRecord)
    : [];
  const actionBenchmarkMatrixSources = Array.isArray(
    actionBenchmarkResult.matrixSources,
  )
    ? actionBenchmarkResult.matrixSources.filter(isRecord)
    : [];
  const recipe = isRecord(payload.recipe) ? payload.recipe : {};
  const include = isRecord(recipe.include) ? recipe.include : {};
  const sources = isRecord(recipe.sources) ? recipe.sources : {};
  const evals = isRecord(recipe.evals) ? recipe.evals : {};
  return {
    id: artifactId("collection_run", path),
    kind: "collection_run",
    title: `Training collection ${basename(dirname(path))}`,
    path,
    generatedAt: stringValue(payload.generatedAt),
    summary: {
      relativePath: relativePath(path, roots),
      schema: payload.schema,
      outputDir: payload.outputDir,
      manifestPath: payload.manifestPath,
      readmePath: payload.readmePath,
      provenance: payload.provenance,
      viewerHtmlPath: analysis.indexHtmlPath,
      analysisManifestPath: analysis.manifestPath,
      artifactCount: analysis.artifactCount,
      steps: steps.length,
      statuses,
      stepIds: steps.map((step) => step.id),
      actionBenchmarkPairs: actionBenchmarkPairs.length,
      actionBenchmarkMatrixSources: actionBenchmarkMatrixSources.length,
      includedSteps: Object.entries(include)
        .filter((entry) => entry[1] === true)
        .map(([key]) => key),
      sourceRecipeKeys: Object.entries(sources)
        .filter(
          (entry) => isRecord(entry[1]) && Object.keys(entry[1]).length > 0,
        )
        .map(([key]) => key),
      evalRecipeKeys: Object.entries(evals)
        .filter((entry) =>
          Array.isArray(entry[1])
            ? entry[1].length > 0
            : isRecord(entry[1]) && Object.keys(entry[1]).length > 0,
        )
        .map(([key]) => key),
    },
    payload,
  };
}

function looksLikeTrainingJsonl(
  path: string,
  samples: readonly JsonRecord[],
): boolean {
  if (samples.length === 0) return false;
  const name = basename(path).toLowerCase();
  if (
    /trajectory|trajectories|dataset|training|train|validation|val|test|sft|dpo/.test(
      name,
    )
  ) {
    return true;
  }
  return samples.some((sample) => {
    const schema = stringValue(sample.schema);
    const sourceDataset = stringValue(sample.source_dataset);
    return (
      schema?.includes("trajectory") === true ||
      schema?.includes("training") === true ||
      sourceDataset?.includes("trajectory") === true ||
      stringValue(sample.trajectoryId) !== undefined ||
      stringValue(sample.trajectory_id) !== undefined ||
      stringValue(sample.prompt) !== undefined ||
      stringValue(sample.input) !== undefined ||
      stringValue(sample.output) !== undefined ||
      isRecord(sample.request) ||
      isRecord(sample.response) ||
      Array.isArray(sample.messages)
    );
  });
}

function summarizeJsonlSample(sample: JsonRecord): JsonRecord {
  const messages = Array.isArray(sample.messages) ? sample.messages : [];
  const request = isRecord(sample.request) ? sample.request : {};
  const response = isRecord(sample.response) ? sample.response : {};
  const metadata = isRecord(sample.metadata) ? sample.metadata : {};
  const requestMessages = Array.isArray(request.messages)
    ? request.messages
    : [];
  const messageRecords = messages.filter(isRecord);
  const requestMessageRecords = requestMessages.filter(isRecord);
  const lastUserMessage = [...messageRecords]
    .reverse()
    .find((message) => stringValue(message.role) === "user");
  const lastAssistantMessage = [...messageRecords]
    .reverse()
    .find((message) => stringValue(message.role) === "assistant");
  const lastRequestUserMessage = [...requestMessageRecords]
    .reverse()
    .find((message) => stringValue(message.role) === "user");
  return {
    task: sample.task ?? metadata.task_type,
    schema: sample.schema,
    sourceDataset: sample.source_dataset ?? metadata.source_dataset,
    trajectoryId:
      sample.trajectoryId ?? sample.trajectory_id ?? metadata.trajectory_id,
    scenarioId: sample.scenarioId ?? sample.scenario_id ?? metadata.scenario_id,
    input:
      sample.input ??
      sample.prompt ??
      lastUserMessage?.content ??
      lastUserMessage?.text ??
      request.prompt ??
      lastRequestUserMessage?.content ??
      lastRequestUserMessage?.text ??
      sample.messages ??
      request.messages,
    output:
      sample.output ??
      sample.completion ??
      lastAssistantMessage?.content ??
      lastAssistantMessage?.text ??
      response.text ??
      (isRecord(sample.response) ? undefined : sample.response) ??
      response.toolCalls,
  };
}

async function readHuggingFaceSamplePreviews(
  files: readonly unknown[],
  manifestPath: string,
): Promise<JsonRecord[]> {
  const previews: JsonRecord[] = [];
  for (const file of files) {
    if (!isRecord(file)) continue;
    const hfPath = stringValue(file.hfPath);
    const localPath = resolveManifestFilePath(manifestPath, file.localPath);
    const status = stringValue(file.status);
    if (
      !localPath ||
      status === "dry_run" ||
      !localPath.endsWith(".jsonl") ||
      !existsSync(localPath)
    ) {
      continue;
    }
    const rows = await readJsonlSamplePreviews(localPath, (sample) => ({
      hfPath,
      localPath,
      ...summarizeJsonlSample(sample),
    }));
    previews.push(...rows);
    if (previews.length >= JSONL_SAMPLE_LIMIT) {
      return previews.slice(0, JSONL_SAMPLE_LIMIT);
    }
  }
  return previews;
}

async function readJsonlDatasetArtifact(
  path: string,
  roots: readonly string[],
): Promise<TrainingAnalysisArtifact | null> {
  let rows = 0;
  let parseErrors = 0;
  const schemas = new Set<string>();
  const sourceDatasets = new Set<string>();
  const trajectoryIds = new Set<string>();
  const samples: JsonRecord[] = [];
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows += 1;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) continue;
      if (samples.length < JSONL_SAMPLE_LIMIT) samples.push(parsed);
      const schema = stringValue(parsed.schema);
      const sourceDataset = stringValue(parsed.source_dataset);
      const trajectoryId =
        stringValue(parsed.trajectoryId) ?? stringValue(parsed.trajectory_id);
      if (schema) schemas.add(schema);
      if (sourceDataset) sourceDatasets.add(sourceDataset);
      if (trajectoryId && trajectoryIds.size < 50)
        trajectoryIds.add(trajectoryId);
    } catch {
      parseErrors += 1;
    }
  }

  if (!looksLikeTrainingJsonl(path, samples)) return null;
  const schemaList = [...schemas].sort();
  const sourceDatasetList = [...sourceDatasets].sort();
  const firstSample = samples[0] ?? {};
  const title =
    stringValue(firstSample.task) ??
    sourceDatasetList[0] ??
    schemaList[0] ??
    basename(path);
  const payload = {
    schema: TRAINING_JSONL_DATASET_SCHEMA,
    schemaVersion: 1,
    source: { kind: "jsonl_training_dataset" },
    path,
    rows,
    parseErrors,
    schemas: schemaList,
    sourceDatasets: sourceDatasetList,
    trajectoryIds: [...trajectoryIds],
    samples,
  };
  const samplePreviews = samples.map(summarizeJsonlSample);

  return {
    id: artifactId("trajectory_dataset", path),
    kind: "trajectory_dataset",
    title,
    path,
    summary: {
      relativePath: relativePath(path, roots),
      schema: TRAINING_JSONL_DATASET_SCHEMA,
      source: payload.source,
      rows,
      parseErrors,
      sampleRows: samples.length,
      schemas: schemaList,
      sourceDatasets: sourceDatasetList,
      trajectoryIds: payload.trajectoryIds,
      samplePreviews,
    },
    payload,
  };
}

function summarizeRun(
  path: string,
  payload: TrainingRunRecord,
  roots: readonly string[],
): TrainingAnalysisArtifact {
  return {
    id: artifactId("training_run", path),
    kind: "training_run",
    title: payload.runId,
    path,
    generatedAt: payload.finishedAt ?? payload.startedAt,
    summary: {
      relativePath: relativePath(path, roots),
      status: payload.status,
      task: payload.task,
      backend: payload.backend,
      source: payload.source,
      datasetSize: payload.datasetSize,
      pulledTrajectories: payload.pulledTrajectories,
      filteredTrajectories: payload.filteredTrajectories,
      artifactPath: payload.artifactPath,
    },
    payload,
  };
}

function looksLikeEval(payload: JsonRecord, fileName: string): boolean {
  if (payload.schema === EVAL_COMPARISON_ARTIFACT_SCHEMA) return true;
  if (payload.schema === TRAINING_READINESS_REPORT_SCHEMA) return true;
  if (payload.schema === ACTION_BENCHMARK_REPORT_SCHEMA) return true;
  if (/^_?eval|served_eval|benchmark/i.test(fileName)) return true;
  return (
    isRecord(payload.base_model) ||
    isRecord(payload.adapter_model) ||
    isRecord(payload.trained_model) ||
    isRecord(payload.baseSummary) ||
    isRecord(payload.eval_summary) ||
    stringValue(payload.benchmark_id) !== undefined ||
    stringValue(payload.benchmark) !== undefined
  );
}

function looksLikeBenchmarkMatrix(
  payload: JsonRecord,
  fileName: string,
): boolean {
  return (
    payload.schema === BENCHMARK_MATRIX_ARTIFACT_SCHEMA ||
    /^benchmark-matrix/i.test(fileName)
  );
}

function summarizeBenchmarkModelStats(payload: JsonRecord): JsonRecord[] {
  const rows = Array.isArray(payload.rows)
    ? payload.rows.filter((row): row is JsonRecord => isRecord(row))
    : [];
  const groups = new Map<
    string,
    {
      modelId: string;
      tier?: unknown;
      variant?: unknown;
      provider?: unknown;
      datasetVersion?: unknown;
      benchmarks: Set<string>;
      scores: number[];
    }
  >();

  for (const row of rows) {
    const modelId = stringValue(row.modelId);
    if (!modelId) continue;
    const group = groups.get(modelId) ?? {
      modelId,
      tier: row.tier,
      variant: row.variant,
      provider: row.provider,
      datasetVersion: row.datasetVersion,
      benchmarks: new Set<string>(),
      scores: [],
    };
    const benchmark = stringValue(row.benchmark);
    if (benchmark) group.benchmarks.add(benchmark);
    const score = numberValue(row.score);
    if (score !== undefined) group.scores.push(score);
    groups.set(modelId, group);
  }

  return [...groups.values()]
    .map((group) => {
      const scoreCount = group.scores.length;
      const averageScore =
        scoreCount > 0
          ? Number(
              (
                group.scores.reduce((total, score) => total + score, 0) /
                scoreCount
              ).toFixed(4),
            )
          : null;
      return {
        modelId: group.modelId,
        tier: group.tier,
        variant: group.variant,
        provider: group.provider,
        datasetVersion: group.datasetVersion,
        benchmarkCount: group.benchmarks.size,
        scoreCount,
        averageScore,
        bestScore: scoreCount > 0 ? Math.max(...group.scores) : null,
        worstScore: scoreCount > 0 ? Math.min(...group.scores) : null,
      };
    })
    .sort((left, right) => {
      const byTier = String(left.tier ?? "").localeCompare(
        String(right.tier ?? ""),
      );
      if (byTier !== 0) return byTier;
      const byVariant = String(left.variant ?? "").localeCompare(
        String(right.variant ?? ""),
      );
      if (byVariant !== 0) return byVariant;
      return String(left.modelId).localeCompare(String(right.modelId));
    });
}

function summarizeBenchmarkMatrix(
  path: string,
  payload: JsonRecord,
  roots: readonly string[],
): TrainingAnalysisArtifact {
  const counts = isRecord(payload.counts) ? payload.counts : {};
  const modelStats = summarizeBenchmarkModelStats(payload);
  return {
    id: artifactId("benchmark_matrix", path),
    kind: "benchmark_matrix",
    title: "Eliza-1 benchmark matrix",
    path,
    generatedAt: stringValue(payload.generatedAt),
    summary: {
      relativePath: relativePath(path, roots),
      schema: payload.schema,
      referenceModelId: payload.referenceModelId,
      tiers: payload.tiers,
      benchmarks: payload.benchmarks,
      rows: counts.rows,
      comparisons: counts.comparisons,
      models: modelStats.length,
      modelStats,
    },
    payload,
  };
}

function firstStringValue(
  record: JsonRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function firstNumberValue(
  record: JsonRecord,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function summarizeEvalComparisonSamples(payload: JsonRecord): JsonRecord[] {
  const summaries = isRecord(payload.summaries) ? payload.summaries : {};
  const summaryComparison = isRecord(summaries.comparison)
    ? summaries.comparison
    : {};
  const raw = isRecord(payload.raw) ? payload.raw : {};
  const rawComparison = isRecord(raw.comparison) ? raw.comparison : {};
  const rows = Array.isArray(summaryComparison.per_prompt)
    ? summaryComparison.per_prompt
    : Array.isArray(rawComparison.per_prompt)
      ? rawComparison.per_prompt
      : Array.isArray(payload.per_prompt)
        ? payload.per_prompt
        : [];
  return rows
    .map((row): JsonRecord | null => (isRecord(row) ? row : null))
    .filter((row): row is JsonRecord => row !== null)
    .slice(0, 25)
    .map((row) => ({
      prompt:
        firstStringValue(row, ["prompt", "input", "userPrompt", "user_prompt"]) ??
        row.messages,
      expected: row.expected ?? row.expectedOutput ?? row.expected_output,
      baseOutput:
        row.baseOutput ??
        row.base_output ??
        row.baseResponse ??
        row.base_response,
      trainedOutput:
        row.trainedOutput ??
        row.trained_output ??
        row.adapterOutput ??
        row.adapter_output ??
        row.trainedResponse ??
        row.trained_response ??
        row.adapterResponse ??
        row.adapter_response,
      baseScore: firstNumberValue(row, ["baseScore", "base_score"]),
      trainedScore: firstNumberValue(row, [
        "trainedScore",
        "trained_score",
        "adapterScore",
        "adapter_score",
      ]),
      improvement: firstNumberValue(row, [
        "improvement",
        "improvementAbsolute",
        "improvement_absolute",
      ]),
    }));
}

function summarizeEval(
  path: string,
  payload: JsonRecord,
  roots: readonly string[],
): TrainingAnalysisArtifact {
  if (payload.schema === TRAINING_READINESS_REPORT_SCHEMA) {
    const counts = isRecord(payload.counts) ? payload.counts : {};
    const checks = Array.isArray(payload.checks) ? payload.checks : [];
    return {
      id: artifactId("eval", path),
      kind: "eval",
      title: "Training readiness report",
      path,
      generatedAt: stringValue(payload.generatedAt),
      summary: {
        relativePath: relativePath(path, roots),
        schema: payload.schema,
        status: payload.status,
        checks: counts.checks,
        ready: counts.ready,
        partial: counts.partial,
        missing: counts.missing,
        artifactCount: counts.artifacts,
        reportPath: payload.reportPath,
        analysisIndexHtmlPath: payload.analysisIndexHtmlPath,
        failedChecks: checks
          .filter(
            (item): item is JsonRecord =>
              isRecord(item) && item.status !== "ready",
          )
          .map((item) => ({
            id: item.id,
            status: item.status,
            note: item.note,
          })),
      },
      payload,
    };
  }
  if (payload.schema === ACTION_BENCHMARK_REPORT_SCHEMA) {
    const summary = isRecord(payload.summary) ? payload.summary : {};
    const source = isRecord(payload.source) ? payload.source : {};
    const failureModes = isRecord(payload.failureModes)
      ? payload.failureModes
      : {};
    return {
      id: artifactId("eval", path),
      kind: "eval",
      title: "Action selection benchmark",
      path,
      generatedAt: stringValue(payload.generatedAt),
      summary: {
        relativePath: relativePath(path, roots),
        schema: payload.schema,
        source,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        accuracy: summary.accuracy,
        plannerAccuracy: summary.plannerAccuracy,
        executionAccuracy: summary.executionAccuracy,
        latency: summary.latency,
        cache: summary.cache,
        trajectoryDir: source.trajectoryDir,
        reportMarkdownPath: source.reportMarkdownPath,
        failureModes,
        results: Array.isArray(payload.results)
          ? payload.results.length
          : undefined,
        failures: Array.isArray(payload.failures)
          ? payload.failures.length
          : undefined,
      },
      payload,
    };
  }
  if (payload.schema === EVAL_COMPARISON_ARTIFACT_SCHEMA) {
    const metrics = isRecord(payload.metrics) ? payload.metrics : {};
    const models = isRecord(payload.models) ? payload.models : {};
    const evalSamplePreviews = summarizeEvalComparisonSamples(payload);
    return {
      id: artifactId("eval", path),
      kind: "eval",
      title: `Eval comparison: ${
        stringValue(models.base) ?? "base"
      } vs ${stringValue(models.trained) ?? "trained"}`,
      path,
      generatedAt: stringValue(payload.generatedAt),
      summary: {
        relativePath: relativePath(path, roots),
        schema: payload.schema,
        baseModel: models.base,
        trainedModel: models.trained,
        backend: models.backend,
        baseScore: metrics.baseScore,
        trainedScore: metrics.trainedScore,
        improvementAbsolute: metrics.improvementAbsolute,
        improvementPercent: metrics.improvementPercent,
        promptCount: metrics.promptCount,
        distinctResponseCount: metrics.distinctResponseCount,
        baseLatencyMs: metrics.baseLatencyMs,
        trainedLatencyMs: metrics.trainedLatencyMs,
        latencyDeltaMs: metrics.latencyDeltaMs,
        reportPath: payload.reportPath,
        evalSamplePreviews,
      },
      payload,
    };
  }
  const baseSummary = isRecord(payload.base_model)
    ? payload.base_model.summary
    : payload.baseSummary;
  const adapterSummary = isRecord(payload.adapter_model)
    ? payload.adapter_model.summary
    : payload.adapterSummary;
  return {
    id: artifactId("eval", path),
    kind: "eval",
    title:
      stringValue(payload.benchmark_id) ??
      stringValue(payload.benchmark) ??
      basename(path),
    path,
    generatedAt:
      stringValue(payload.generatedAt) ??
      stringValue(payload.created_at) ??
      stringValue(payload.timestamp),
    summary: {
      relativePath: relativePath(path, roots),
      benchmark: payload.benchmark_id ?? payload.benchmark,
      model: payload.model ?? payload.model_name,
      baseSummary,
      adapterSummary,
      score: payload.score,
      passRate: payload.pass_rate ?? payload.passRate,
      improvementPct: payload.improvement_pct ?? payload.improvementPct,
    },
    payload,
  };
}

function looksLikeModelManifest(
  payload: JsonRecord,
  fileName: string,
): boolean {
  if (payload.schema === ELIZA1_BUNDLE_STAGE_SCHEMA) return true;
  if (/manifest/i.test(fileName)) {
    return (
      stringValue(payload.model_name) !== undefined ||
      stringValue(payload.modelId) !== undefined ||
      stringValue(payload.model) !== undefined ||
      stringValue(payload.output_path) !== undefined ||
      isRecord(payload.served_evaluation) ||
      isRecord(payload.runtime) ||
      isRecord(payload.kernels)
    );
  }
  return false;
}

function summarizeModel(
  path: string,
  payload: JsonRecord,
  roots: readonly string[],
): TrainingAnalysisArtifact {
  const servedEvaluation = isRecord(payload.served_evaluation)
    ? payload.served_evaluation
    : {};
  const baseEvaluation = isRecord(servedEvaluation.base_summary)
    ? servedEvaluation.base_summary
    : {};
  const adapterEvaluation = isRecord(servedEvaluation.adapter_summary)
    ? servedEvaluation.adapter_summary
    : {};
  const registry = isRecord(payload.registry) ? payload.registry : {};
  const baseScore =
    numberValue(baseEvaluation.avg_score) ?? numberValue(baseEvaluation.score);
  const trainedScore =
    numberValue(adapterEvaluation.avg_score) ??
    numberValue(adapterEvaluation.score);
  const improvementPercent =
    baseScore !== undefined && trainedScore !== undefined && baseScore !== 0
      ? Number(
          (((trainedScore - baseScore) / Math.abs(baseScore)) * 100).toFixed(4),
        )
      : undefined;
  return {
    id: artifactId("model", path),
    kind: "model",
    title:
      stringValue(payload.bundleDir) ??
      (payload.schema === ELIZA1_BUNDLE_STAGE_SCHEMA
        ? `Eliza-1 ${stringValue(payload.tier) ?? "bundle"} stage`
        : undefined) ??
      stringValue(payload.model_name) ??
      stringValue(payload.modelId) ??
      stringValue(payload.model) ??
      stringValue(payload.name) ??
      basename(dirname(path)),
    path,
    generatedAt:
      stringValue(payload.generatedAt) ??
      stringValue(payload.created_at) ??
      stringValue(payload.trained_at),
    summary: {
      relativePath: relativePath(path, roots),
      schema: payload.schema,
      model: payload.model_name ?? payload.modelId ?? payload.model ?? payload.name,
      variant: payload.variant,
      outputPath: payload.output_path ?? payload.outputPath,
      baseModel: payload.base_model ?? payload.baseModel,
      trainedAt: payload.trained_at ?? payload.trainedAt,
      trainingRunId: payload.run_id ?? payload.runId,
      trainingJobId: payload.job_id ?? payload.jobId,
      tier: payload.tier,
      repoId: payload.repoId ?? registry.repoId,
      bundleDir: payload.bundleDir,
      fileCount: payload.fileCount,
      plannedBytes: payload.plannedBytes,
      stagedCount: payload.stagedCount,
      apply: payload.apply,
      servedEvaluation: payload.served_evaluation,
      baseEvalScore: baseScore,
      trainedEvalScore: trainedScore,
      evalImprovementPercent: improvementPercent,
    },
    payload,
  };
}

async function classifyArtifact(
  path: string,
  payload: unknown,
  roots: readonly string[],
): Promise<TrainingAnalysisArtifact | null> {
  if (!isRecord(payload)) return null;
  const fileName = basename(path);

  if (payload.schema === TRAJECTORY_EXPORT_BUNDLE_SCHEMA) {
    return await summarizeBundle(
      path,
      payload as unknown as TrajectoryExportBundleManifest,
      roots,
    );
  }
  if (
    isScenarioNativeExportManifest(payload) ||
    isFeedTrajectoryDatasetManifest(payload) ||
    isHuggingFaceDatasetManifest(payload)
  ) {
    return await summarizeTrajectoryDataset(path, payload, roots);
  }
  if (looksLikeTestTrajectoryRecord(payload)) {
    return summarizeTestTrajectoryRecord(path, payload, roots);
  }
  if (looksLikeScenarioRun(payload, fileName)) {
    return summarizeScenarioRun(path, payload, roots);
  }
  if (payload.schema === TRAINING_COLLECTION_RUN_SCHEMA) {
    return summarizeCollectionRun(path, payload, roots);
  }
  if (
    typeof payload.runId === "string" &&
    (payload.status === "queued" ||
      payload.status === "running" ||
      payload.status === "succeeded" ||
      payload.status === "failed" ||
      payload.status === "skipped") &&
    typeof payload.source === "string" &&
    typeof payload.datasetSize === "number"
  ) {
    return summarizeRun(path, payload as unknown as TrainingRunRecord, roots);
  }
  if (looksLikeBenchmarkMatrix(payload, fileName)) {
    return summarizeBenchmarkMatrix(path, payload, roots);
  }
  if (looksLikeEval(payload, fileName)) {
    return summarizeEval(path, payload, roots);
  }
  if (looksLikeModelManifest(payload, fileName)) {
    return summarizeModel(path, payload, roots);
  }
  return null;
}

function sortArtifacts(
  artifacts: TrainingAnalysisArtifact[],
): TrainingAnalysisArtifact[] {
  return [...artifacts].sort((a, b) => {
    const byDate = (b.generatedAt ?? "").localeCompare(a.generatedAt ?? "");
    if (byDate !== 0) return byDate;
    return a.path.localeCompare(b.path);
  });
}

function countByKind(
  artifacts: readonly TrainingAnalysisArtifact[],
  kind: TrainingAnalysisArtifact["kind"],
): number {
  return artifacts.filter((artifact) => artifact.kind === kind).length;
}

function summaryRecord(artifact: TrainingAnalysisArtifact): JsonRecord {
  return artifact.summary;
}

function schemaOf(artifact: TrainingAnalysisArtifact): string | undefined {
  return stringValue(summaryRecord(artifact).schema);
}

function sourceKindOf(artifact: TrainingAnalysisArtifact): string | undefined {
  const source = summaryRecord(artifact).source;
  if (typeof source === "string") return source;
  return isRecord(source) ? stringValue(source.kind) : undefined;
}

function countSummaryArray(
  artifact: TrainingAnalysisArtifact,
  key: string,
): number {
  const value = summaryRecord(artifact)[key];
  return Array.isArray(value) ? value.length : 0;
}

function countSamplesFor(
  artifacts: readonly TrainingAnalysisArtifact[],
  predicate: (artifact: TrainingAnalysisArtifact) => boolean,
  keys: readonly string[],
): number {
  return artifacts
    .filter(predicate)
    .reduce(
      (count, artifact) =>
        count +
        keys.reduce(
          (sampleCount, key) => sampleCount + countSummaryArray(artifact, key),
          0,
        ),
      0,
    );
}

function benchmarkPayloadRows(artifact: TrainingAnalysisArtifact): JsonRecord[] {
  const payload = isRecord(artifact.payload) ? artifact.payload : {};
  return Array.isArray(payload.rows)
    ? payload.rows
        .map((row) => (isRecord(row) ? row : null))
        .filter((row): row is JsonRecord => row !== null)
    : [];
}

function benchmarkPayloadComparisons(
  artifact: TrainingAnalysisArtifact,
): JsonRecord[] {
  const payload = isRecord(artifact.payload) ? artifact.payload : {};
  return Array.isArray(payload.comparisons)
    ? payload.comparisons
        .map((comparison) => (isRecord(comparison) ? comparison : null))
        .filter((comparison): comparison is JsonRecord => comparison !== null)
    : [];
}

function hasNumberMetric(record: JsonRecord, key: string): boolean {
  return numberValue(record[key]) !== undefined;
}

function isDryRunRecord(record: JsonRecord): boolean {
  const source = isRecord(record.source) ? record.source : {};
  const metrics = isRecord(record.metrics) ? record.metrics : {};
  const raw = isRecord(record.raw) ? record.raw : {};
  const rawSource = isRecord(raw.source) ? raw.source : {};
  return (
    record.dryRun === true ||
    source.dryRun === true ||
    metrics.dryRun === true ||
    raw.dryRun === true ||
    rawSource.dryRun === true
  );
}

function isMockedRecord(record: JsonRecord): boolean {
  const source = isRecord(record.source) ? record.source : {};
  const metrics = isRecord(record.metrics) ? record.metrics : {};
  const raw = isRecord(record.raw) ? record.raw : {};
  const rawSource = isRecord(raw.source) ? raw.source : {};
  return (
    record.useMocks === true ||
    source.useMocks === true ||
    metrics.useMocks === true ||
    raw.useMocks === true ||
    rawSource.useMocks === true
  );
}

function comparisonHasModelBackedRows(
  comparison: JsonRecord,
  rows: readonly JsonRecord[],
): boolean {
  const tier = normalizeElizaOneBenchmarkTier(stringValue(comparison.tier));
  const benchmark = stringValue(comparison.benchmark);
  if (!tier || !benchmark) return false;
  const hasVariant = (variant: "base" | "trained") =>
    rows.some(
      (row) =>
        row.variant === variant &&
        normalizeElizaOneBenchmarkTier(stringValue(row.tier)) === tier &&
        stringValue(row.benchmark) === benchmark &&
        !isDryRunRecord(row) &&
        !isMockedRecord(row) &&
        hasNumberMetric(row, "score"),
    );
  return hasVariant("base") && hasVariant("trained");
}

function buildAnalysisCoverage(
  artifacts: readonly TrainingAnalysisArtifact[],
): TrainingAnalysisCoverageSummary {
  const isHuggingFace = (artifact: TrainingAnalysisArtifact) =>
    artifact.kind === "trajectory_dataset" &&
    (schemaOf(artifact) === HUGGINGFACE_DATASET_INGEST_SCHEMA ||
      sourceKindOf(artifact) === "huggingface_dataset");
  const isFeed = (artifact: TrainingAnalysisArtifact) =>
    artifact.kind === "trajectory_dataset" &&
    (schemaOf(artifact) === "feed_training_trajectory_export" ||
      schemaOf(artifact) === "feed_parallel_generation");
  const isNatural = (artifact: TrainingAnalysisArtifact) =>
    artifact.kind === "trajectory_bundle" &&
    sourceKindOf(artifact) === "training_collection_natural_trajectories";
  const isScenario = (artifact: TrainingAnalysisArtifact) =>
    artifact.kind === "scenario_run" ||
    schemaOf(artifact) === "eliza_scenario_native_export";
  const isTest = (artifact: TrainingAnalysisArtifact) =>
    artifact.kind === "trajectory_dataset" &&
    sourceKindOf(artifact) === "app_core_test_trajectory";
  const isTrainingJsonl = (artifact: TrainingAnalysisArtifact) =>
    schemaOf(artifact) === TRAINING_JSONL_DATASET_SCHEMA;

  const readableSamples = {
    huggingFace: countSamplesFor(artifacts, isHuggingFace, [
      "hfSamplePreviews",
    ]),
    feed: countSamplesFor(artifacts, isFeed, ["feedSamplePreviews"]),
    natural: countSamplesFor(artifacts, isNatural, [
      "samplePreviews",
      "llmCallPreviews",
    ]),
    scenarios: countSamplesFor(artifacts, isScenario, [
      "turnPreviews",
      "scenarioNativeSamplePreviews",
    ]),
    tests: countSamplesFor(artifacts, isTest, ["testSamplePreviews"]),
    trainingJsonl: countSamplesFor(artifacts, isTrainingJsonl, [
      "samplePreviews",
    ]),
    total: 0,
  };
  readableSamples.total =
    readableSamples.huggingFace +
    readableSamples.feed +
    readableSamples.natural +
    readableSamples.scenarios +
    readableSamples.tests +
    readableSamples.trainingJsonl;

  const evalArtifacts = artifacts.filter((artifact) => artifact.kind === "eval");
  const evalComparisons = evalArtifacts.filter(
    (artifact) => schemaOf(artifact) === EVAL_COMPARISON_ARTIFACT_SCHEMA,
  );
  const scoredEvalComparisons = evalComparisons.filter((artifact) => {
    const summary = summaryRecord(artifact);
    return (
      hasNumberMetric(summary, "baseScore") &&
      hasNumberMetric(summary, "trainedScore") &&
      hasNumberMetric(summary, "improvementPercent")
    );
  });

  const benchmarkMatrices = artifacts.filter(
    (artifact) => artifact.kind === "benchmark_matrix",
  );
  const benchmarkComparisons = benchmarkMatrices.flatMap(
    benchmarkPayloadComparisons,
  );
  const benchmarkRows = benchmarkMatrices.flatMap(benchmarkPayloadRows);
  const scoredBenchmarkComparisons = benchmarkComparisons.filter(
    (comparison) =>
      !isDryRunRecord(comparison) &&
      comparisonHasModelBackedRows(comparison, benchmarkRows) &&
      hasNumberMetric(comparison, "baseScore") &&
      hasNumberMetric(comparison, "trainedScore") &&
      hasNumberMetric(comparison, "improvementPercent"),
  );
  const tierSet = new Set<string>();
  for (const row of benchmarkRows) {
    const tier = normalizeElizaOneBenchmarkTier(stringValue(row.tier));
    if (tier) tierSet.add(tier);
  }
  for (const comparison of benchmarkComparisons) {
    const tier = normalizeElizaOneBenchmarkTier(stringValue(comparison.tier));
    if (tier) tierSet.add(tier);
  }
  const tiers = [...tierSet].sort(canonicalElizaOneTierSort);
  const tierCoverage = ELIZA_ONE_BENCHMARK_TIERS.map((tier) => {
    const tierRows = benchmarkRows.filter(
      (row) => normalizeElizaOneBenchmarkTier(stringValue(row.tier)) === tier,
    );
    const liveTierRows = tierRows.filter(
      (row) => !isDryRunRecord(row) && !isMockedRecord(row),
    );
    const tierComparisons = benchmarkComparisons.filter(
      (comparison) =>
        normalizeElizaOneBenchmarkTier(stringValue(comparison.tier)) === tier,
    );
    const liveTierComparisons = tierComparisons.filter(
      (comparison) =>
        !isDryRunRecord(comparison) &&
        comparisonHasModelBackedRows(comparison, benchmarkRows),
    );
    const benchmarks = new Set(
      tierComparisons
        .map((comparison) => stringValue(comparison.benchmark))
        .filter((benchmark): benchmark is string => benchmark !== undefined),
    );
    for (const row of tierRows) {
      const benchmark = stringValue(row.benchmark);
      if (benchmark) benchmarks.add(benchmark);
    }
    return {
      tier,
      hasBase:
        liveTierRows.some((row) => row.variant === "base") ||
        liveTierComparisons.some((comparison) =>
          hasNumberMetric(comparison, "baseScore"),
        ),
      hasTrained:
        liveTierRows.some((row) => row.variant === "trained") ||
        liveTierComparisons.some((comparison) =>
          hasNumberMetric(comparison, "trainedScore"),
        ),
      hasReference:
        liveTierRows.some((row) => row.variant === "reference") ||
        liveTierComparisons.some((comparison) =>
          hasNumberMetric(comparison, "referenceScore"),
        ),
      hasImprovement: liveTierComparisons.some((comparison) =>
        hasNumberMetric(comparison, "improvementPercent"),
      ),
      benchmarkCount: benchmarks.size,
      comparisonCount: tierComparisons.length,
    };
  });

  const modelArtifacts = artifacts.filter((artifact) => artifact.kind === "model");
  return {
    dataSources: {
      huggingFace: artifacts.filter(isHuggingFace).length,
      feed: artifacts.filter(isFeed).length,
      natural: artifacts.filter(isNatural).length,
      scenarios: artifacts.filter(isScenario).length,
      tests: artifacts.filter(isTest).length,
      trainingJsonl: artifacts.filter(isTrainingJsonl).length,
    },
    readableSamples,
    evals: {
      artifacts: evalArtifacts.length,
      comparisons: evalComparisons.length,
      scoredComparisons: scoredEvalComparisons.length,
    },
    benchmarks: {
      matrices: benchmarkMatrices.length,
      comparisons: benchmarkComparisons.length,
      scoredComparisons: scoredBenchmarkComparisons.length,
      caseSamples: benchmarkRows.reduce((count, row) => {
        const raw = isRecord(row.raw) ? row.raw : {};
        return count + (Array.isArray(raw.caseSamples) ? raw.caseSamples.length : 0);
      }, 0),
      tiers,
      allEliza1TiersCovered: tierCoverage.every(
        (tier) =>
          tier.hasBase &&
          tier.hasTrained &&
          tier.hasReference &&
          tier.hasImprovement,
      ),
      tierCoverage,
    },
    models: {
      artifacts: modelArtifacts.length,
      stagedBundles: modelArtifacts.filter(
        (artifact) => schemaOf(artifact) === ELIZA1_BUNDLE_STAGE_SCHEMA,
      ).length,
      inventory: modelArtifacts
        .map((artifact) => summaryRecord(artifact))
        .filter(
          (summary) =>
            stringValue(summary.model) !== undefined ||
            stringValue(summary.outputPath) !== undefined,
        )
        .map((summary) => ({
          model: stringValue(summary.model) ?? null,
          tier: normalizeElizaOneBenchmarkTier(stringValue(summary.tier)) ?? null,
          variant: stringValue(summary.variant) ?? null,
          baseModel: stringValue(summary.baseModel) ?? null,
          outputPath: stringValue(summary.outputPath) ?? null,
          baseEvalScore: numberValue(summary.baseEvalScore) ?? null,
          trainedEvalScore: numberValue(summary.trainedEvalScore) ?? null,
          evalImprovementPercent:
            numberValue(summary.evalImprovementPercent) ?? null,
        })),
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function pathLink(path: unknown): string | undefined {
  const value = stringValue(path);
  return value ? pathToFileURL(value).href : undefined;
}

function sourceLink(label: string, path: unknown): {
  label: string;
  path: string;
  href: string | undefined;
} | null {
  const value = stringValue(path);
  return value ? { label, path: value, href: pathLink(value) } : null;
}

function enrichArtifactLinks(
  artifact: TrainingAnalysisArtifact,
): TrainingAnalysisArtifact {
  const summary = artifact.summary;
  const payload = isRecord(artifact.payload) ? artifact.payload : {};
  const payloadSource = isRecord(payload.source) ? payload.source : {};
  const benchmarkResults = Array.isArray(payload.results)
    ? payload.results
        .map((result) => (isRecord(result) ? result : null))
        .filter((result): result is JsonRecord => result !== null)
    : [];
  const links = [
    sourceLink("artifact", artifact.path),
    sourceLink("viewer", summary.viewerHtmlPath),
    sourceLink("raw-jsonl", summary.rawJsonlPath),
    sourceLink("sanitized-jsonl", summary.sanitizedJsonlPath),
    sourceLink("jsonl", summary.jsonlPath),
    sourceLink("native-jsonl", summary.nativeJsonlPath),
    sourceLink("native-manifest", summary.nativeManifestPath),
    sourceLink("export", summary.exportPath),
    sourceLink("report", summary.reportPath ?? summary.reportMarkdownPath),
    sourceLink("manifest", summary.manifestPath),
    sourceLink("readme", summary.readmePath),
    sourceLink("task-dataset-summary", summary.taskDatasetSummaryPath),
    sourceLink("task-dataset-dir", summary.taskDatasetDir),
    sourceLink("output", summary.outputDir),
    sourceLink("trajectory-dir", summary.trajectoryDir ?? payloadSource.trajectoryDir),
    ...(Array.isArray(summary.taskFiles) ? summary.taskFiles : [])
      .map((file) => (isRecord(file) ? file : null))
      .filter((file): file is JsonRecord => file !== null)
      .map((file) => sourceLink(`task-${stringValue(file.task) ?? "dataset"}`, file.path)),
    ...(Array.isArray(summary.hfFiles) ? summary.hfFiles : [])
      .map((file) => (isRecord(file) ? file : null))
      .filter((file): file is JsonRecord => file !== null)
      .map((file) => sourceLink(`hf-${stringValue(file.hfPath) ?? "file"}`, file.localPath)),
    ...benchmarkResults
      .map((result) =>
        sourceLink(
          `benchmark-trajectory-${stringValue(result.caseId) ?? "case"}`,
          result.trajectoryPath,
        ),
      ),
  ].filter((link): link is NonNullable<typeof link> => link !== null);
  const uniqueLinks = Array.from(
    new Map(links.map((link) => [`${link.label}:${link.path}`, link])).values(),
  );
  return {
    ...artifact,
    summary: {
      ...summary,
      sourceLinks: uniqueLinks,
    },
  };
}

function buildIndexHtml(manifest: TrainingAnalysisIndexManifest): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Eliza Training Analysis</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f2eb;
      --ink: #181614;
      --muted: #70685f;
      --line: #d7cec1;
      --panel: #fffdf9;
      --accent: #b7431f;
      --accent-ink: #fff7f2;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #151412;
        --ink: #f5eee4;
        --muted: #beb3a6;
        --line: #3a332c;
        --panel: #211e1a;
        --accent: #e66d37;
        --accent-ink: #21120b;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    header {
      padding: 24px clamp(16px, 4vw, 48px) 18px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(26px, 4vw, 44px);
      letter-spacing: 0;
    }
    .meta {
      color: var(--muted);
      display: flex;
      flex-wrap: wrap;
      gap: 10px 18px;
      font-size: 14px;
    }
    main {
      padding: 18px clamp(16px, 4vw, 48px) 48px;
    }
    .tabs, .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }
    button, input, select {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--ink);
      font: inherit;
      padding: 9px 12px;
    }
    button {
      cursor: pointer;
    }
    button[aria-selected="true"] {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--accent-ink);
    }
    input {
      min-width: min(100%, 320px);
    }
    select {
      min-width: min(100%, 180px);
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .metric, .row {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 12px;
    }
    .metric strong {
      display: block;
      font-size: 24px;
    }
    .metric span, .label, .path {
      color: var(--muted);
      font-size: 13px;
    }
    .split {
      display: grid;
      grid-template-columns: minmax(240px, 360px) 1fr;
      gap: 14px;
      align-items: start;
    }
    .list {
      display: grid;
      gap: 8px;
      max-height: 72vh;
      overflow: auto;
    }
    .row {
      text-align: left;
      width: 100%;
    }
    .row.active {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .row strong {
      display: block;
      overflow-wrap: anywhere;
    }
    .detail {
      display: grid;
      gap: 12px;
      max-height: 78vh;
      overflow: auto;
    }
    .detail-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 14px;
    }
    .detail-card h2 {
      margin: 0 0 10px;
      font-size: 16px;
      letter-spacing: 0;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px 12px;
    }
    .summary-item {
      min-width: 0;
    }
    .summary-item span {
      display: block;
      color: var(--muted);
      font-size: 12px;
    }
    .summary-item strong {
      display: block;
      overflow-wrap: anywhere;
      font-size: 13px;
      font-weight: 600;
    }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .source-inventory, .source-samples {
      margin-bottom: 14px;
    }
    .source-inventory h2, .source-samples h2, .coverage-summary h2 {
      margin: 0 0 10px;
      font-size: 16px;
      letter-spacing: 0;
    }
    .source-samples .sample-note {
      color: var(--muted);
      font-size: 12px;
      margin: -4px 0 10px;
    }
    .inventory-grid, .coverage-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 8px;
    }
    .inventory-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 10px 12px;
      text-align: left;
    }
    .inventory-item[aria-selected="true"] {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--accent-ink);
    }
    .inventory-item[aria-selected="true"] span {
      color: var(--accent-ink);
    }
    .inventory-item strong {
      display: block;
      font-size: 20px;
    }
    .inventory-item span {
      color: var(--muted);
      display: block;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .coverage-summary {
      margin-bottom: 14px;
    }
    .coverage-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 10px 12px;
      min-width: 0;
    }
    .coverage-item strong {
      display: block;
      font-size: 18px;
      overflow-wrap: anywhere;
    }
    .coverage-item span {
      color: var(--muted);
      display: block;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    a {
      color: var(--accent);
      overflow-wrap: anywhere;
    }
    .links a {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 9px;
      background: var(--bg);
      text-decoration: none;
      font-size: 13px;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 680px;
      font-size: 13px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      background: var(--bg);
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 600;
      text-transform: lowercase;
      white-space: nowrap;
    }
    .status-ready, .status-succeeded, .status-passed {
      color: #166534;
      border-color: #86efac;
      background: #dcfce7;
    }
    .status-partial, .status-skipped {
      color: #854d0e;
      border-color: #fde68a;
      background: #fef3c7;
    }
    .status-missing, .status-failed, .status-broken {
      color: #991b1b;
      border-color: #fecaca;
      background: #fee2e2;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 14px;
      font-size: 12px;
    }
    @media (max-width: 780px) {
      .split { grid-template-columns: 1fr; }
      .detail { max-height: none; }
      pre { max-height: none; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Eliza Training Analysis</h1>
    <div class="meta">
      <span>Generated ${escapeHtml(manifest.generatedAt)}</span>
      <span>${manifest.counts.artifacts} artifacts</span>
      <span>${manifest.roots.length} scanned roots</span>
    </div>
  </header>
  <main>
    <section class="metrics" aria-label="Artifact counts">
      <div class="metric"><strong>${manifest.counts.trajectoryBundles}</strong><span>Trajectory bundles</span></div>
      <div class="metric"><strong>${manifest.counts.trajectoryDatasets}</strong><span>Trajectory datasets</span></div>
      <div class="metric"><strong>${manifest.counts.scenarioRuns}</strong><span>Scenario runs</span></div>
      <div class="metric"><strong>${manifest.counts.collectionRuns}</strong><span>Collections</span></div>
      <div class="metric"><strong>${manifest.counts.trainingRuns}</strong><span>Training runs</span></div>
      <div class="metric"><strong>${manifest.counts.evals}</strong><span>Evals</span></div>
      <div class="metric"><strong>${manifest.counts.benchmarkMatrices}</strong><span>Benchmark matrices</span></div>
      <div class="metric"><strong>${manifest.counts.models}</strong><span>Models</span></div>
    </section>
    <nav class="tabs" aria-label="Artifact sections">
      <button type="button" data-kind="all" aria-selected="true">All</button>
      <button type="button" data-kind="trajectory_bundle" aria-selected="false">Trajectories</button>
      <button type="button" data-kind="trajectory_dataset" aria-selected="false">Datasets</button>
      <button type="button" data-kind="scenario_run" aria-selected="false">Scenarios</button>
      <button type="button" data-kind="collection_run" aria-selected="false">Collections</button>
      <button type="button" data-kind="training_run" aria-selected="false">Runs</button>
      <button type="button" data-kind="eval" aria-selected="false">Evals</button>
      <button type="button" data-kind="benchmark_matrix" aria-selected="false">Benchmarks</button>
      <button type="button" data-kind="model" aria-selected="false">Models</button>
    </nav>
    <div class="filters">
      <input id="search" type="search" placeholder="Filter artifacts">
      <select id="run-filter" aria-label="Filter by run">
        <option value="all">All runs</option>
      </select>
      <select id="tier-filter" aria-label="Filter by Eliza-1 tier">
        <option value="all">All tiers</option>
      </select>
    </div>
    <section class="source-inventory detail-card" aria-label="Source inventory">
      <h2>Source inventory</h2>
      <div class="inventory-grid" id="source-inventory"></div>
    </section>
    <section class="source-samples detail-card" aria-label="Readable source samples">
      <h2>Readable source samples</h2>
      <p class="sample-note" id="source-sample-note"></p>
      <div class="table-wrap" id="source-samples"></div>
    </section>
    <section class="coverage-summary detail-card" aria-label="End-to-end coverage">
      <h2>End-to-end coverage</h2>
      <div class="coverage-grid" id="coverage-summary"></div>
    </section>
    <section class="split">
      <div class="list" id="artifact-list"></div>
      <div class="detail" id="artifact-detail"></div>
    </section>
  </main>
  <script type="application/json" id="analysis-data">${escapeScriptJson(manifest)}</script>
  <script>
    const manifest = JSON.parse(document.getElementById("analysis-data").textContent);
    let selectedKind = "all";
    let selectedSourceCategory = "all";
    let selectedRunId = "all";
    let selectedTier = "all";
    let selectedIndex = 0;
    const list = document.getElementById("artifact-list");
    const detail = document.getElementById("artifact-detail");
    const search = document.getElementById("search");
    const runFilter = document.getElementById("run-filter");
    const tierFilter = document.getElementById("tier-filter");
    const sourceInventory = document.getElementById("source-inventory");
    const sourceSamples = document.getElementById("source-samples");
    const sourceSampleNote = document.getElementById("source-sample-note");
    const coverageSummary = document.getElementById("coverage-summary");
    const pretty = (value) => JSON.stringify(value, null, 2);
    const compactValue = (value) => {
      if (value === null || value === undefined || value === "") return "n/a";
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return JSON.stringify(value);
    };
    const asRecord = (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
    const asArray = (value) => Array.isArray(value) ? value : [];
    const stringValue = (value) =>
      typeof value === "string" && value.trim() ? value.trim() : null;
    const statusClass = (value) => "status-pill status-" + String(value || "unknown").toLowerCase();
    function addUnique(list, value) {
      const normalized = stringValue(value);
      if (normalized && !list.includes(normalized)) list.push(normalized);
    }
    function addRunIdsFromSource(list, source) {
      const record = asRecord(source);
      if (!record) return;
      addUnique(list, record.runId);
      for (const runId of asArray(record.runIds)) addUnique(list, runId);
    }
    function artifactRunIds(artifact) {
      const summary = asRecord(artifact.summary) || {};
      const payload = asRecord(artifact.payload);
      const runIds = [];
      addUnique(runIds, summary.runId);
      addUnique(runIds, summary.trainingRunId);
      for (const runId of asArray(summary.runIds)) addUnique(runIds, runId);
      addRunIdsFromSource(runIds, summary.source);
      if (payload) {
        addUnique(runIds, payload.runId);
        addUnique(runIds, payload.run_id);
        for (const runId of asArray(payload.runIds)) addUnique(runIds, runId);
        addRunIdsFromSource(runIds, payload.source);
        for (const step of asArray(payload.steps).map(asRecord).filter(Boolean)) {
          const result = asRecord(step.result);
          const manifest = asRecord(result && result.manifest);
          addUnique(runIds, manifest && manifest.runId);
          addRunIdsFromSource(runIds, manifest && manifest.source);
        }
      }
      return runIds.sort();
    }
    function artifactTiers(artifact) {
      const summary = asRecord(artifact.summary) || {};
      const payload = asRecord(artifact.payload);
      const tiers = [];
      addUnique(tiers, summary.tier);
      for (const stat of asArray(summary.modelStats).map(asRecord).filter(Boolean)) addUnique(tiers, stat.tier);
      if (payload) {
        addUnique(tiers, payload.tier);
        for (const row of asArray(payload.rows).map(asRecord).filter(Boolean)) addUnique(tiers, row.tier);
        for (const row of asArray(payload.comparisons).map(asRecord).filter(Boolean)) addUnique(tiers, row.tier);
        const recipe = asRecord(payload.recipe);
        const evals = asRecord(recipe && recipe.evals);
        for (const pair of asArray(evals && evals.actionBenchmarkPairs).map(asRecord).filter(Boolean)) addUnique(tiers, pair.tier);
        const evidence = asRecord(payload.evidence);
        const benchmarks = asRecord(evidence && evidence.benchmarks);
        const training = asRecord(evidence && evidence.training);
        for (const item of asArray(benchmarks && benchmarks.tierCoverage).map(asRecord).filter(Boolean)) addUnique(tiers, item.tier);
        for (const item of asArray(benchmarks && benchmarks.comparisonInventory).map(asRecord).filter(Boolean)) addUnique(tiers, item.tier);
        for (const item of asArray(training && training.modelInventory).map(asRecord).filter(Boolean)) addUnique(tiers, item.tier);
      }
      return tiers.sort();
    }
    function sourceCategories(artifact) {
      const summary = asRecord(artifact.summary) || {};
      const source = asRecord(summary.source);
      const sourceKind = typeof summary.source === "string"
        ? summary.source
        : source && source.kind;
      const categories = [];
      function add(category) {
        if (category && !categories.includes(category)) categories.push(category);
      }
      if (summary.schema === "eliza_huggingface_dataset_ingest" || sourceKind === "huggingface_dataset") return ["Hugging Face"];
      if (summary.schema === "feed_training_trajectory_export" || summary.schema === "feed_parallel_generation") return ["Feed"];
      if (artifact.kind === "trajectory_bundle" && sourceKind === "training_collection_natural_trajectories") return ["Natural trajectories"];
      if (artifact.kind === "scenario_run" || summary.schema === "eliza_scenario_native_export") return ["Scenarios"];
      if (summary.schema === "eliza_test_trajectory_record" && sourceKind === "app_core_test_trajectory") return ["Tests"];
      if (summary.schema === "eliza_training_jsonl_dataset") return ["Training JSONL"];
      if (artifact.kind === "eval") return ["Evals"];
      if (artifact.kind === "benchmark_matrix") return ["Benchmarks"];
      if (artifact.kind === "model") return ["Models"];
      if (artifact.kind === "collection_run") {
        const payload = asRecord(artifact.payload);
        const evidence = asRecord(payload && payload.evidence);
        const sourceSamples = asRecord(evidence && evidence.sourceSamples);
        if (asArray(sourceSamples && sourceSamples.huggingFace).length > 0) add("Hugging Face");
        if (asArray(sourceSamples && sourceSamples.feed).length > 0) add("Feed");
        if (asArray(sourceSamples && sourceSamples.natural).length > 0) add("Natural trajectories");
        if (asArray(sourceSamples && sourceSamples.scenarios).length > 0) add("Scenarios");
        if (asArray(sourceSamples && sourceSamples.tests).length > 0) add("Tests");
        if (asArray(sourceSamples && sourceSamples.trainingJsonl).length > 0) add("Training JSONL");
        if (asArray(evidence && evidence.readinessGaps).length > 0) add("Readiness");
        const feed = asRecord(evidence && evidence.feed);
        if (asArray(feed && feed.runs).length > 0 || asArray(feed && feed.trajectorySamples).length > 0) add("Feed");
        const evals = asRecord(evidence && evidence.evals);
        if ((evals && Number(evals.evalArtifacts) > 0) || asArray(evals && evals.comparisonInventory).length > 0) add("Evals");
        const benchmarks = asRecord(evidence && evidence.benchmarks);
        if ((benchmarks && Number(benchmarks.benchmarkRows) > 0) || asArray(benchmarks && benchmarks.comparisonInventory).length > 0) add("Benchmarks");
        const training = asRecord(evidence && evidence.training);
        if ((training && Number(training.models) > 0) || asArray(training && training.modelInventory).length > 0) add("Models");
        for (const link of asArray(evidence && evidence.artifactLinks).map(asRecord).filter(Boolean)) {
          if (link.category === "benchmark") add("Benchmarks");
          if (link.category === "eval") add("Evals");
          if (link.category === "model") add("Models");
          if (link.category === "source") add("Training JSONL");
        }
        return categories.length > 0 ? categories : ["Collections"];
      }
      return ["Other"];
    }
    function sourceCategory(artifact) {
      return sourceCategories(artifact)[0] || "Other";
    }
    function sourceSampleRowsForArtifact(artifact) {
      const summary = asRecord(artifact.summary) || {};
      const category = sourceCategory(artifact);
      const rows = [];
      if (artifact.kind === "collection_run") {
        const payload = asRecord(artifact.payload);
        const evidence = asRecord(payload && payload.evidence);
        const sourceSamples = asRecord(evidence && evidence.sourceSamples);
        const collectionSources = [
          ["huggingFace", "Hugging Face"],
          ["feed", "Feed"],
          ["natural", "Natural trajectories"],
          ["scenarios", "Scenarios"],
          ["tests", "Tests"],
          ["trainingJsonl", "Training JSONL"],
        ];
        for (const [sourceKey, sourceLabel] of collectionSources) {
          for (const sample of asArray(sourceSamples && sourceSamples[sourceKey]).map(asRecord).filter(Boolean)) {
            rows.push({
              source: sourceLabel,
              artifact: sample.title || artifact.title,
              trajectory: sample.trajectoryId || sample.caseId,
              task: sample.task || sample.purpose || sample.scenarioId || sample.sourceKind || sample.schema,
              input: sample.input || sample.firstInput || sample.llmInput,
              output: sample.output || sample.firstOutput || sample.llmOutput,
              path: sample.path || summary.relativePath || artifact.path,
            });
          }
        }
        return rows;
      }
      function pushRows(samples, mapper) {
        for (const sample of asArray(samples).map(asRecord).filter(Boolean)) {
          const row = mapper(sample);
          rows.push({
            source: category,
            artifact: artifact.title,
            path: summary.relativePath || artifact.path,
            ...row,
          });
        }
      }
      pushRows(summary.hfSamplePreviews, (sample) => ({
        trajectory: sample.trajectoryId,
        task: sample.task || sample.sourceDataset || sample.hfPath,
        input: sample.input,
        output: sample.output,
      }));
      pushRows(summary.feedSamplePreviews, (sample) => ({
        trajectory: sample.trajectoryId,
        task: sample.archetype || sample.scenarioId,
        input: sample.firstInput || sample.firstStep,
        output: sample.firstOutput || sample.reasoning,
      }));
      pushRows(summary.samplePreviews, (sample) => ({
        trajectory: sample.trajectoryId,
        task: sample.task || sample.purpose || sample.sourceDataset,
        input: sample.input,
        output: sample.output,
      }));
      pushRows(summary.llmCallPreviews, (sample) => ({
        trajectory: sample.trajectoryId,
        task: sample.purpose || sample.callId || sample.stepId,
        input: sample.input,
        output: sample.output,
      }));
      pushRows(summary.scenarioNativeSamplePreviews, (sample) => ({
        trajectory: sample.trajectoryId,
        task: sample.purpose || sample.taskType || sample.scenarioId,
        input: sample.input,
        output: sample.output,
      }));
      pushRows(summary.testSamplePreviews, (sample) => ({
        trajectory: sample.caseId || sample.trajectoryId,
        task: sample.scenarioId || sample.llmPurpose,
        input: sample.input || sample.llmInput,
        output: sample.output || sample.llmOutput,
      }));
      return rows;
    }
    function readableSourceSampleRows() {
      return manifest.artifacts
        .flatMap(sourceSampleRowsForArtifact)
        .filter((row) => selectedSourceCategory === "all" || row.source === selectedSourceCategory);
    }
    function renderSourceInventory() {
      sourceInventory.textContent = "";
      const groups = new Map();
      for (const artifact of manifest.artifacts) {
        for (const category of sourceCategories(artifact)) {
          const group = groups.get(category) || { count: 0, paths: [] };
          group.count += 1;
          group.paths.push((artifact.summary && artifact.summary.relativePath) || artifact.path);
          groups.set(category, group);
        }
      }
      const allItem = document.createElement("button");
      allItem.type = "button";
      allItem.className = "inventory-item";
      allItem.dataset.sourceCategory = "all";
      allItem.setAttribute("aria-selected", String(selectedSourceCategory === "all"));
      const allCount = document.createElement("strong");
      allCount.textContent = String(manifest.artifacts.length);
      const allLabel = document.createElement("span");
      allLabel.textContent = "All sources";
      const allPath = document.createElement("span");
      allPath.textContent = "Clear source filter";
      allItem.append(allCount, allLabel, allPath);
      allItem.addEventListener("click", () => {
        selectedSourceCategory = "all";
        selectedIndex = 0;
        renderSourceInventory();
        renderSourceSamples();
        render();
      });
      sourceInventory.appendChild(allItem);
      for (const [category, group] of groups) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "inventory-item";
        item.dataset.sourceCategory = category;
        item.setAttribute("aria-selected", String(selectedSourceCategory === category));
        const count = document.createElement("strong");
        count.textContent = String(group.count);
        const label = document.createElement("span");
        label.textContent = category;
        const path = document.createElement("span");
        path.textContent = group.paths.slice(0, 2).join(" | ");
        item.append(count, label, path);
        item.addEventListener("click", () => {
          selectedSourceCategory = category;
          selectedIndex = 0;
          renderSourceInventory();
          renderSourceSamples();
          render();
        });
        sourceInventory.appendChild(item);
      }
    }
    function renderSourceSamples() {
      const rows = readableSourceSampleRows();
      sourceSamples.textContent = "";
      sourceSampleNote.textContent =
        (selectedSourceCategory === "all" ? "All sources" : selectedSourceCategory) +
        " · " + rows.length + " readable sample" + (rows.length === 1 ? "" : "s");
      if (rows.length === 0) {
        sourceSamples.textContent = "No readable samples indexed for this source.";
        return;
      }
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const column of ["Source", "Artifact", "Trajectory", "Task", "Input", "Output", "Path"]) {
        const th = document.createElement("th");
        th.textContent = column;
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      const tbody = document.createElement("tbody");
      for (const rowItem of rows.slice(0, 50)) {
        const row = document.createElement("tr");
        appendTextCell(row, rowItem.source);
        appendTextCell(row, rowItem.artifact);
        appendTextCell(row, rowItem.trajectory);
        appendTextCell(row, rowItem.task);
        appendTextCell(row, rowItem.input);
        appendTextCell(row, rowItem.output);
        appendPathCell(row, rowItem.path);
        tbody.appendChild(row);
      }
      table.append(thead, tbody);
      sourceSamples.appendChild(table);
    }
    function appendCoverageItem(label, value, detailText) {
      const item = document.createElement("div");
      item.className = "coverage-item";
      const strong = document.createElement("strong");
      strong.textContent = compactValue(value);
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      const detailEl = document.createElement("span");
      detailEl.textContent = detailText;
      item.append(strong, labelEl, detailEl);
      coverageSummary.appendChild(item);
    }
    function renderCoverageSummary() {
      coverageSummary.textContent = "";
      const coverage = asRecord(manifest.coverage) || {};
      const dataSources = asRecord(coverage.dataSources) || {};
      const samples = asRecord(coverage.readableSamples) || {};
      const evals = asRecord(coverage.evals) || {};
      const benchmarks = asRecord(coverage.benchmarks) || {};
      const models = asRecord(coverage.models) || {};
      const tierCoverage = asArray(benchmarks.tierCoverage).map(asRecord).filter(Boolean);
      appendCoverageItem(
        "Data sources",
        ["huggingFace", "feed", "natural", "scenarios", "tests", "trainingJsonl"]
          .map((key) => key + ":" + compactValue(dataSources[key]))
          .join(" "),
        "Hugging Face, feed, natural trajectories, scenarios, tests, and JSONL",
      );
      appendCoverageItem(
        "Readable trajectory samples",
        compactValue(samples.total),
        ["huggingFace", "feed", "natural", "scenarios", "tests", "trainingJsonl"]
          .map((key) => key + ":" + compactValue(samples[key]))
          .join(" "),
      );
      appendCoverageItem(
        "Eval comparisons",
        compactValue(evals.scoredComparisons) + "/" + compactValue(evals.comparisons),
        "Scored base-vs-trained comparisons with improvement percent",
      );
      appendCoverageItem(
        "Benchmark comparisons",
        compactValue(benchmarks.scoredComparisons) + "/" + compactValue(benchmarks.comparisons),
        "Eliza harness rows, case samples, and model-vs-reference deltas",
      );
      appendCoverageItem(
        "All Eliza-1 tiers",
        benchmarks.allEliza1TiersCovered === true ? "covered" : "partial",
        tierCoverage
          .map((tier) =>
            compactValue(tier.tier) + ":" +
            (tier.hasBase ? "base" : "-") + "/" +
            (tier.hasTrained ? "trained" : "-") + "/" +
            (tier.hasReference ? "ref" : "-") + "/" +
            (tier.hasImprovement ? "improvement" : "-"),
          )
          .join(" "),
      );
      appendCoverageItem(
        "Model inventory",
        compactValue(models.artifacts),
        asArray(models.inventory)
          .map(asRecord)
          .filter(Boolean)
          .slice(0, 5)
          .map((model) => [model.tier, model.variant, model.model].filter(Boolean).join(":"))
          .join(" | "),
      );
    }
    function populateFilter(select, values, allLabel, selectedValue) {
      select.textContent = "";
      const allOption = document.createElement("option");
      allOption.value = "all";
      allOption.textContent = allLabel;
      select.appendChild(allOption);
      for (const value of values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      }
      select.value = values.includes(selectedValue) ? selectedValue : "all";
    }
    function renderRunTierFilters() {
      const runIds = [];
      const tiers = [];
      for (const artifact of manifest.artifacts) {
        for (const runId of artifactRunIds(artifact)) addUnique(runIds, runId);
        for (const tier of artifactTiers(artifact)) addUnique(tiers, tier);
      }
      populateFilter(runFilter, runIds.sort(), "All runs", selectedRunId);
      populateFilter(tierFilter, tiers.sort(), "All tiers", selectedTier);
      selectedRunId = runFilter.value;
      selectedTier = tierFilter.value;
    }
    function appendTextCell(row, value) {
      const cell = document.createElement("td");
      cell.textContent = compactValue(value);
      row.appendChild(cell);
    }
    function hrefForPath(value) {
      const path = typeof value === "string" ? value.trim() : "";
      if (!path) return null;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
      if (path.startsWith("/")) return "file://" + encodeURI(path);
      return null;
    }
    function appendPathCell(row, value) {
      const cell = document.createElement("td");
      const path = typeof value === "string" ? value.trim() : "";
      const href = hrefForPath(path);
      if (path && href) {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noreferrer";
        anchor.textContent = path;
        cell.appendChild(anchor);
      } else {
        cell.textContent = compactValue(value);
      }
      row.appendChild(cell);
    }
    function appendStatusCell(row, value) {
      const cell = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = statusClass(value);
      pill.textContent = compactValue(value);
      cell.appendChild(pill);
      row.appendChild(cell);
    }
    function appendTableCard(title, columns, rows, cellRenderers) {
      if (!rows || rows.length === 0) return false;
      const card = document.createElement("section");
      card.className = "detail-card";
      const heading = document.createElement("h2");
      heading.textContent = title;
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const column of columns) {
        const th = document.createElement("th");
        th.textContent = column;
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      const tbody = document.createElement("tbody");
      rows.forEach((item) => {
        const row = document.createElement("tr");
        cellRenderers.forEach((renderCell) => renderCell(row, item));
        tbody.appendChild(row);
      });
      table.append(thead, tbody);
      wrap.appendChild(table);
      card.append(heading, wrap);
      detail.appendChild(card);
      return true;
    }
    function appendBenchmarkComparisonCard(artifact) {
      const payload = asRecord(artifact.payload);
      const rows = asArray(payload && payload.comparisons).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Benchmark Comparisons",
        ["Tier", "Benchmark", "Base", "Trained", "Reference", "Improvement", "vs Reference", "Run"],
        rows,
        [
          (row, item) => appendTextCell(row, item.tier),
          (row, item) => appendTextCell(row, item.benchmark),
          (row, item) => appendTextCell(row, item.baseScore),
          (row, item) => appendTextCell(row, item.trainedScore),
          (row, item) => appendTextCell(row, item.referenceScore),
          (row, item) => appendTextCell(row, item.improvementPercent === null || item.improvementPercent === undefined ? "n/a" : String(item.improvementPercent) + "%"),
          (row, item) => appendTextCell(row, item.trainedVsReferencePercent === null || item.trainedVsReferencePercent === undefined ? "n/a" : String(item.trainedVsReferencePercent) + "%"),
          (row, item) => appendTextCell(row, item.dryRun === true ? "dry-run" : "live"),
        ],
      );
    }
    function appendBenchmarkRowsCard(artifact) {
      const payload = asRecord(artifact.payload);
      const rows = asArray(payload && payload.rows).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Benchmark Rows",
        ["Tier", "Variant", "Model", "Benchmark", "Score", "Provider", "Dataset"],
        rows,
        [
          (row, item) => appendTextCell(row, item.tier),
          (row, item) => appendTextCell(row, item.variant),
          (row, item) => appendTextCell(row, item.modelId),
          (row, item) => appendTextCell(row, item.benchmark),
          (row, item) => appendTextCell(row, item.score),
          (row, item) => appendTextCell(row, item.provider),
          (row, item) => appendTextCell(row, item.datasetVersion),
        ],
      );
    }
    function appendBenchmarkCaseSamplesCard(artifact) {
      const payload = asRecord(artifact.payload);
      const rows = [];
      for (const matrixRow of asArray(payload && payload.rows).map(asRecord).filter(Boolean)) {
        const raw = asRecord(matrixRow.raw);
        for (const sample of asArray(raw && raw.caseSamples).map(asRecord).filter(Boolean)) {
          rows.push({
            tier: matrixRow.tier,
            variant: matrixRow.variant,
            modelId: matrixRow.modelId,
            benchmark: matrixRow.benchmark,
            score: matrixRow.score,
            ...sample,
          });
        }
      }
      return appendTableCard(
        "Benchmark Case Samples",
        ["Status", "Tier", "Variant", "Model", "Case", "Input", "Expected", "Actual", "Output", "Trajectory"],
        rows,
        [
          (row, item) => appendStatusCell(row, item.pass === true ? "passed" : "failed"),
          (row, item) => appendTextCell(row, item.tier),
          (row, item) => appendTextCell(row, item.variant),
          (row, item) => appendTextCell(row, item.modelId),
          (row, item) => appendTextCell(row, item.caseId),
          (row, item) => appendTextCell(row, item.prompt),
          (row, item) => appendTextCell(row, item.expectedAction),
          (row, item) => appendTextCell(row, item.actualAction),
          (row, item) => appendTextCell(row, item.response),
          (row, item) => appendPathCell(row, item.trajectoryPath),
        ],
      );
    }
    function appendBenchmarkModelStatsCard(artifact) {
      const summary = asRecord(artifact.summary);
      const rows = asArray(summary && summary.modelStats).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Benchmark Model Stats",
        ["Tier", "Variant", "Model", "Benchmarks", "Scores", "Average", "Best", "Worst"],
        rows,
        [
          (row, item) => appendTextCell(row, item.tier),
          (row, item) => appendTextCell(row, item.variant),
          (row, item) => appendTextCell(row, item.modelId),
          (row, item) => appendTextCell(row, item.benchmarkCount),
          (row, item) => appendTextCell(row, item.scoreCount),
          (row, item) => appendTextCell(row, item.averageScore),
          (row, item) => appendTextCell(row, item.bestScore),
          (row, item) => appendTextCell(row, item.worstScore),
        ],
      );
    }
    function appendReadinessCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_readiness_report") return false;
      const checks = asArray(payload.checks).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Training Readiness Checks",
        ["Status", "Check", "Artifacts", "Note", "Recommended Action"],
        checks,
        [
          (row, item) => appendStatusCell(row, item.status),
          (row, item) => appendTextCell(row, item.label || item.id),
          (row, item) => appendTextCell(row, item.artifactCount),
          (row, item) => appendTextCell(row, item.note),
          (row, item) => {
            const action = asRecord(item.recommendedAction);
            appendTextCell(row, action ? action.capability : "none");
          },
        ],
      );
    }
    function appendEvalMetricsCard(artifact) {
      const payload = asRecord(artifact.payload);
      const metrics = asRecord(payload && payload.metrics);
      const models = asRecord(payload && payload.models);
      if (!metrics) return false;
      const rows = [
        { metric: "baseModel", value: models && models.base },
        { metric: "trainedModel", value: models && models.trained },
        { metric: "backend", value: models && models.backend },
        { metric: "reportPath", value: payload && payload.reportPath },
        { metric: "baseScore", value: metrics.baseScore },
        { metric: "trainedScore", value: metrics.trainedScore },
        { metric: "improvementAbsolute", value: metrics.improvementAbsolute },
        { metric: "improvementPercent", value: metrics.improvementPercent },
        { metric: "baseLatencyMs", value: metrics.baseLatencyMs },
        { metric: "trainedLatencyMs", value: metrics.trainedLatencyMs },
        { metric: "latencyDeltaMs", value: metrics.latencyDeltaMs },
        { metric: "promptCount", value: metrics.promptCount },
        { metric: "distinctResponseCount", value: metrics.distinctResponseCount },
      ].filter((item) => item.value !== undefined);
      return appendTableCard(
        "Eval Metrics",
        ["Metric", "Value"],
        rows,
        [
          (row, item) => appendTextCell(row, item.metric),
          (row, item) => appendTextCell(row, item.value),
        ],
      );
    }
    function appendEvalPromptSamplesCard(artifact) {
      const summary = asRecord(artifact.summary);
      if (!summary || summary.schema !== "eliza_eval_comparison_artifact") return false;
      const rows = asArray(summary.evalSamplePreviews).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Eval Prompt Samples",
        ["Prompt", "Expected", "Base Output", "Trained Output", "Base", "Trained", "Delta"],
        rows,
        [
          (row, item) => appendTextCell(row, item.prompt),
          (row, item) => appendTextCell(row, item.expected),
          (row, item) => appendTextCell(row, item.baseOutput),
          (row, item) => appendTextCell(row, item.trainedOutput),
          (row, item) => appendTextCell(row, item.baseScore),
          (row, item) => appendTextCell(row, item.trainedScore),
          (row, item) => appendTextCell(row, item.improvement),
        ],
      );
    }
    function appendActionBenchmarkCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_action_selection_benchmark_report") return false;
      const results = asArray(payload.results).map(asRecord).filter(Boolean).slice(0, 25);
      return appendTableCard(
        "Action Benchmark Results",
        ["Status", "Case", "Input", "Expected", "Actual", "Output", "Latency", "Trajectory", "Tags"],
        results,
        [
          (row, item) => appendStatusCell(row, item.pass === true ? "passed" : "failed"),
          (row, item) => appendTextCell(row, item.caseId),
          (row, item) => appendTextCell(row, item.prompt || item.input || item.userPrompt),
          (row, item) => appendTextCell(row, item.expectedAction),
          (row, item) => appendTextCell(row, item.actualAction),
          (row, item) => appendTextCell(row, item.response || item.output || item.finalResponse || item.failureReason),
          (row, item) => appendTextCell(row, item.latencyMs),
          (row, item) => appendPathCell(row, item.trajectoryPath),
          (row, item) => appendTextCell(row, item.tags),
        ],
      );
    }
    function appendJsonlSampleCard(artifact) {
      const summary = asRecord(artifact.summary);
      if (!summary || summary.schema !== "eliza_training_jsonl_dataset") return false;
      const rows = asArray(summary.samplePreviews).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Training JSONL Samples",
        ["Task", "Trajectory", "Source", "Input", "Output"],
        rows,
        [
          (row, item) => appendTextCell(row, item.task),
          (row, item) => appendTextCell(row, item.trajectoryId),
          (row, item) => appendTextCell(row, item.sourceDataset || item.schema),
          (row, item) => appendTextCell(row, item.input),
          (row, item) => appendTextCell(row, item.output),
        ],
      );
    }
    function appendHuggingFaceDatasetCard(artifact) {
      const summary = asRecord(artifact.summary);
      if (!summary || summary.schema !== "eliza_huggingface_dataset_ingest") return false;
      const files = asArray(summary.hfFiles).map(asRecord).filter(Boolean);
      const wroteFiles = appendTableCard(
        "Hugging Face Dataset Files",
        ["HF Path", "Rows", "Bytes", "Status", "Local Path"],
        files,
        [
          (row, item) => appendTextCell(row, item.hfPath),
          (row, item) => appendTextCell(row, item.rows),
          (row, item) => appendTextCell(row, item.bytes),
          (row, item) => appendTextCell(row, item.status),
          (row, item) => appendPathCell(row, item.localPath),
        ],
      );
      const samples = asArray(summary.hfSamplePreviews)
        .map(asRecord)
        .filter(Boolean);
      const wroteSamples = appendTableCard(
        "Hugging Face Dataset Samples",
        ["HF Path", "Task", "Trajectory", "Source", "Input", "Output"],
        samples,
        [
          (row, item) => appendTextCell(row, item.hfPath),
          (row, item) => appendTextCell(row, item.task),
          (row, item) => appendTextCell(row, item.trajectoryId),
          (row, item) => appendTextCell(row, item.sourceDataset || item.schema),
          (row, item) => appendTextCell(row, item.input),
          (row, item) => appendTextCell(row, item.output),
        ],
      );
      return wroteFiles || wroteSamples;
    }
    function appendTrajectoryBundleSampleCard(artifact) {
      if (artifact.kind !== "trajectory_bundle") return false;
      const summary = asRecord(artifact.summary);
      const rows = asArray(summary && summary.samplePreviews).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Trajectory Bundle Samples",
        ["Trajectory", "Agent", "Purpose", "Model", "Steps", "LLM Calls", "Input", "Output"],
        rows,
        [
          (row, item) => appendTextCell(row, item.trajectoryId),
          (row, item) => appendTextCell(row, item.agentId),
          (row, item) => appendTextCell(row, item.purpose),
          (row, item) => appendTextCell(row, item.model),
          (row, item) => appendTextCell(row, item.steps),
          (row, item) => appendTextCell(row, item.llmCalls),
          (row, item) => appendTextCell(row, item.input),
          (row, item) => appendTextCell(row, item.output),
        ],
      );
    }
    function appendTrajectoryBundleLlmCallCard(artifact) {
      if (artifact.kind !== "trajectory_bundle") return false;
      const summary = asRecord(artifact.summary);
      const rows = asArray(summary && summary.llmCallPreviews).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Trajectory Bundle LLM Calls",
        ["Trajectory", "Step", "Purpose", "Model", "System", "Input", "Output"],
        rows,
        [
          (row, item) => appendTextCell(row, item.trajectoryId),
          (row, item) => appendTextCell(row, item.stepId || item.stepIndex),
          (row, item) => appendTextCell(row, item.purpose),
          (row, item) => appendTextCell(row, item.model || item.provider),
          (row, item) => appendTextCell(row, item.systemPrompt),
          (row, item) => appendTextCell(row, item.input),
          (row, item) => appendTextCell(row, item.output),
        ],
      );
    }
    function appendScenarioTurnPreviewCard(artifact) {
      if (artifact.kind !== "scenario_run") return false;
      const summary = asRecord(artifact.summary);
      const rows = asArray(summary && summary.turnPreviews).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Scenario Turn Previews",
        ["Scenario", "Turn", "Kind", "Input", "Output", "Actions"],
        rows,
        [
          (row, item) => appendTextCell(row, item.scenarioId),
          (row, item) => appendTextCell(row, item.turn),
          (row, item) => appendTextCell(row, item.kind),
          (row, item) => appendTextCell(row, item.input),
          (row, item) => appendTextCell(row, item.output),
          (row, item) => appendTextCell(row, item.actions),
        ],
      );
    }
    function appendScenarioNativeSamplesCard(artifact) {
      const summary = asRecord(artifact.summary);
      if (!summary || summary.schema !== "eliza_scenario_native_export") return false;
      const rows = asArray(summary.scenarioNativeSamplePreviews)
        .map(asRecord)
        .filter(Boolean);
      return appendTableCard(
        "Scenario Native Samples",
        ["Trajectory", "Scenario", "Purpose", "Task", "Model", "Input", "Output", "Tool Calls"],
        rows,
        [
          (row, item) => appendTextCell(row, item.trajectoryId),
          (row, item) => appendTextCell(row, item.scenarioId),
          (row, item) => appendTextCell(row, item.purpose),
          (row, item) => appendTextCell(row, item.taskType),
          (row, item) => appendTextCell(row, item.model || item.provider),
          (row, item) => appendTextCell(row, item.input),
          (row, item) => appendTextCell(row, item.output),
          (row, item) => appendTextCell(row, item.toolCalls),
        ],
      );
    }
    function appendFeedGenerationCard(artifact) {
      const summary = asRecord(artifact.summary);
      if (
        !summary ||
        (summary.schema !== "feed_training_trajectory_export" &&
          summary.schema !== "feed_parallel_generation")
      ) {
        return false;
      }
      const source = asRecord(summary.source) || {};
      const rows = [
        { metric: "source", value: source.kind },
        { metric: "archetype", value: source.archetype },
        { metric: "archetypes", value: source.archetypes },
        { metric: "trajectories", value: summary.trajectories },
        { metric: "agentsCreated", value: asArray(summary.agentsCreated).length || summary.agentsCreated },
        { metric: "totalTicks", value: summary.totalTicks },
        { metric: "durationMs", value: summary.durationMs },
        { metric: "errors", value: summary.errors },
        { metric: "cleanup", value: summary.cleanup },
        { metric: "exportPath", value: summary.exportPath },
        { metric: "outputDir", value: summary.outputDir },
      ].filter((item) => item.value !== undefined && item.value !== null);
      const wroteSummary = appendTableCard(
        "Feed Generation",
        ["Metric", "Value"],
        rows,
        [
          (row, item) => appendTextCell(row, item.metric),
          (row, item) =>
            String(item.metric || "").toLowerCase().includes("path") ||
            String(item.metric || "").toLowerCase().includes("dir")
              ? appendPathCell(row, item.value)
              : appendTextCell(row, item.value),
        ],
      );
      const stats = asRecord(summary.archetypeStats);
      const statRows = stats
        ? Object.entries(stats).map(([archetype, value]) => ({
            archetype,
            ...(asRecord(value) || {}),
          }))
        : [];
      const wroteStats = appendTableCard(
        "Feed Archetype Stats",
        ["Archetype", "Agents", "Trajectories", "Avg Ticks"],
        statRows,
        [
          (row, item) => appendTextCell(row, item.archetype),
          (row, item) => appendTextCell(row, item.agents),
          (row, item) => appendTextCell(row, item.trajectories),
          (row, item) => appendTextCell(row, item.avgTicksPerAgent),
        ],
      );
      const sampleRows = asArray(summary.feedSamplePreviews).map(asRecord).filter(Boolean);
      const wroteSamples = appendTableCard(
        "Feed Trajectory Samples",
        ["Trajectory", "Agent", "Archetype", "Scenario", "Score", "Steps", "First Step", "Input", "Output"],
        sampleRows,
        [
          (row, item) => appendTextCell(row, item.trajectoryId),
          (row, item) => appendTextCell(row, item.agentId),
          (row, item) => appendTextCell(row, item.archetype),
          (row, item) => appendTextCell(row, item.scenarioId),
          (row, item) => appendTextCell(row, item.score),
          (row, item) => appendTextCell(row, item.steps),
          (row, item) => appendTextCell(row, item.firstStep),
          (row, item) => appendTextCell(row, item.firstInput),
          (row, item) => appendTextCell(row, item.firstOutput),
        ],
      );
      return wroteSummary || wroteStats || wroteSamples;
    }
    function appendModelTrackingCard(artifact) {
      if (artifact.kind !== "model") return false;
      const summary = asRecord(artifact.summary);
      if (!summary) return false;
      const rows = [
        { metric: "model", value: summary.model },
        { metric: "variant", value: summary.variant },
        { metric: "baseModel", value: summary.baseModel },
        { metric: "outputPath", value: summary.outputPath },
        { metric: "tier", value: summary.tier },
        { metric: "repoId", value: summary.repoId },
        { metric: "bundleDir", value: summary.bundleDir },
        { metric: "trainingRunId", value: summary.trainingRunId },
        { metric: "trainingJobId", value: summary.trainingJobId },
        { metric: "trainedAt", value: summary.trainedAt },
        { metric: "baseEvalScore", value: summary.baseEvalScore },
        { metric: "trainedEvalScore", value: summary.trainedEvalScore },
        { metric: "evalImprovementPercent", value: summary.evalImprovementPercent },
        { metric: "stagedCount", value: summary.stagedCount },
        { metric: "apply", value: summary.apply },
      ].filter((item) => item.value !== undefined && item.value !== null);
      return appendTableCard(
        "Model Tracking",
        ["Metric", "Value"],
        rows,
        [
          (row, item) => appendTextCell(row, item.metric),
          (row, item) => appendTextCell(row, item.value),
        ],
      );
    }
    function appendCollectionStepsCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const steps = asArray(payload.steps).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Collection Steps",
        ["Status", "Step", "Output", "Error"],
        steps,
        [
          (row, item) => appendStatusCell(row, item.status),
          (row, item) => appendTextCell(row, item.id),
          (row, item) => appendPathCell(row, item.outputDir),
          (row, item) => appendTextCell(row, item.error),
        ],
      );
    }
    function appendCollectionActionBenchmarkPairsCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const steps = asArray(payload.steps).map(asRecord).filter(Boolean);
      const actionStep = steps.find((step) => step.id === "action_benchmark");
      const result = asRecord(actionStep && actionStep.result);
      const pairs = asArray(result && result.pairs).map(asRecord).filter(Boolean);
      const rows = [];
      for (const pair of pairs) {
        const runs = asRecord(pair.runs);
        for (const variant of ["base", "trained"]) {
          const run = asRecord(runs && runs[variant]);
          if (!run) continue;
          const matrixSource = asRecord(run.matrixSource);
          rows.push({
            label: pair.label,
            tier: pair.tier,
            variant,
            modelId: matrixSource && matrixSource.modelId,
            reportJsonPath: run.reportJsonPath,
            outputDir: run.outputDir,
          });
        }
      }
      return appendTableCard(
        "Collection Action Benchmark Pairs",
        ["Pair", "Tier", "Variant", "Model", "Report", "Output"],
        rows,
        [
          (row, item) => appendTextCell(row, item.label),
          (row, item) => appendTextCell(row, item.tier),
          (row, item) => appendTextCell(row, item.variant),
          (row, item) => appendTextCell(row, item.modelId),
          (row, item) => appendPathCell(row, item.reportJsonPath),
          (row, item) => appendPathCell(row, item.outputDir),
        ],
      );
    }
    function appendCollectionRecipeCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const recipe = asRecord(payload.recipe);
      if (!recipe) return false;
      const include = asRecord(recipe.include) || {};
      const sources = asRecord(recipe.sources) || {};
      const evals = asRecord(recipe.evals) || {};
      const training = asRecord(recipe.training) || {};
      const rows = [
        ...Object.entries(include).map(([key, value]) => ({
          section: "include",
          key,
          value,
        })),
        ...Object.entries(sources).map(([key, value]) => ({
          section: "sources",
          key,
          value,
        })),
        ...Object.entries(evals).map(([key, value]) => ({
          section: "evals",
          key,
          value,
        })),
        ...Object.entries(training).map(([key, value]) => ({
          section: "training",
          key,
          value,
        })),
      ].filter((item) => item.value !== undefined && item.value !== null);
      return appendTableCard(
        "Collection Recipe",
        ["Section", "Key", "Value"],
        rows,
        [
          (row, item) => appendTextCell(row, item.section),
          (row, item) => appendTextCell(row, item.key),
          (row, item) => appendTextCell(row, item.value),
        ],
      );
    }
    function appendCollectionEvidenceCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const rows = asArray(evidence && evidence.artifactLinks)
        .map(asRecord)
        .filter(Boolean);
      return appendTableCard(
        "Collection Evidence Artifacts",
        ["Category", "Kind", "Schema", "Title", "Path"],
        rows,
        [
          (row, item) => appendTextCell(row, item.category),
          (row, item) => appendTextCell(row, item.kind),
          (row, item) => appendTextCell(row, item.schema),
          (row, item) => appendTextCell(row, item.title),
          (row, item) => appendPathCell(row, item.path),
        ],
      );
    }
    function appendCollectionPreflightCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const preflight = asRecord(evidence && evidence.preflight);
      const rows = asArray(preflight && preflight.checks).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Collection Live Preflight",
        ["Status", "Check", "Label", "Detail", "Path"],
        rows,
        [
          (row, item) => appendStatusCell(row, item.status === "ok" || item.status === "skipped" ? "passed" : "failed"),
          (row, item) => appendTextCell(row, item.id),
          (row, item) => appendTextCell(row, item.label),
          (row, item) => appendTextCell(row, item.detail),
          (row, item) => appendPathCell(row, item.path),
        ],
      );
    }
    function appendCollectionStepArtifactsCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const rows = [];
      for (const step of asArray(evidence && evidence.stepArtifacts).map(asRecord).filter(Boolean)) {
        const command = asArray(step.command).join(" ");
        const paths = asArray(step.paths).map(asRecord).filter(Boolean);
        if (paths.length === 0) {
          rows.push({
            stepId: step.stepId,
            status: step.status,
            command,
            exitCode: step.exitCode,
            stdout: step.stdout,
            stderr: step.stderr,
            label: "n/a",
            path: step.outputDir,
          });
          continue;
        }
        for (const path of paths) {
          rows.push({
            stepId: step.stepId,
            status: step.status,
            command,
            exitCode: step.exitCode,
            stdout: step.stdout,
            stderr: step.stderr,
            label: path.label,
            path: path.path,
          });
        }
      }
      return appendTableCard(
        "Collection Step Artifacts",
        ["Step", "Status", "Command", "Exit", "Stdout", "Stderr", "Path Label", "Path"],
        rows,
        [
          (row, item) => appendTextCell(row, item.stepId),
          (row, item) => appendStatusCell(row, item.status),
          (row, item) => appendTextCell(row, item.command),
          (row, item) => appendTextCell(row, item.exitCode),
          (row, item) => appendTextCell(row, item.stdout),
          (row, item) => appendTextCell(row, item.stderr),
          (row, item) => appendTextCell(row, item.label),
          (row, item) => appendPathCell(row, item.path),
        ],
      );
    }
    function appendCollectionModelInventoryCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const training = asRecord(evidence && evidence.training);
      const rows = asArray(training && training.modelInventory)
        .map(asRecord)
        .filter(Boolean);
      return appendTableCard(
        "Collection Model Inventory",
        ["Tier", "Variant", "Model", "Base", "Base Score", "Trained Score", "Output", "Repo", "Improvement"],
        rows,
        [
          (row, item) => appendTextCell(row, item.tier),
          (row, item) => appendTextCell(row, item.variant),
          (row, item) => appendTextCell(row, item.model),
          (row, item) => appendTextCell(row, item.baseModel),
          (row, item) => appendTextCell(row, item.baseEvalScore),
          (row, item) => appendTextCell(row, item.trainedEvalScore),
          (row, item) => appendPathCell(row, item.outputPath),
          (row, item) => appendTextCell(row, item.repoId),
          (row, item) => appendTextCell(row, item.evalImprovementPercent),
        ],
      );
    }
    function appendCollectionEvalComparisonsCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const evals = asRecord(evidence && evidence.evals);
      const rows = asArray(evals && evals.comparisonInventory)
        .map(asRecord)
        .filter(Boolean);
      return appendTableCard(
        "Collection Eval Comparisons",
        ["Base Model", "Trained Model", "Backend", "Base", "Trained", "Improvement", "Base Latency", "Trained Latency", "Report"],
        rows,
        [
          (row, item) => appendTextCell(row, item.baseModel),
          (row, item) => appendTextCell(row, item.trainedModel),
          (row, item) => appendTextCell(row, item.backend),
          (row, item) => appendTextCell(row, item.baseScore),
          (row, item) => appendTextCell(row, item.trainedScore),
          (row, item) => appendTextCell(row, item.improvementPercent === null || item.improvementPercent === undefined ? "n/a" : String(item.improvementPercent) + "%"),
          (row, item) => appendTextCell(row, item.baseLatencyMs),
          (row, item) => appendTextCell(row, item.trainedLatencyMs),
          (row, item) => appendPathCell(row, item.reportPath || item.path),
        ],
      );
    }
    function appendCollectionSourceSamplesCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const sourceSamples = asRecord(evidence && evidence.sourceSamples);
      if (!sourceSamples) return false;
      const rows = [];
      for (const category of ["huggingFace", "feed", "natural", "scenarios", "tests", "trainingJsonl"]) {
        for (const sample of asArray(sourceSamples[category]).map(asRecord).filter(Boolean)) {
          rows.push({ category, ...sample });
        }
      }
      return appendTableCard(
        "Collection Source Samples",
        ["Source", "Title", "Trajectory", "Scenario", "Task", "Model", "Input", "Output", "Path"],
        rows,
        [
          (row, item) => appendTextCell(row, item.category),
          (row, item) => appendTextCell(row, item.title),
          (row, item) => appendTextCell(row, item.trajectoryId),
          (row, item) => appendTextCell(row, item.scenarioId),
          (row, item) => appendTextCell(row, item.task || item.sourceKind || item.schema),
          (row, item) => appendTextCell(row, item.model),
          (row, item) => appendTextCell(row, item.input),
          (row, item) => appendTextCell(row, item.output),
          (row, item) => appendPathCell(row, item.path),
        ],
      );
    }
    function appendCollectionFeedRunsCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const feed = asRecord(evidence && evidence.feed);
      const rows = asArray(feed && feed.runs).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Collection Feed Runs",
        ["Source", "Archetype", "Trajectories", "Ticks", "Errors", "Artifact", "Export"],
        rows,
        [
          (row, item) => appendTextCell(row, item.sourceKind || item.schema),
          (row, item) => appendTextCell(row, item.archetype || item.archetypes),
          (row, item) => appendTextCell(row, item.trajectories),
          (row, item) => appendTextCell(row, item.totalTicks),
          (row, item) => appendTextCell(row, item.errors),
          (row, item) => appendPathCell(row, item.path),
          (row, item) => appendPathCell(row, item.exportPath || item.outputDir),
        ],
      );
    }
    function appendCollectionFeedArchetypeStatsCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const feed = asRecord(evidence && evidence.feed);
      const rows = asArray(feed && feed.archetypeStats).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Collection Feed Archetype Stats",
        ["Archetype", "Agents", "Trajectories", "Avg Ticks", "Artifact"],
        rows,
        [
          (row, item) => appendTextCell(row, item.archetype),
          (row, item) => appendTextCell(row, item.agents),
          (row, item) => appendTextCell(row, item.trajectories),
          (row, item) => appendTextCell(row, item.avgTicksPerAgent),
          (row, item) => appendPathCell(row, item.path),
        ],
      );
    }
    function appendCollectionFeedTrajectorySamplesCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const feed = asRecord(evidence && evidence.feed);
      const rows = asArray(feed && feed.trajectorySamples).map(asRecord).filter(Boolean);
      return appendTableCard(
        "Collection Feed Trajectory Samples",
        ["Trajectory", "Agent", "Archetype", "Scenario", "Score", "Steps", "First Step", "Input", "Output", "Artifact"],
        rows,
        [
          (row, item) => appendTextCell(row, item.trajectoryId),
          (row, item) => appendTextCell(row, item.agentId),
          (row, item) => appendTextCell(row, item.archetype),
          (row, item) => appendTextCell(row, item.scenarioId),
          (row, item) => appendTextCell(row, item.score),
          (row, item) => appendTextCell(row, item.steps),
          (row, item) => appendTextCell(row, item.firstStep),
          (row, item) => appendTextCell(row, item.firstInput),
          (row, item) => appendTextCell(row, item.firstOutput),
          (row, item) => appendPathCell(row, item.path),
        ],
      );
    }
    function appendCollectionBenchmarkImprovementsCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const benchmarks = asRecord(evidence && evidence.benchmarks);
      const rows = asArray(benchmarks && benchmarks.improvementComparisons)
        .map(asRecord)
        .filter(Boolean);
      return appendTableCard(
        "Collection Benchmark Improvements",
        ["Tier", "Benchmark", "Base", "Trained", "Reference", "Improvement", "Vs Reference", "Evidence"],
        rows,
        [
          (row, item) => appendTextCell(row, item.tier),
          (row, item) => appendTextCell(row, item.benchmark),
          (row, item) => appendTextCell(row, item.baseScore),
          (row, item) => appendTextCell(row, item.trainedScore),
          (row, item) => appendTextCell(row, item.referenceScore),
          (row, item) => appendTextCell(row, item.improvementPercent === null || item.improvementPercent === undefined ? "n/a" : String(item.improvementPercent) + "%"),
          (row, item) => appendTextCell(row, item.trainedVsReferencePercent === null || item.trainedVsReferencePercent === undefined ? "n/a" : String(item.trainedVsReferencePercent) + "%"),
          (row, item) => appendTextCell(row, item.modelBacked === true ? "model-backed" : "partial"),
        ],
      );
    }
    function appendCollectionBaselineProgressCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const benchmarks = asRecord(evidence && evidence.benchmarks);
      const progress = asRecord(benchmarks && benchmarks.baselineProgress);
      if (!progress) return false;
      const rows = [
        { metric: "tierOrder", value: asArray(progress.tierOrder).join(" -> ") },
        { metric: "establishedTiers", value: asArray(progress.establishedTiers).join(", ") || "none" },
        { metric: "remainingTiers", value: asArray(progress.remainingTiers).join(", ") || "none" },
        { metric: "nextTier", value: progress.nextTier || "none" },
        { metric: "smallestTierEstablished", value: progress.smallestTierEstablished },
        { metric: "allTiersEstablished", value: progress.allTiersEstablished },
      ];
      return appendTableCard(
        "Collection Baseline Progression",
        ["Metric", "Value"],
        rows,
        [
          (row, item) => appendTextCell(row, item.metric),
          (row, item) => appendTextCell(row, item.value),
        ],
      );
    }
    function appendCollectionBenchmarkComparisonsCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const benchmarks = asRecord(evidence && evidence.benchmarks);
      const rows = asArray(benchmarks && benchmarks.comparisonInventory)
        .map(asRecord)
        .filter(Boolean);
      return appendTableCard(
        "Collection Benchmark Comparisons",
        ["Tier", "Benchmark", "Base Model", "Trained Model", "Reference Model", "Base", "Trained", "Reference", "Improvement", "Vs Reference", "Evidence"],
        rows,
        [
          (row, item) => appendTextCell(row, item.tier),
          (row, item) => appendTextCell(row, item.benchmark),
          (row, item) => appendTextCell(row, item.baseModelId),
          (row, item) => appendTextCell(row, item.trainedModelId),
          (row, item) => appendTextCell(row, item.referenceModelId),
          (row, item) => appendTextCell(row, item.baseScore),
          (row, item) => appendTextCell(row, item.trainedScore),
          (row, item) => appendTextCell(row, item.referenceScore),
          (row, item) => appendTextCell(row, item.improvementPercent === null || item.improvementPercent === undefined ? "n/a" : String(item.improvementPercent) + "%"),
          (row, item) => appendTextCell(row, item.trainedVsReferencePercent === null || item.trainedVsReferencePercent === undefined ? "n/a" : String(item.trainedVsReferencePercent) + "%"),
          (row, item) => appendTextCell(row, item.dryRun === true ? "dry-run" : item.modelBacked === true ? "model-backed" : item.useMocks === true ? "mocked" : "unverified"),
        ],
      );
    }
    function appendCollectionReadinessGapsCard(artifact) {
      const payload = asRecord(artifact.payload);
      if (!payload || payload.schema !== "eliza_training_collection_run") return false;
      const evidence = asRecord(payload.evidence);
      const rows = asArray(evidence && evidence.readinessGaps)
        .map(asRecord)
        .filter(Boolean);
      return appendTableCard(
        "Collection Readiness Gaps",
        ["Status", "Check", "Note", "Recommended Capability", "Recommended Params"],
        rows,
        [
          (row, item) => appendStatusCell(row, item.status),
          (row, item) => appendTextCell(row, item.id),
          (row, item) => appendTextCell(row, item.note),
          (row, item) => appendTextCell(row, item.recommendedCapability),
          (row, item) => appendTextCell(row, item.recommendedParams),
        ],
      );
    }
    function appendTestTrajectoryCard(artifact) {
      const summary = asRecord(artifact.summary);
      const source = asRecord(summary && summary.source);
      if (!summary || summary.schema !== "eliza_test_trajectory_record" || !source || source.kind !== "app_core_test_trajectory") {
        return false;
      }
      const payload = asRecord(artifact.payload);
      if (!payload) return false;
      const transcript = asArray(payload.transcript).map(asRecord).filter(Boolean);
      const actions = asArray(payload.actions).map(asRecord).filter(Boolean);
      const agentTrajectory = asRecord(payload.agentTrajectory);
      const llmCalls = asArray(agentTrajectory && agentTrajectory.llmCalls).map(asRecord).filter(Boolean);
      const samples = asArray(summary.testSamplePreviews).map(asRecord).filter(Boolean);
      const wroteSamples = appendTableCard(
        "Test Trajectory Samples",
        ["Case", "Scenario", "Pass", "Expected", "Actual", "Input", "Output"],
        samples,
        [
          (row, item) => appendTextCell(row, item.caseId),
          (row, item) => appendTextCell(row, item.scenarioId),
          (row, item) => appendTextCell(row, item.pass),
          (row, item) => appendTextCell(row, item.expectedAction),
          (row, item) => appendTextCell(row, item.actualAction),
          (row, item) => appendTextCell(row, item.input),
          (row, item) => appendTextCell(row, item.output),
        ],
      );
      appendTableCard(
        "Test Trajectory Transcript",
        ["Role", "Text", "Actions"],
        transcript,
        [
          (row, item) => appendTextCell(row, item.role),
          (row, item) => appendTextCell(row, item.text),
          (row, item) => appendTextCell(row, item.actions),
        ],
      );
      appendTableCard(
        "Test Trajectory LLM Calls",
        ["Purpose", "Model", "Latency", "Prompt", "Response"],
        llmCalls.slice(0, 25),
        [
          (row, item) => appendTextCell(row, item.purpose),
          (row, item) => appendTextCell(row, item.modelType),
          (row, item) => appendTextCell(row, item.latencyMs),
          (row, item) => appendTextCell(row, item.prompt || item.userPrompt),
          (row, item) => appendTextCell(row, item.response),
        ],
      );
      appendTableCard(
        "Test Trajectory Actions",
        ["Phase", "Action", "Status", "Text"],
        actions,
        [
          (row, item) => appendTextCell(row, item.phase),
          (row, item) => appendTextCell(row, item.actionName),
          (row, item) => appendTextCell(row, item.actionStatus),
          (row, item) => appendTextCell(row, item.contentText),
        ],
      );
      return wroteSamples || transcript.length > 0 || llmCalls.length > 0 || actions.length > 0;
    }
    function appendInsightCards(artifact) {
      appendReadinessCard(artifact);
      appendBenchmarkComparisonCard(artifact);
      appendBenchmarkRowsCard(artifact);
      appendBenchmarkCaseSamplesCard(artifact);
      appendBenchmarkModelStatsCard(artifact);
      appendEvalMetricsCard(artifact);
      appendEvalPromptSamplesCard(artifact);
      appendActionBenchmarkCard(artifact);
      appendJsonlSampleCard(artifact);
      appendHuggingFaceDatasetCard(artifact);
      appendTrajectoryBundleSampleCard(artifact);
      appendTrajectoryBundleLlmCallCard(artifact);
      appendScenarioTurnPreviewCard(artifact);
      appendScenarioNativeSamplesCard(artifact);
      appendFeedGenerationCard(artifact);
      appendModelTrackingCard(artifact);
      appendCollectionStepsCard(artifact);
      appendCollectionActionBenchmarkPairsCard(artifact);
      appendCollectionRecipeCard(artifact);
      appendCollectionPreflightCard(artifact);
      appendCollectionEvidenceCard(artifact);
      appendCollectionStepArtifactsCard(artifact);
      appendCollectionModelInventoryCard(artifact);
      appendCollectionEvalComparisonsCard(artifact);
      appendCollectionSourceSamplesCard(artifact);
      appendCollectionFeedRunsCard(artifact);
      appendCollectionFeedArchetypeStatsCard(artifact);
      appendCollectionFeedTrajectorySamplesCard(artifact);
      appendCollectionBenchmarkComparisonsCard(artifact);
      appendCollectionBenchmarkImprovementsCard(artifact);
      appendCollectionBaselineProgressCard(artifact);
      appendCollectionReadinessGapsCard(artifact);
      appendTestTrajectoryCard(artifact);
    }
    function appendSummaryCard(artifact) {
      const card = document.createElement("section");
      card.className = "detail-card";
      const heading = document.createElement("h2");
      heading.textContent = artifact.title;
      const meta = document.createElement("div");
      meta.className = "label";
      meta.textContent = [artifact.kind.replace("_", " "), artifact.generatedAt]
        .filter(Boolean)
        .join(" · ");
      const grid = document.createElement("div");
      grid.className = "summary-grid";
      const entries = Object.entries(artifact.summary || {})
        .filter(([key, value]) => key !== "sourceLinks" && value !== undefined)
        .slice(0, 18);
      for (const [key, value] of entries) {
        const item = document.createElement("div");
        item.className = "summary-item";
        const label = document.createElement("span");
        label.textContent = key;
        const body = document.createElement("strong");
        body.textContent = compactValue(value);
        item.append(label, body);
        grid.appendChild(item);
      }
      card.append(heading, meta, grid);
      detail.appendChild(card);
    }
    function appendLinksCard(artifact) {
      const links = (artifact.summary && artifact.summary.sourceLinks) || [];
      if (links.length === 0) return;
      const card = document.createElement("section");
      card.className = "detail-card";
      const heading = document.createElement("h2");
      heading.textContent = "Source files";
      const container = document.createElement("div");
      container.className = "links";
      for (const link of links) {
        const anchor = document.createElement("a");
        anchor.href = link.href || link.path;
        anchor.textContent = link.label + ": " + link.path;
        anchor.target = "_blank";
        anchor.rel = "noreferrer";
        container.appendChild(anchor);
      }
      card.append(heading, container);
      detail.appendChild(card);
    }
    function appendPayloadCard(artifact) {
      const card = document.createElement("section");
      card.className = "detail-card";
      const heading = document.createElement("h2");
      heading.textContent = "Payload";
      const payload = document.createElement("pre");
      payload.textContent = pretty(artifact.payload);
      card.append(heading, payload);
      detail.appendChild(card);
    }
    function filteredArtifacts() {
      const query = search.value.trim().toLowerCase();
      return manifest.artifacts.filter((artifact) => {
        if (selectedKind !== "all" && artifact.kind !== selectedKind) return false;
        if (selectedSourceCategory !== "all" && !sourceCategories(artifact).includes(selectedSourceCategory)) return false;
        if (selectedRunId !== "all" && !artifactRunIds(artifact).includes(selectedRunId)) return false;
        if (selectedTier !== "all" && !artifactTiers(artifact).includes(selectedTier)) return false;
        if (!query) return true;
        return JSON.stringify({
          title: artifact.title,
          kind: artifact.kind,
          sourceCategories: sourceCategories(artifact),
          path: artifact.path,
          summary: artifact.summary
        }).toLowerCase().includes(query);
      });
    }
    function render() {
      const artifacts = filteredArtifacts();
      selectedIndex = Math.min(selectedIndex, Math.max(0, artifacts.length - 1));
      list.textContent = "";
      detail.textContent = "";
      if (artifacts.length === 0) {
        detail.textContent = "No matching artifacts.";
        return;
      }
      artifacts.forEach((artifact, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "row" + (index === selectedIndex ? " active" : "");
        const label = document.createElement("div");
        label.className = "label";
        label.textContent = artifact.kind.replace("_", " ");
        const title = document.createElement("strong");
        title.textContent = artifact.title;
        const path = document.createElement("div");
        path.className = "path";
        path.textContent = artifact.summary.relativePath || artifact.path;
        button.append(label, title, path);
        button.addEventListener("click", () => {
          selectedIndex = index;
          render();
        });
        list.appendChild(button);
      });
      appendSummaryCard(artifacts[selectedIndex]);
      appendLinksCard(artifacts[selectedIndex]);
      appendInsightCards(artifacts[selectedIndex]);
      appendPayloadCard(artifacts[selectedIndex]);
    }
    for (const button of document.querySelectorAll("[data-kind]")) {
      button.addEventListener("click", () => {
        selectedKind = button.dataset.kind;
        selectedIndex = 0;
        for (const tab of document.querySelectorAll("[data-kind]")) {
          tab.setAttribute("aria-selected", String(tab === button));
        }
        render();
      });
    }
    search.addEventListener("input", () => {
      selectedIndex = 0;
      render();
    });
    runFilter.addEventListener("change", () => {
      selectedRunId = runFilter.value;
      selectedIndex = 0;
      render();
    });
    tierFilter.addEventListener("change", () => {
      selectedTier = tierFilter.value;
      selectedIndex = 0;
      render();
    });
    renderRunTierFilters();
    renderSourceInventory();
    renderSourceSamples();
    renderCoverageSummary();
    render();
  </script>
</body>
</html>
`;
}

export async function buildTrainingAnalysisIndex(
  options: BuildTrainingAnalysisIndexOptions = {},
): Promise<TrainingAnalysisIndex> {
  const roots = [
    ...new Set(
      (options.roots ?? [trainingStateRoot(), ".tmp"])
        .map((root) => root.trim())
        .filter(Boolean),
    ),
  ];
  const outputDir = options.outputDir ?? join(trainingStateRoot(), "analysis");
  const maxDepth = options.maxDepth ?? 6;
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const jsonFiles = (
    await Promise.all(roots.map((root) => walkJsonFiles(root, maxDepth)))
  ).flat();

  const artifacts: TrainingAnalysisArtifact[] = [];
  const seen = new Set<string>();
  for (const file of jsonFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    const artifact = file.endsWith(".jsonl")
      ? await readJsonlDatasetArtifact(file, roots)
      : await classifyArtifact(file, await readJson(file), roots);
    if (artifact) artifacts.push(artifact);
  }

  const sortedArtifacts = sortArtifacts(artifacts).map(enrichArtifactLinks);
  const coverage = buildAnalysisCoverage(sortedArtifacts);
  await mkdir(outputDir, { recursive: true });
  const indexHtmlPath = join(outputDir, "index.html");
  const manifestPath = join(outputDir, "analysis-manifest.json");
  const manifest: TrainingAnalysisIndexManifest = {
    schema: TRAINING_ANALYSIS_INDEX_SCHEMA,
    schemaVersion: TRAINING_ANALYSIS_INDEX_VERSION,
    generatedAt,
    roots,
    outputDir,
    indexHtmlPath,
    manifestPath,
    counts: {
      trajectoryBundles: countByKind(sortedArtifacts, "trajectory_bundle"),
      trajectoryDatasets: countByKind(sortedArtifacts, "trajectory_dataset"),
      scenarioRuns: countByKind(sortedArtifacts, "scenario_run"),
      collectionRuns: countByKind(sortedArtifacts, "collection_run"),
      trainingRuns: countByKind(sortedArtifacts, "training_run"),
      evals: countByKind(sortedArtifacts, "eval"),
      benchmarkMatrices: countByKind(sortedArtifacts, "benchmark_matrix"),
      models: countByKind(sortedArtifacts, "model"),
      artifacts: sortedArtifacts.length,
    },
    coverage,
    artifacts: sortedArtifacts,
  };

  await writeFile(indexHtmlPath, buildIndexHtml(manifest), "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return {
    outputDir,
    indexHtmlPath,
    manifestPath,
    manifest,
  };
}
