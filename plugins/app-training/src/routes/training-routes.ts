import type { RouteHelpers, RouteRequestContext } from "@elizaos/core";
import type { Trajectory } from "@elizaos/agent";
import { parsePositiveInteger } from "@elizaos/shared";
import type { AgentRuntime } from "@elizaos/core";
import { AGENT_CONTEXTS, type AgentContext } from "../core/context-types.js";
import type { RoleplayExecutionReport } from "../core/roleplay-executor.js";
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
import type {
  TrajectoryTaskDatasetExport,
  TrajectoryTrainingTask,
} from "../core/trajectory-task-datasets.js";
import { detectAvailableBackends } from "../services/training-backend-check.js";
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

    const dataset = await trainingService.buildDataset({
      limit: body.limit,
      minLlmCallsPerTrajectory: body.minLlmCallsPerTrajectory,
    });
    json(res, { dataset }, 201);
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
      const message = String(err);
      error(res, message, 400);
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
      const message = String(err);
      error(res, message, 404);
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
      const message = String(err);
      error(res, message, 400);
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
      const message = String(err);
      error(res, message, 400);
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
      const message = String(err);
      error(res, message, 400);
    }
    return true;
  }

  // === Synthetic dataset generation ===

  if (method === "GET" && pathname === "/api/training/blueprints") {
    const { ALL_BLUEPRINTS, BLUEPRINT_STATS } = await import(
      "../core/scenario-blueprints.js"
    );
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

    const { auditRuntimeContextCoverage, hasContextAuditGaps } = await import(
      "../core/context-audit.js"
    );
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
      process.env.TRAIN_MODEL_PROVIDER?.trim() ?? process.env.TRAINING_PROVIDER?.trim();
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
    const { buildRoleplayEpisodes, exportRoleplayEpisodes } = await import(
      "../core/roleplay-trajectories.js"
    );

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
      process.env.TRAIN_MODEL_PROVIDER?.trim() ?? process.env.TRAINING_PROVIDER?.trim();
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
    const { buildRoleplayEpisodes, exportRoleplayEpisodes } = await import(
      "../core/roleplay-trajectories.js"
    );

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
        const { buildTrajectoryExportBundle } = await import(
          "../core/trajectory-export-bundle.js"
        );
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
        const { exportTrajectoryTaskDatasets } = await import(
          "../core/trajectory-task-datasets.js"
        );
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
        const { exportTrajectoriesAsTraining } = await import(
          "../core/dataset-generator.js"
        );
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

  return false;
}
