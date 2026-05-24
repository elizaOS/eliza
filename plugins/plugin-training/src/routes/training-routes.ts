import type { Trajectory } from "@elizaos/agent";
import type {
  AgentRuntime,
  RouteHelpers,
  RouteRequestContext,
} from "@elizaos/core";
import { parsePositiveInteger } from "@elizaos/shared";
import { runActionBenchmark } from "../core/action-benchmark-runner.js";
import {
  writeBenchmarkMatrixArtifact,
  writeBenchmarkMatrixArtifactFromArtifacts,
} from "../core/benchmark-matrix-artifact.js";
import { runBenchmarkVsCerebras } from "../core/benchmark-vs-cerebras-runner.js";
import { AGENT_CONTEXTS, type AgentContext } from "../core/context-types.js";
import {
  runLocalEvalComparison,
  writeEvalComparisonArtifact,
} from "../core/eval-comparison-artifact.js";
import { stageEliza1Bundle } from "../core/eliza1-bundle-stager.js";
import { runFeedGeneration } from "../core/feed-generation-runner.js";
import { ingestHuggingFaceDataset } from "../core/huggingface-dataset-ingest.js";
import { createHashAnonymizer } from "../core/privacy-filter.js";
import { runScenarios } from "../core/scenario-runner.js";
import { buildTrainingAnalysisIndex } from "../core/training-analysis-index.js";
import { writeTrainingReadinessReport } from "../core/training-readiness-report.js";
import {
  buildTrainingCollectionPreflightWithProbes,
  listTrainingCollections,
  runTrainingCollection,
} from "../core/training-collection-runner.js";
import {
  ALL_TRAINING_BACKENDS,
  ALL_TRAINING_TASKS,
  loadTrainingConfig,
  normalizeTrainingConfig,
  saveTrainingConfig,
  type TrainingBackend,
} from "../core/training-config.js";
import {
  listRuns,
  loadRun,
  triggerTraining,
} from "../core/training-orchestrator.js";
import { resolveHfUploadConfig } from "../core/trajectory-hf-upload.js";
import type {
  TrajectoryTaskDatasetExport,
  TrajectoryTrainingTask,
} from "../core/trajectory-task-datasets.js";
import { detectAvailableBackends } from "../services/training-backend-check.js";
import { isNotImplementedError } from "../services/training-service.js";
import type { TrainingServiceLike } from "../services/training-service-like.js";
import {
  type RegisteredTrainingTriggerEntry,
  TRAINING_TRIGGER_SERVICE,
} from "../services/training-trigger.js";

export type TrainingRouteHelpers = RouteHelpers;

export interface TrainingRouteContext extends RouteRequestContext {
  runtime: AgentRuntime | null;
  trainingService: TrainingServiceLike;
  isLoopbackHost: (host: string) => boolean;
}

function resolveStringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveBooleanSetting(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Map a thrown service error onto an HTTP status. `NotImplementedError` (the
 * training service no longer fakes GPU fine-tunes / model ops) becomes a 501
 * with the error's own message; anything else falls back to `status`.
 */
function sendServiceError<R>(
  error: (res: R, message: string, status?: number) => void,
  res: R,
  err: unknown,
  status = 400,
): void {
  if (isNotImplementedError(err)) {
    error(res, err.message, 501);
    return;
  }
  error(res, String(err), status);
}

function emptyTaskCounters(): Record<TrajectoryTrainingTask, number> {
  return {
    should_respond: 0,
    context_routing: 0,
    action_planner: 0,
    response: 0,
    media_description: 0,
  };
}

function getTriggerEntry(
  runtime: AgentRuntime | null,
): RegisteredTrainingTriggerEntry | null {
  if (!runtime) return null;
  const services = (
    runtime as {
      services?: Map<string, unknown[]>;
    }
  ).services;
  if (!services) return null;
  const entries = services.get(TRAINING_TRIGGER_SERVICE);
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const candidate = entries[0] as unknown;
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as { notifyTrajectoryCompleted?: unknown })
      .notifyTrajectoryCompleted === "function"
  ) {
    return candidate as RegisteredTrainingTriggerEntry;
  }
  return null;
}

const AGENT_DECISIONS = ["RESPOND", "IGNORE", "STOP"] as const;
type AgentDecision = (typeof AGENT_DECISIONS)[number];

function narrowAgentContexts(input: unknown): AgentContext[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: AgentContext[] = [];
  for (const entry of input) {
    if (
      typeof entry === "string" &&
      (AGENT_CONTEXTS as readonly string[]).includes(entry)
    ) {
      out.push(entry as AgentContext);
    }
  }
  return out.length > 0 ? out : undefined;
}

function narrowAgentDecisions(input: unknown): AgentDecision[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: AgentDecision[] = [];
  for (const entry of input) {
    if (
      typeof entry === "string" &&
      (AGENT_DECISIONS as readonly string[]).includes(entry)
    ) {
      out.push(entry as AgentDecision);
    }
  }
  return out.length > 0 ? out : undefined;
}

function narrowTrainingTasks(
  input: unknown,
): readonly TrajectoryTrainingTask[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: TrajectoryTrainingTask[] = [];
  for (const entry of input) {
    if (
      typeof entry === "string" &&
      (ALL_TRAINING_TASKS as readonly string[]).includes(entry)
    ) {
      out.push(entry as TrajectoryTrainingTask);
    }
  }
  return out.length > 0 ? out : undefined;
}

function normalizeRunId(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0
    ? input.trim()
    : undefined;
}

function trajectoryHasRunId(trajectory: Trajectory, runId: string): boolean {
  const record = trajectory as Trajectory & {
    runId?: unknown;
    metadata?: Record<string, unknown>;
  };
  if (normalizeRunId(record.runId) === runId) return true;
  if (normalizeRunId(record.metadata?.runId) === runId) return true;
  if (normalizeRunId(record.metadata?.appRunId) === runId) return true;

  for (const step of trajectory.steps ?? []) {
    for (const call of step.llmCalls ?? []) {
      if (normalizeRunId(call.runId) === runId) return true;
    }
    for (const access of step.providerAccesses ?? []) {
      if (normalizeRunId(access.runId) === runId) return true;
    }
  }
  return false;
}

function parseTaskOrNull(input: unknown): {
  value?: TrajectoryTrainingTask;
  error?: string;
} {
  if (input === undefined || input === null || input === "") return {};
  if (typeof input !== "string") {
    return { error: "task must be a string" };
  }
  if (!(ALL_TRAINING_TASKS as readonly string[]).includes(input)) {
    return {
      error: `task must be one of: ${ALL_TRAINING_TASKS.join(", ")}`,
    };
  }
  return { value: input as TrajectoryTrainingTask };
}

function parseBackendOrNull(input: unknown): {
  value?: TrainingBackend;
  error?: string;
} {
  if (input === undefined || input === null || input === "") return {};
  if (typeof input !== "string") {
    return { error: "backend must be a string" };
  }
  if (!(ALL_TRAINING_BACKENDS as readonly string[]).includes(input)) {
    return {
      error: `backend must be one of: ${ALL_TRAINING_BACKENDS.join(", ")}`,
    };
  }
  return { value: input as TrainingBackend };
}

function resolveOllamaUrlRejection(
  rawUrl: string,
  isLoopbackHost: (host: string) => boolean,
): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "ollamaUrl must be a valid URL";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "ollamaUrl must use http:// or https://";
  }

  if (!isLoopbackHost(parsed.hostname)) {
    return "ollamaUrl must target a loopback host (localhost, 127.0.0.1, or ::1)";
  }

  return null;
}

export async function handleTrainingRoutes(
  ctx: TrainingRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    runtime,
    trainingService,
    json,
    error,
    readJsonBody,
    isLoopbackHost,
  } = ctx;

  if (!pathname.startsWith("/api/training")) return false;

  if (method === "GET" && pathname === "/api/training/status") {
    const status = trainingService.getStatus();
    const trigger = getTriggerEntry(runtime);
    const triggerStatus = trigger?.getStatus() ?? null;
    json(res, {
      ...status,
      runtimeAvailable: runtime !== null,
      autoTrain: triggerStatus,
    });
    return true;
  }

  // ── Auto-training trigger surface (Phase 4) ─────────────────────────────
  if (method === "GET" && pathname === "/api/training/auto/status") {
    const trigger = getTriggerEntry(runtime);
    if (!trigger) {
      const config = loadTrainingConfig();
      json(res, {
        autoTrainEnabled: config.autoTrain,
        triggerThreshold: config.triggerThreshold,
        cooldownHours: config.triggerCooldownHours,
        counters: emptyTaskCounters(),
        lastTrain: {},
        perTaskThresholds: emptyTaskCounters(),
        perTaskCooldownMs: emptyTaskCounters(),
        serviceRegistered: false,
      });
      return true;
    }
    const snapshot = trigger.getStatus();
    json(res, { ...snapshot, serviceRegistered: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/training/auto/trigger") {
    const body = await readJsonBody<{
      task?: string;
      backend?: string;
      dryRun?: boolean;
    }>(req, res);
    if (!body) return true;

    const taskRejection = parseTaskOrNull(body.task);
    if (taskRejection.error) {
      error(res, taskRejection.error, 400);
      return true;
    }
    const backendRejection = parseBackendOrNull(body.backend);
    if (backendRejection.error) {
      error(res, backendRejection.error, 400);
      return true;
    }
    if (!runtime) {
      error(res, "Runtime is required to trigger training", 503);
      return true;
    }

    const trigger = getTriggerEntry(runtime);
    const record = trigger
      ? await trigger.runManually({
          task: taskRejection.value,
          backend: backendRejection.value,
          dryRun: body.dryRun === true,
        })
      : await triggerTraining(runtime, {
          task: taskRejection.value,
          backend: backendRejection.value,
          source: "manual",
          dryRun: body.dryRun === true,
        });
    json(res, { runId: record.runId, status: record.status, run: record }, 201);
    return true;
  }

  if (method === "GET" && pathname === "/api/training/auto/runs") {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 20);
    const runs = await listRuns(limit);
    json(res, { runs });
    return true;
  }

  const runMatch = /^\/api\/training\/auto\/runs\/([^/]+)$/.exec(pathname);
  if (method === "GET" && runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const run = await loadRun(runId);
    if (!run) {
      error(res, "Run not found", 404);
      return true;
    }
    json(res, { run });
    return true;
  }

  if (method === "GET" && pathname === "/api/training/auto/config") {
    json(res, { config: loadTrainingConfig() });
    return true;
  }

  if (method === "POST" && pathname === "/api/training/auto/config") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    const merged = normalizeTrainingConfig({
      ...loadTrainingConfig(),
      ...body,
    });
    saveTrainingConfig(merged);
    json(res, { config: merged });
    return true;
  }

  if (method === "POST" && pathname === "/api/training/analysis/index") {
    const body = await readJsonBody<{
      roots?: unknown;
      outputDir?: unknown;
      preflightOnly?: unknown;
      maxDepth?: unknown;
    }>(req, res);
    if (!body) return true;
    const roots = Array.isArray(body.roots)
      ? body.roots.filter(
          (root): root is string =>
            typeof root === "string" && root.trim().length > 0,
        )
      : undefined;
    const outputDir =
      typeof body.outputDir === "string" && body.outputDir.trim().length > 0
        ? body.outputDir.trim()
        : undefined;
    const maxDepth =
      typeof body.maxDepth === "number" && Number.isFinite(body.maxDepth)
        ? Math.max(0, Math.floor(body.maxDepth))
        : undefined;
    try {
      const index = await buildTrainingAnalysisIndex({
        roots,
        outputDir,
        maxDepth,
      });
      json(
        res,
        {
          outputDir: index.outputDir,
          indexHtmlPath: index.indexHtmlPath,
          manifestPath: index.manifestPath,
          manifest: index.manifest,
        },
        201,
      );
    } catch (err) {
      error(res, `Training analysis index failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/analysis/readiness") {
    const body = await readJsonBody<{
      roots?: unknown;
      outputDir?: unknown;
      maxDepth?: unknown;
      reportOutputDir?: unknown;
      reportPath?: unknown;
    }>(req, res);
    if (!body) return true;
    const roots = Array.isArray(body.roots)
      ? body.roots.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
      : undefined;
    try {
      const index = await buildTrainingAnalysisIndex({
        roots,
        outputDir: resolveStringSetting(body.outputDir),
        maxDepth:
          typeof body.maxDepth === "number" && Number.isFinite(body.maxDepth)
            ? Math.max(1, Math.floor(body.maxDepth))
            : undefined,
      });
      const result = await writeTrainingReadinessReport(index, {
        outputDir: resolveStringSetting(body.reportOutputDir),
        reportPath: resolveStringSetting(body.reportPath),
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Training readiness report failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/datasets/ingest-hf") {
    const body = await readJsonBody<{
      repoId?: unknown;
      revision?: unknown;
      files?: unknown;
      outputDir?: unknown;
      token?: unknown;
      dryRun?: unknown;
    }>(req, res);
    if (!body) return true;
    try {
      const result = await ingestHuggingFaceDataset({
        repoId: resolveStringSetting(body.repoId),
        revision: resolveStringSetting(body.revision),
        files: Array.isArray(body.files)
          ? body.files.filter(
              (file): file is string =>
                typeof file === "string" && file.trim().length > 0,
            )
          : undefined,
        outputDir: resolveStringSetting(body.outputDir),
        token: resolveStringSetting(body.token),
        dryRun: body.dryRun === true,
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Hugging Face dataset ingest failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/feed/generate") {
    const body = await readJsonBody<{
      workspaceRoot?: unknown;
      bun?: unknown;
      archetypes?: unknown;
      numAgents?: unknown;
      ticks?: unknown;
      parallel?: unknown;
      managerId?: unknown;
      cleanup?: unknown;
      dryRun?: unknown;
      outputDir?: unknown;
    }>(req, res);
    if (!body) return true;
    try {
      const result = await runFeedGeneration({
        workspaceRoot: resolveStringSetting(body.workspaceRoot),
        bun: resolveStringSetting(body.bun),
        archetypes: resolveStringSetting(body.archetypes),
        numAgents:
          typeof body.numAgents === "number" && Number.isFinite(body.numAgents)
            ? Math.max(1, Math.floor(body.numAgents))
            : undefined,
        ticks:
          typeof body.ticks === "number" && Number.isFinite(body.ticks)
            ? Math.max(1, Math.floor(body.ticks))
            : undefined,
        parallel:
          typeof body.parallel === "number" && Number.isFinite(body.parallel)
            ? Math.max(1, Math.floor(body.parallel))
            : undefined,
        managerId: resolveStringSetting(body.managerId),
        cleanup: body.cleanup === true,
        dryRun: body.dryRun === true,
        outputDir: resolveStringSetting(body.outputDir),
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Feed generation failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/scenarios/run") {
    const body = await readJsonBody<{
      workspaceRoot?: unknown;
      bun?: unknown;
      scenarioDir?: unknown;
      outputDir?: unknown;
      runId?: unknown;
      scenario?: unknown;
      fileGlobs?: unknown;
      exportNative?: unknown;
      useDeterministicProxy?: unknown;
      dryRun?: unknown;
    }>(req, res);
    if (!body) return true;
    try {
      const result = await runScenarios({
        workspaceRoot: resolveStringSetting(body.workspaceRoot),
        bun: resolveStringSetting(body.bun),
        scenarioDir: resolveStringSetting(body.scenarioDir),
        outputDir: resolveStringSetting(body.outputDir),
        runId: resolveStringSetting(body.runId),
        scenario: resolveStringSetting(body.scenario),
        fileGlobs: Array.isArray(body.fileGlobs)
          ? body.fileGlobs.filter(
              (glob): glob is string => typeof glob === "string",
            )
          : undefined,
        exportNative:
          typeof body.exportNative === "boolean"
            ? body.exportNative
            : undefined,
        useDeterministicProxy:
          typeof body.useDeterministicProxy === "boolean"
            ? body.useDeterministicProxy
            : undefined,
        dryRun: body.dryRun === true,
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Scenario run failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/training/collections") {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 20);
    const root = resolveStringSetting(url.searchParams.get("root"));
    try {
      const result = await listTrainingCollections({ root, limit });
      json(res, result);
    } catch (err) {
      error(res, `Training collection listing failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/collect") {
    const body = await readJsonBody<{
      outputDir?: unknown;
      workspaceRoot?: unknown;
      preflightOnly?: unknown;
      preflightProbe?: unknown;
      includeHuggingFace?: unknown;
      includeFeed?: unknown;
      includeNaturalTrajectories?: unknown;
      includeTestTrajectories?: unknown;
      includeScenarios?: unknown;
      includeEvalComparison?: unknown;
      includeActionBenchmark?: unknown;
      includeBenchmarkVsCerebras?: unknown;
      includeEliza1ModelRegistry?: unknown;
      includeEliza1BundleStage?: unknown;
      includeBenchmarkMatrix?: unknown;
      huggingFace?: unknown;
      feed?: unknown;
      naturalTrajectories?: unknown;
      testTrajectories?: unknown;
      scenarios?: unknown;
      evalComparison?: unknown;
      actionBenchmark?: unknown;
      actionBenchmarkPair?: unknown;
      actionBenchmarkPairs?: unknown;
      benchmarkVsCerebras?: unknown;
      eliza1BundleStage?: unknown;
      benchmarkMatrix?: unknown;
      analysis?: unknown;
    }>(req, res);
    if (!body) return true;
    const objectSetting = (
      value: unknown,
    ): Record<string, unknown> | undefined =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const objectArraySetting = (
      value: unknown,
    ): Record<string, unknown>[] | undefined =>
      Array.isArray(value)
        ? value.filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === "object" && !Array.isArray(item),
          )
        : undefined;
    const actionBenchmarkPairsSetting = (
      value: unknown,
    ): Record<string, unknown>[] | string | undefined =>
      typeof value === "string" ? value : objectArraySetting(value);
    const naturalTrajectoryOptions = objectSetting(body.naturalTrajectories);
    const naturalTrajectoryIds = Array.isArray(
      naturalTrajectoryOptions?.trajectoryIds,
    )
      ? naturalTrajectoryOptions.trajectoryIds.filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        )
      : [];
    const naturalRunId = resolveStringSetting(naturalTrajectoryOptions?.runId);
    const naturalLimit =
      typeof naturalTrajectoryOptions?.limit === "number" &&
      Number.isFinite(naturalTrajectoryOptions.limit)
        ? Math.max(1, Math.floor(naturalTrajectoryOptions.limit))
        : 100;
    try {
      let naturalTrajectories:
        | (Record<string, unknown> & { trajectories?: Trajectory[] })
        | undefined = naturalTrajectoryOptions;
      if (
        body.includeNaturalTrajectories === true &&
        body.preflightOnly !== true &&
        !naturalTrajectoryOptions?.sanitizedJsonlPath &&
        !naturalTrajectoryOptions?.rawJsonlPath
      ) {
        const listedTrajectories =
          naturalTrajectoryIds.length > 0
            ? null
            : await trainingService.listTrajectories({
                limit: naturalLimit,
                offset: 0,
                runId: naturalRunId,
              });
        const ids =
          naturalTrajectoryIds.length > 0
            ? naturalTrajectoryIds
            : (listedTrajectories?.trajectories ?? [])
                .map((item) => item.id)
                .filter((id) => id.length > 0);
        const details = (
          await Promise.all(
            ids.map((trajectoryId) =>
              trainingService.getTrajectoryById(trajectoryId),
            ),
          )
        ).filter((trajectory): trajectory is Trajectory => trajectory !== null);
        naturalTrajectories = {
          ...(naturalTrajectoryOptions ?? {}),
          trajectories: naturalRunId
            ? details.filter((trajectory) =>
                trajectoryHasRunId(trajectory, naturalRunId),
              )
            : details,
          source: {
            kind: "training_collection_natural_trajectories",
            ...objectSetting(naturalTrajectoryOptions?.source),
            runId: naturalRunId,
            metadata: {
              ...objectSetting(
                objectSetting(naturalTrajectoryOptions?.source)?.metadata,
              ),
              requestedLimit: naturalLimit,
              requestedRunId: naturalRunId ?? null,
              explicitTrajectoryIds: naturalTrajectoryIds.length,
              selectedTrajectoryIds: ids.length,
              loadedTrajectories: details.length,
            },
          },
        };
      }
      const collectionOptions = {
        preflightOnly: body.preflightOnly === true,
        preflightProbe: body.preflightProbe === true,
        outputDir: resolveStringSetting(body.outputDir),
        workspaceRoot: resolveStringSetting(body.workspaceRoot),
        includeHuggingFace:
          typeof body.includeHuggingFace === "boolean"
            ? body.includeHuggingFace
            : undefined,
        includeFeed:
          typeof body.includeFeed === "boolean" ? body.includeFeed : undefined,
        includeNaturalTrajectories:
          typeof body.includeNaturalTrajectories === "boolean"
            ? body.includeNaturalTrajectories
            : undefined,
        includeTestTrajectories:
          typeof body.includeTestTrajectories === "boolean"
            ? body.includeTestTrajectories
            : undefined,
        includeScenarios:
          typeof body.includeScenarios === "boolean"
            ? body.includeScenarios
            : undefined,
        includeEvalComparison:
          typeof body.includeEvalComparison === "boolean"
            ? body.includeEvalComparison
            : undefined,
        includeActionBenchmark:
          typeof body.includeActionBenchmark === "boolean"
            ? body.includeActionBenchmark
            : undefined,
        includeBenchmarkVsCerebras:
          typeof body.includeBenchmarkVsCerebras === "boolean"
            ? body.includeBenchmarkVsCerebras
            : undefined,
        includeEliza1ModelRegistry:
          typeof body.includeEliza1ModelRegistry === "boolean"
            ? body.includeEliza1ModelRegistry
            : undefined,
        includeEliza1BundleStage:
          typeof body.includeEliza1BundleStage === "boolean"
            ? body.includeEliza1BundleStage
            : undefined,
        includeBenchmarkMatrix:
          typeof body.includeBenchmarkMatrix === "boolean"
            ? body.includeBenchmarkMatrix
            : undefined,
        huggingFace: objectSetting(body.huggingFace),
        feed: objectSetting(body.feed),
        naturalTrajectories,
        testTrajectories: objectSetting(body.testTrajectories),
        scenarios: objectSetting(body.scenarios),
        evalComparison: objectSetting(body.evalComparison),
        actionBenchmark: objectSetting(body.actionBenchmark),
        actionBenchmarkPair: objectSetting(body.actionBenchmarkPair),
        actionBenchmarkPairs: actionBenchmarkPairsSetting(
          body.actionBenchmarkPairs,
        ),
        benchmarkVsCerebras: objectSetting(body.benchmarkVsCerebras),
        eliza1BundleStage: objectSetting(body.eliza1BundleStage),
        benchmarkMatrix: objectSetting(body.benchmarkMatrix),
        analysis: objectSetting(body.analysis),
      };
      if (body.preflightOnly === true) {
        json(
          res,
          {
            preflight: await buildTrainingCollectionPreflightWithProbes({
              options: collectionOptions,
              workspaceRoot: collectionOptions.workspaceRoot,
              trainingRoot: collectionOptions.workspaceRoot
                ? `${collectionOptions.workspaceRoot}/packages/training`
                : undefined,
            }),
          },
          200,
        );
        return true;
      }
      const result = await runTrainingCollection(collectionOptions);
      json(res, result, 201);
    } catch (err) {
      error(res, `Training collection failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/training/benchmarks/action-selection/run"
  ) {
    const body = await readJsonBody<{
      workspaceRoot?: unknown;
      bun?: unknown;
      outputDir?: unknown;
      useMocks?: unknown;
      forceTrajectoryCapture?: unknown;
      filter?: unknown;
      runsPerCase?: unknown;
      provider?: unknown;
      modelId?: unknown;
      runtimeModel?: unknown;
      smallModel?: unknown;
      largeModel?: unknown;
      baseUrl?: unknown;
      variant?: unknown;
      tier?: unknown;
      benchmark?: unknown;
      datasetVersion?: unknown;
      codeCommit?: unknown;
      dryRun?: unknown;
    }>(req, res);
    if (!body) return true;
    try {
      const result = await runActionBenchmark({
        workspaceRoot: resolveStringSetting(body.workspaceRoot),
        bun: resolveStringSetting(body.bun),
        outputDir: resolveStringSetting(body.outputDir),
        useMocks: resolveBooleanSetting(body.useMocks),
        forceTrajectoryCapture:
          body.forceTrajectoryCapture === false ? false : undefined,
        filter: resolveStringSetting(body.filter),
        runsPerCase:
          typeof body.runsPerCase === "number" &&
          Number.isFinite(body.runsPerCase)
            ? Math.max(1, Math.floor(body.runsPerCase))
            : undefined,
        provider: resolveStringSetting(body.provider),
        modelId: resolveStringSetting(body.modelId),
        runtimeModel: resolveStringSetting(body.runtimeModel),
        smallModel: resolveStringSetting(body.smallModel),
        largeModel: resolveStringSetting(body.largeModel),
        baseUrl: resolveStringSetting(body.baseUrl),
        variant:
          body.variant === "reference" ||
          body.variant === "base" ||
          body.variant === "trained"
            ? body.variant
            : undefined,
        tier: resolveStringSetting(body.tier),
        benchmark: resolveStringSetting(body.benchmark),
        datasetVersion: resolveStringSetting(body.datasetVersion),
        codeCommit: resolveStringSetting(body.codeCommit),
        dryRun: body.dryRun === true,
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Action benchmark failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/training/evals/record-comparison"
  ) {
    const body = await readJsonBody<{
      report?: unknown;
      reportPath?: unknown;
      outputDir?: unknown;
      source?: unknown;
    }>(req, res);
    if (!body) return true;
    if (
      !body.report ||
      typeof body.report !== "object" ||
      Array.isArray(body.report)
    ) {
      error(res, "report must be a JSON object", 400);
      return true;
    }
    try {
      const result = await writeEvalComparisonArtifact({
        report: body.report as Record<string, unknown>,
        reportPath: resolveStringSetting(body.reportPath),
        outputDir: resolveStringSetting(body.outputDir),
        source:
          body.source &&
          typeof body.source === "object" &&
          !Array.isArray(body.source)
            ? (body.source as Record<string, unknown>)
            : undefined,
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Eval comparison artifact failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/training/evals/run-local-comparison"
  ) {
    const body = await readJsonBody<{
      trainingRoot?: unknown;
      python?: unknown;
      manifestPath?: unknown;
      model?: unknown;
      trainedModelPath?: unknown;
      backend?: unknown;
      promptFile?: unknown;
      maxTokens?: unknown;
      systemPrompt?: unknown;
      outputPath?: unknown;
      outputDir?: unknown;
      dryRun?: unknown;
    }>(req, res);
    if (!body) return true;
    const backend =
      body.backend === "mlx" ||
      body.backend === "cuda" ||
      body.backend === "cpu"
        ? body.backend
        : undefined;
    try {
      const result = await runLocalEvalComparison({
        trainingRoot: resolveStringSetting(body.trainingRoot),
        python: resolveStringSetting(body.python),
        manifestPath: resolveStringSetting(body.manifestPath),
        model: resolveStringSetting(body.model),
        trainedModelPath: resolveStringSetting(body.trainedModelPath),
        backend,
        promptFile: resolveStringSetting(body.promptFile),
        maxTokens:
          typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens)
            ? Math.max(1, Math.floor(body.maxTokens))
            : undefined,
        systemPrompt: resolveStringSetting(body.systemPrompt),
        outputPath: resolveStringSetting(body.outputPath),
        outputDir: resolveStringSetting(body.outputDir),
        dryRun: body.dryRun === true,
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Local eval comparison failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/benchmarks/matrix") {
    const body = await readJsonBody<{
      rows?: unknown;
      outputDir?: unknown;
      generatedAt?: unknown;
      referenceModelId?: unknown;
      source?: unknown;
    }>(req, res);
    if (!body) return true;
    if (!Array.isArray(body.rows)) {
      error(res, "rows must be an array", 400);
      return true;
    }
    const rows = body.rows.filter(
      (
        row,
      ): row is {
        modelId: string;
        benchmark: string;
        score: number;
        variant: "reference" | "base" | "trained";
        tier?: string;
        provider?: string;
        datasetVersion?: string;
        codeCommit?: string;
        ts?: number | string;
        metrics?: Record<string, unknown>;
        raw?: Record<string, unknown>;
      } =>
        row !== null &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        typeof (row as { modelId?: unknown }).modelId === "string" &&
        typeof (row as { benchmark?: unknown }).benchmark === "string" &&
        typeof (row as { score?: unknown }).score === "number" &&
        ((row as { variant?: unknown }).variant === "reference" ||
          (row as { variant?: unknown }).variant === "base" ||
          (row as { variant?: unknown }).variant === "trained"),
    );
    if (rows.length !== body.rows.length) {
      error(
        res,
        "each row must include modelId, benchmark, numeric score, and variant reference|base|trained",
        400,
      );
      return true;
    }
    try {
      const result = await writeBenchmarkMatrixArtifact({
        rows,
        outputDir: resolveStringSetting(body.outputDir),
        generatedAt: resolveStringSetting(body.generatedAt),
        referenceModelId: resolveStringSetting(body.referenceModelId),
        source:
          body.source &&
          typeof body.source === "object" &&
          !Array.isArray(body.source)
            ? (body.source as Record<string, unknown>)
            : undefined,
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Benchmark matrix artifact failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/training/benchmarks/matrix/from-artifacts"
  ) {
    const body = await readJsonBody<{
      artifacts?: unknown;
      outputDir?: unknown;
      generatedAt?: unknown;
      referenceModelId?: unknown;
      source?: unknown;
    }>(req, res);
    if (!body) return true;
    if (!Array.isArray(body.artifacts)) {
      error(res, "artifacts must be an array", 400);
      return true;
    }
    const artifacts = body.artifacts.filter(
      (
        artifact,
      ): artifact is {
        path: string;
        modelId?: string;
        benchmark?: string;
        variant?: "reference" | "base" | "trained";
        tier?: string;
        provider?: string;
        datasetVersion?: string;
        codeCommit?: string;
      } =>
        artifact !== null &&
        typeof artifact === "object" &&
        !Array.isArray(artifact) &&
        typeof (artifact as { path?: unknown }).path === "string" &&
        ((artifact as { variant?: unknown }).variant === undefined ||
          (artifact as { variant?: unknown }).variant === "reference" ||
          (artifact as { variant?: unknown }).variant === "base" ||
          (artifact as { variant?: unknown }).variant === "trained"),
    );
    if (artifacts.length !== body.artifacts.length) {
      error(
        res,
        "each artifact must include path and optional variant reference|base|trained",
        400,
      );
      return true;
    }
    try {
      const result = await writeBenchmarkMatrixArtifactFromArtifacts({
        artifacts,
        outputDir: resolveStringSetting(body.outputDir),
        generatedAt: resolveStringSetting(body.generatedAt),
        referenceModelId: resolveStringSetting(body.referenceModelId),
        source:
          body.source &&
          typeof body.source === "object" &&
          !Array.isArray(body.source)
            ? (body.source as Record<string, unknown>)
            : undefined,
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Benchmark matrix from artifacts failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/training/benchmarks/run-vs-cerebras"
  ) {
    const body = await readJsonBody<{
      trainingRoot?: unknown;
      python?: unknown;
      tiers?: unknown;
      benchmark?: unknown;
      variants?: unknown;
      cerebrasModel?: unknown;
      maxSamples?: unknown;
      outputDir?: unknown;
      checkpointsDir?: unknown;
      trainedModelPath?: unknown;
      dryRun?: unknown;
      resultsDb?: unknown;
      datasetVersion?: unknown;
      codeCommit?: unknown;
      matrixOutputDir?: unknown;
    }>(req, res);
    if (!body) return true;
    const benchmark =
      body.benchmark === "clawbench" ||
      body.benchmark === "eliza_harness_action_selection" ||
      body.benchmark === "hermes" ||
      body.benchmark === "all"
        ? body.benchmark
        : undefined;
    const variants =
      body.variants === "trained" ||
      body.variants === "base" ||
      body.variants === "both"
        ? body.variants
        : undefined;
    try {
      const result = await runBenchmarkVsCerebras({
        trainingRoot: resolveStringSetting(body.trainingRoot),
        python: resolveStringSetting(body.python),
        tiers: resolveStringSetting(body.tiers),
        benchmark,
        variants,
        cerebrasModel: resolveStringSetting(body.cerebrasModel),
        maxSamples:
          typeof body.maxSamples === "number" &&
          Number.isFinite(body.maxSamples)
            ? Math.max(1, Math.floor(body.maxSamples))
            : undefined,
        outputDir: resolveStringSetting(body.outputDir),
        checkpointsDir: resolveStringSetting(body.checkpointsDir),
        trainedModelPath: resolveStringSetting(body.trainedModelPath),
        dryRun: body.dryRun === true,
        resultsDb: resolveStringSetting(body.resultsDb),
        datasetVersion: resolveStringSetting(body.datasetVersion),
        codeCommit: resolveStringSetting(body.codeCommit),
        matrixOutputDir: resolveStringSetting(body.matrixOutputDir),
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Benchmark vs Cerebras failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/training/models/stage-eliza1-bundle"
  ) {
    const body = await readJsonBody<{
      trainingRoot?: unknown;
      python?: unknown;
      repoId?: unknown;
      tier?: unknown;
      localDir?: unknown;
      outputDir?: unknown;
      maxBytes?: unknown;
      apply?: unknown;
    }>(req, res);
    if (!body) return true;
    try {
      const result = await stageEliza1Bundle({
        trainingRoot: resolveStringSetting(body.trainingRoot),
        python: resolveStringSetting(body.python),
        repoId: resolveStringSetting(body.repoId),
        tier: resolveStringSetting(body.tier),
        localDir: resolveStringSetting(body.localDir),
        outputDir: resolveStringSetting(body.outputDir),
        maxBytes:
          typeof body.maxBytes === "number" && Number.isFinite(body.maxBytes)
            ? Math.max(1, Math.floor(body.maxBytes))
            : undefined,
        apply: body.apply === true,
      });
      json(res, result, 201);
    } catch (err) {
      error(res, `Eliza-1 bundle staging failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/training/trajectories") {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 100);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"));
    const result = await trainingService.listTrajectories({ limit, offset });
    json(res, result);
    return true;
  }

  const trajectoryMatch = /^\/api\/training\/trajectories\/([^/]+)$/.exec(
    pathname,
  );
  if (method === "GET" && trajectoryMatch) {
    const trajectoryId = decodeURIComponent(trajectoryMatch[1]);
    const detail = await trainingService.getTrajectoryById(trajectoryId);
    if (!detail) {
      error(res, "Trajectory not found", 404);
      return true;
    }
    json(res, { trajectory: detail });
    return true;
  }

  if (method === "GET" && pathname === "/api/training/datasets") {
    json(res, { datasets: trainingService.listDatasets() });
    return true;
  }

  if (method === "POST" && pathname === "/api/training/datasets/build") {
    const body = await readJsonBody<{
      limit?: number;
      minLlmCallsPerTrajectory?: number;
    }>(req, res);
    if (!body) return true;

    try {
      const dataset = await trainingService.buildDataset({
        limit: body.limit,
        minLlmCallsPerTrajectory: body.minLlmCallsPerTrajectory,
      });
      json(res, { dataset }, 201);
    } catch (err) {
      sendServiceError(error, res, err, 500);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/training/backends") {
    const backends = await detectAvailableBackends();
    json(res, { backends });
    return true;
  }

  if (method === "GET" && pathname === "/api/training/jobs") {
    json(res, { jobs: trainingService.listJobs() });
    return true;
  }

  if (method === "POST" && pathname === "/api/training/jobs") {
    const body = await readJsonBody<{
      datasetId?: string;
      maxTrajectories?: number;
      backend?: "mlx" | "cuda" | "cpu";
      model?: string;
      iterations?: number;
      batchSize?: number;
      learningRate?: number;
    }>(req, res);
    if (!body) return true;

    if (body.backend && body.backend !== "cpu") {
      const backends = await detectAvailableBackends();
      if (!backends[body.backend]) {
        const available = (Object.entries(backends) as [string, boolean][])
          .filter(([, ok]) => ok)
          .map(([name]) => name)
          .join(", ");
        error(
          res,
          `Backend '${body.backend}' is not available on this system. Available backends: ${available}`,
          400,
        );
        return true;
      }
    }

    try {
      const job = await trainingService.startTrainingJob({
        datasetId: body.datasetId,
        maxTrajectories: body.maxTrajectories,
        backend: body.backend,
        model: body.model,
        iterations: body.iterations,
        batchSize: body.batchSize,
        learningRate: body.learningRate,
      });
      json(res, { job }, 201);
    } catch (err) {
      sendServiceError(error, res, err, 400);
    }
    return true;
  }

  const jobMatch = /^\/api\/training\/jobs\/([^/]+)$/.exec(pathname);
  if (method === "GET" && jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const job = trainingService.getJob(jobId);
    if (!job) {
      error(res, "Training job not found", 404);
      return true;
    }
    json(res, { job });
    return true;
  }

  const cancelMatch = /^\/api\/training\/jobs\/([^/]+)\/cancel$/.exec(pathname);
  if (method === "POST" && cancelMatch) {
    const jobId = decodeURIComponent(cancelMatch[1]);
    try {
      const job = await trainingService.cancelJob(jobId);
      json(res, { job });
    } catch (err) {
      sendServiceError(error, res, err, 404);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/training/models") {
    json(res, { models: trainingService.listModels() });
    return true;
  }

  const importMatch = /^\/api\/training\/models\/([^/]+)\/import-ollama$/.exec(
    pathname,
  );
  if (method === "POST" && importMatch) {
    const modelId = decodeURIComponent(importMatch[1]);
    const body = await readJsonBody<{
      modelName?: string;
      baseModel?: string;
      ollamaUrl?: string;
    }>(req, res);
    if (!body) return true;

    if (body.ollamaUrl !== undefined && typeof body.ollamaUrl !== "string") {
      error(res, "ollamaUrl must be a string", 400);
      return true;
    }
    if (typeof body.ollamaUrl === "string") {
      const ollamaUrlRejection = resolveOllamaUrlRejection(
        body.ollamaUrl,
        isLoopbackHost,
      );
      if (ollamaUrlRejection) {
        error(res, ollamaUrlRejection, 400);
        return true;
      }
    }

    try {
      const model = await trainingService.importModelToOllama(modelId, body);
      json(res, { model });
    } catch (err) {
      sendServiceError(error, res, err, 400);
    }
    return true;
  }

  const activateMatch = /^\/api\/training\/models\/([^/]+)\/activate$/.exec(
    pathname,
  );
  if (method === "POST" && activateMatch) {
    const modelId = decodeURIComponent(activateMatch[1]);
    const body = await readJsonBody<{ providerModel?: string }>(req, res);
    if (!body) return true;
    try {
      const result = await trainingService.activateModel(
        modelId,
        body.providerModel,
      );
      json(res, result);
    } catch (err) {
      sendServiceError(error, res, err, 400);
    }
    return true;
  }

  const benchmarkMatch = /^\/api\/training\/models\/([^/]+)\/benchmark$/.exec(
    pathname,
  );
  if (method === "POST" && benchmarkMatch) {
    const modelId = decodeURIComponent(benchmarkMatch[1]);
    try {
      const result = await trainingService.benchmarkModel(modelId);
      json(res, result);
    } catch (err) {
      sendServiceError(error, res, err, 400);
    }
    return true;
  }

  // === Synthetic dataset generation ===

  if (method === "GET" && pathname === "/api/training/blueprints") {
    const { ALL_BLUEPRINTS, BLUEPRINT_STATS } =
      await import("../core/scenario-blueprints.js");
    json(res, {
      count: ALL_BLUEPRINTS.length,
      stats: BLUEPRINT_STATS,
      blueprints: ALL_BLUEPRINTS.map((b) => ({
        id: b.id,
        decision: b.decision,
        primaryContext: b.primaryContext,
        pattern: b.pattern,
        description: b.description,
      })),
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/training/context-catalog") {
    const { ACTION_CONTEXT_MAP, PROVIDER_CONTEXT_MAP, ALL_CONTEXTS } =
      await import("../core/context-catalog.js");
    json(res, {
      contexts: ALL_CONTEXTS,
      actions: ACTION_CONTEXT_MAP,
      providers: PROVIDER_CONTEXT_MAP,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/training/context-audit") {
    if (
      !runtime ||
      !Array.isArray((runtime as { plugins?: unknown }).plugins)
    ) {
      error(
        res,
        "Runtime with loaded plugins is required for context audit",
        503,
      );
      return true;
    }

    const { auditRuntimeContextCoverage, hasContextAuditGaps } =
      await import("../core/context-audit.js");
    const audit = auditRuntimeContextCoverage(
      runtime as AgentRuntime & {
        plugins: NonNullable<AgentRuntime["plugins"]>;
      },
    );

    json(res, {
      audit,
      hasGaps: hasContextAuditGaps(audit),
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/training/generate-dataset") {
    const body = await readJsonBody<{
      variantsPerBlueprint?: number;
      filterContexts?: string[];
      filterDecisions?: string[];
      limitBlueprints?: number;
      concurrency?: number;
      includeRoleplay?: boolean;
    }>(req, res);
    if (!body) return true;

    const cerebrasKey = process.env.CEREBRAS_API_KEY;
    const trainProvider =
      process.env.TRAIN_MODEL_PROVIDER?.trim() ??
      process.env.TRAINING_PROVIDER?.trim();
    const anthropicKey =
      resolveStringSetting(runtime?.getSetting?.("ANTHROPIC_API_KEY")) ??
      process.env.ANTHROPIC_API_KEY;
    const openaiKey =
      resolveStringSetting(runtime?.getSetting?.("OPENAI_API_KEY")) ??
      process.env.OPENAI_API_KEY;

    if (!cerebrasKey && !anthropicKey && !openaiKey) {
      error(
        res,
        "No teacher model API key found. Set CEREBRAS_API_KEY (preferred), ANTHROPIC_API_KEY, or OPENAI_API_KEY.",
        400,
      );
      return true;
    }

    const {
      generateDataset,
      exportToElizaNativeJSONL,
      createAnthropicTeacher,
      createCerebrasTeacher,
      createOpenAITeacher,
    } = await import("../core/dataset-generator.js");
    const { buildRoleplayEpisodes, exportRoleplayEpisodes } =
      await import("../core/roleplay-trajectories.js");

    const teacher =
      trainProvider === "cerebras" && cerebrasKey
        ? createCerebrasTeacher(runtime ?? undefined)
        : anthropicKey
          ? createAnthropicTeacher(anthropicKey, runtime ?? undefined)
          : createOpenAITeacher(openaiKey!, runtime ?? undefined);

    const outputDir = `.tmp/training-data-${Date.now()}`;

    try {
      const samples = await generateDataset({
        variantsPerBlueprint: body.variantsPerBlueprint ?? 5,
        teacher,
        outputDir,
        concurrency: body.concurrency ?? 5,
        limitBlueprints: body.limitBlueprints,
        filterContexts: narrowAgentContexts(body.filterContexts),
        filterDecisions: narrowAgentDecisions(body.filterDecisions),
      });

      const { validateDataset } = await import("../core/replay-validator.js");
      const report = validateDataset(samples);

      const paths = await exportToElizaNativeJSONL(samples, outputDir);
      const roleplayPaths =
        body.includeRoleplay === false
          ? undefined
          : await exportRoleplayEpisodes(
              buildRoleplayEpisodes(samples),
              samples,
              outputDir,
            );

      json(
        res,
        {
          samplesGenerated: samples.length,
          report,
          paths,
          roleplayPaths,
          outputDir,
        },
        201,
      );
    } catch (err) {
      error(res, `Dataset generation failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/generate-roleplay") {
    const body = await readJsonBody<{
      variantsPerBlueprint?: number;
      filterContexts?: string[];
      filterDecisions?: string[];
      limitBlueprints?: number;
      concurrency?: number;
    }>(req, res);
    if (!body) return true;

    const cerebrasKey = process.env.CEREBRAS_API_KEY;
    const trainProvider =
      process.env.TRAIN_MODEL_PROVIDER?.trim() ??
      process.env.TRAINING_PROVIDER?.trim();
    const anthropicKey =
      resolveStringSetting(runtime?.getSetting?.("ANTHROPIC_API_KEY")) ??
      process.env.ANTHROPIC_API_KEY;
    const openaiKey =
      resolveStringSetting(runtime?.getSetting?.("OPENAI_API_KEY")) ??
      process.env.OPENAI_API_KEY;

    if (!cerebrasKey && !anthropicKey && !openaiKey) {
      error(
        res,
        "No teacher model API key found. Set CEREBRAS_API_KEY (preferred), ANTHROPIC_API_KEY, or OPENAI_API_KEY.",
        400,
      );
      return true;
    }

    const {
      generateDataset,
      createAnthropicTeacher,
      createCerebrasTeacher,
      createOpenAITeacher,
    } = await import("../core/dataset-generator.js");
    const { buildRoleplayEpisodes, exportRoleplayEpisodes } =
      await import("../core/roleplay-trajectories.js");

    const teacher =
      trainProvider === "cerebras" && cerebrasKey
        ? createCerebrasTeacher(runtime ?? undefined)
        : anthropicKey
          ? createAnthropicTeacher(anthropicKey, runtime ?? undefined)
          : createOpenAITeacher(openaiKey!, runtime ?? undefined);
    const outputDir = `.tmp/training-roleplay-${Date.now()}`;

    try {
      const samples = await generateDataset({
        variantsPerBlueprint: body.variantsPerBlueprint ?? 3,
        teacher,
        outputDir,
        concurrency: body.concurrency ?? 5,
        limitBlueprints: body.limitBlueprints,
        filterContexts: narrowAgentContexts(body.filterContexts),
        filterDecisions: narrowAgentDecisions(body.filterDecisions),
      });
      const episodes = buildRoleplayEpisodes(samples);
      const paths = await exportRoleplayEpisodes(episodes, samples, outputDir);

      json(
        res,
        {
          samplesGenerated: samples.length,
          episodesGenerated: episodes.length,
          outputDir,
          paths,
        },
        201,
      );
    } catch (err) {
      error(res, `Roleplay generation failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/roleplay/execute") {
    const body = await readJsonBody<{
      episodesPath?: string;
      manifestPath?: string;
      outputDir?: string;
      timeoutMs?: number;
      executeAllParticipantTurns?: boolean;
    }>(req, res);
    if (!body) return true;

    if (!runtime) {
      error(res, "Runtime is required to execute roleplay episodes", 503);
      return true;
    }

    const inputPath = body.episodesPath ?? body.manifestPath;
    if (!inputPath) {
      error(res, "episodesPath or manifestPath is required", 400);
      return true;
    }

    const {
      buildRoleplayExecutionReport,
      executeRoleplayEpisodes,
      exportRoleplayExecutionResults,
      loadRoleplayEpisodesFromPath,
    } = await import("../core/roleplay-executor.js");

    try {
      const episodes = await loadRoleplayEpisodesFromPath(inputPath);
      const executions = await executeRoleplayEpisodes(episodes, {
        runtime,
        timeoutMs: body.timeoutMs,
        executeAllParticipantTurns: body.executeAllParticipantTurns ?? false,
      });
      const outputDir =
        body.outputDir ?? `.tmp/training-roleplay-execution-${Date.now()}`;
      const paths = await exportRoleplayExecutionResults(executions, outputDir);
      const report = buildRoleplayExecutionReport(
        executions,
        paths.trajectoryDataset?.summary ?? null,
      );

      json(
        res,
        {
          episodesExecuted: executions.length,
          report,
          outputDir,
          paths,
        },
        201,
      );
    } catch (err) {
      error(res, `Roleplay execution failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/trajectories/export") {
    const body = await readJsonBody<{
      limit?: number;
      trajectoryIds?: string[];
      agentName?: string;
      outputPath?: string;
      outputDir?: string;
      splitByTask?: boolean;
      bundle?: boolean;
      exportBundle?: boolean;
      includeRaw?: boolean;
      includeRawJsonl?: boolean;
      tasks?: string[];
      runId?: string;
    }>(req, res);
    if (!body) return true;

    if (body.runId !== undefined && !normalizeRunId(body.runId)) {
      error(res, "runId must be a non-empty string", 400);
      return true;
    }

    const outputPath =
      body.outputPath ?? `.tmp/training-trajectory-export-${Date.now()}.jsonl`;

    try {
      const explicitIds = Array.isArray(body.trajectoryIds)
        ? body.trajectoryIds.filter((id) => typeof id === "string" && id.trim())
        : [];
      const listedTrajectories =
        explicitIds.length > 0
          ? null
          : await trainingService.listTrajectories({
              limit: body.limit ?? 100,
              offset: 0,
              runId: normalizeRunId(body.runId),
            });
      const trajectoryIds =
        explicitIds.length > 0
          ? explicitIds
          : (listedTrajectories?.trajectories ?? [])
              .map((item) => item.id)
              .filter((id) => id.length > 0);

      const details = (
        await Promise.all(
          trajectoryIds.map((trajectoryId: string) =>
            trainingService.getTrajectoryById(trajectoryId),
          ),
        )
      ).filter((t): t is Trajectory => t !== null);

      if (body.bundle || body.exportBundle) {
        const requestedRunId = normalizeRunId(body.runId);
        const bundleTrajectories = requestedRunId
          ? details.filter((trajectory) =>
              trajectoryHasRunId(trajectory, requestedRunId),
            )
          : details;
        const { buildTrajectoryExportBundle } =
          await import("../core/trajectory-export-bundle.js");
        const bundle = await buildTrajectoryExportBundle({
          trajectories: bundleTrajectories,
          outputDir:
            body.outputDir ?? `.tmp/training-trajectory-bundle-${Date.now()}`,
          includeRawJsonl:
            body.includeRawJsonl === true || body.includeRaw === true,
          tasks: narrowTrainingTasks(body.tasks),
          source: {
            kind: "training-trajectories-export-route",
            runId: requestedRunId,
            metadata: {
              requestedLimit: body.limit ?? 100,
              requestedRunId: requestedRunId ?? null,
              explicitTrajectoryIds: explicitIds.length,
              selectedTrajectoryIds: trajectoryIds.length,
              loadedTrajectories: details.length,
              bundledTrajectories: bundleTrajectories.length,
            },
          },
        });

        json(
          res,
          {
            trajectoriesConsidered: trajectoryIds.length,
            trajectoriesBundled: bundleTrajectories.length,
            outputDir: bundle.outputDir,
            manifestPath: bundle.manifestPath,
            bundle: bundle.manifest,
          },
          201,
        );
        return true;
      }

      let exported = 0;
      let taskDataset:
        | Pick<TrajectoryTaskDatasetExport, "counts" | "paths" | "summary">
        | undefined;

      if (body.splitByTask || body.outputDir || body.tasks?.length) {
        const { exportTrajectoryTaskDatasets } =
          await import("../core/trajectory-task-datasets.js");
        const dataset = await exportTrajectoryTaskDatasets(
          details,
          body.outputDir ?? `.tmp/training-trajectory-export-${Date.now()}`,
          narrowTrainingTasks(body.tasks),
        );
        exported =
          dataset.counts.should_respond +
          dataset.counts.context_routing +
          dataset.counts.action_planner +
          dataset.counts.response +
          dataset.counts.media_description;
        taskDataset = {
          counts: dataset.counts,
          paths: dataset.paths,
          summary: dataset.summary,
        };
      } else {
        const { exportTrajectoriesAsTraining } =
          await import("../core/dataset-generator.js");
        exported = await exportTrajectoriesAsTraining(
          details,
          body.agentName ?? runtime?.character?.name ?? "Agent",
          outputPath,
        );
      }

      json(
        res,
        {
          exportedExamples: exported,
          trajectoriesConsidered: trajectoryIds.length,
          outputPath,
          taskDataset,
        },
        201,
      );
    } catch (err) {
      error(res, `Trajectory export failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/trajectories/publish") {
    const hfConfig = resolveHfUploadConfig();
    if (!hfConfig) {
      error(
        res,
        "HuggingFace publishing is not configured. Set ELIZA_TRAJECTORY_HF_REPO and an HF token (HF_TOKEN, with HUGGINGFACE_HUB_TOKEN / HUGGING_FACE_HUB_TOKEN accepted as fallbacks).",
        409,
      );
      return true;
    }

    const body = await readJsonBody<{
      limit?: number;
      trajectoryIds?: string[];
      outputDir?: string;
      tasks?: string[];
    }>(req, res);
    if (!body) return true;

    try {
      const explicitIds = Array.isArray(body.trajectoryIds)
        ? body.trajectoryIds.filter((id) => typeof id === "string" && id.trim())
        : [];
      const listed =
        explicitIds.length > 0
          ? null
          : await trainingService.listTrajectories({
              limit: body.limit ?? 500,
              offset: 0,
            });
      const trajectoryIds =
        explicitIds.length > 0
          ? explicitIds
          : (listed?.trajectories ?? [])
              .map((item) => item.id)
              .filter((id) => id.length > 0);

      const details = (
        await Promise.all(
          trajectoryIds.map((trajectoryId: string) =>
            trainingService.getTrajectoryById(trajectoryId),
          ),
        )
      ).filter((t): t is Trajectory => t !== null);

      const { buildTrajectoryExportBundle } =
        await import("../core/trajectory-export-bundle.js");
      const bundle = await buildTrajectoryExportBundle({
        trajectories: details,
        outputDir:
          body.outputDir ?? `.tmp/training-trajectory-publish-${Date.now()}`,
        tasks: narrowTrainingTasks(body.tasks),
        // Privacy filter forced on with the default hash anonymizer.
        privacy: {
          apply: true,
          options: { anonymizer: createHashAnonymizer() },
        },
        uploadToHuggingFace: hfConfig,
        source: {
          kind: "training-trajectories-publish-route",
          metadata: {
            requestedLimit: body.limit ?? 500,
            explicitTrajectoryIds: explicitIds.length,
            selectedTrajectoryIds: trajectoryIds.length,
            loadedTrajectories: details.length,
          },
        },
      });

      if (!bundle.manifest.cloudUpload.uploadedToHuggingFace) {
        error(
          res,
          `HuggingFace upload failed: ${bundle.manifest.cloudUpload.huggingFaceError ?? "unknown error"}`,
          502,
        );
        return true;
      }

      json(
        res,
        {
          trajectoriesConsidered: trajectoryIds.length,
          trajectoriesPublished: bundle.manifest.counts.sanitizedTrajectoryRows,
          outputDir: bundle.outputDir,
          manifestPath: bundle.manifestPath,
          cloudUpload: bundle.manifest.cloudUpload,
        },
        201,
      );
    } catch (err) {
      error(res, `Trajectory publish failed: ${String(err)}`, 500);
    }
    return true;
  }

  return false;
}
