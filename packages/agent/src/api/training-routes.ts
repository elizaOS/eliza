import type { AgentRuntime } from "@elizaos/core";
import type { RoleplayExecutionReport } from "../training/roleplay-executor.js";
import type { TrajectoryTaskDatasetExport } from "../training/trajectory-task-datasets.js";
import { parsePositiveInteger } from "../utils/number-parsing.js";
import type { RouteHelpers, RouteRequestContext } from "./route-helpers.js";
import { detectAvailableBackends } from "./training-backend-check.js";
import type { TrainingServiceLike } from "./training-service-like.js";

export type TrainingRouteHelpers = RouteHelpers;

export interface TrainingRouteContext extends RouteRequestContext {
  runtime: AgentRuntime | null;
  trainingService: TrainingServiceLike;
  isLoopbackHost: (host: string) => boolean;
}

function resolveStringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
    json(res, {
      ...status,
      runtimeAvailable: runtime !== null,
    });
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
      "../training/scenario-blueprints.js"
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
      await import("../training/context-catalog.js");
    json(res, {
      contexts: ALL_CONTEXTS,
      actions: ACTION_CONTEXT_MAP,
      providers: PROVIDER_CONTEXT_MAP,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/training/context-audit") {
    if (!runtime || !Array.isArray((runtime as { plugins?: unknown }).plugins)) {
      error(res, "Runtime with loaded plugins is required for context audit", 503);
      return true;
    }

    const { auditRuntimeContextCoverage, hasContextAuditGaps } = await import(
      "../training/context-audit.js"
    );
    const audit = auditRuntimeContextCoverage(
      runtime as AgentRuntime & { plugins: NonNullable<AgentRuntime["plugins"]> },
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

    const anthropicKey =
      resolveStringSetting(runtime?.getSetting?.("ANTHROPIC_API_KEY")) ??
      process.env.ANTHROPIC_API_KEY;
    const openaiKey =
      resolveStringSetting(runtime?.getSetting?.("OPENAI_API_KEY")) ??
      process.env.OPENAI_API_KEY;

    if (!anthropicKey && !openaiKey) {
      error(res, "No teacher model API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.", 400);
      return true;
    }

    const {
      generateDataset,
      exportToGeminiJSONL,
      createAnthropicTeacher,
      createOpenAITeacher,
    } = await import("../training/dataset-generator.js");
    const {
      buildRoleplayEpisodes,
      exportRoleplayEpisodes,
    } = await import("../training/roleplay-trajectories.js");

    const teacher = anthropicKey
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
        filterContexts: body.filterContexts as any,
        filterDecisions: body.filterDecisions as any,
      });

      const { validateDataset } = await import("../training/replay-validator.js");
      const report = validateDataset(samples);

      const paths = await exportToGeminiJSONL(samples, outputDir);
      const roleplayPaths =
        body.includeRoleplay === false
          ? undefined
          : await exportRoleplayEpisodes(
              buildRoleplayEpisodes(samples),
              samples,
              outputDir,
            );

      json(res, {
        samplesGenerated: samples.length,
        report,
        paths,
        roleplayPaths,
        outputDir,
      }, 201);
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

    const anthropicKey =
      resolveStringSetting(runtime?.getSetting?.("ANTHROPIC_API_KEY")) ??
      process.env.ANTHROPIC_API_KEY;
    const openaiKey =
      resolveStringSetting(runtime?.getSetting?.("OPENAI_API_KEY")) ??
      process.env.OPENAI_API_KEY;

    if (!anthropicKey && !openaiKey) {
      error(
        res,
        "No teacher model API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
        400,
      );
      return true;
    }

    const {
      generateDataset,
      createAnthropicTeacher,
      createOpenAITeacher,
    } = await import("../training/dataset-generator.js");
    const {
      buildRoleplayEpisodes,
      exportRoleplayEpisodes,
    } = await import("../training/roleplay-trajectories.js");

    const teacher = anthropicKey
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
        filterContexts: body.filterContexts as any,
        filterDecisions: body.filterDecisions as any,
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
    } = await import("../training/roleplay-executor.js");

    try {
      const episodes = await loadRoleplayEpisodesFromPath(inputPath);
      const executions = await executeRoleplayEpisodes(episodes, {
        runtime,
        timeoutMs: body.timeoutMs,
        executeAllParticipantTurns: body.executeAllParticipantTurns ?? false,
      });
      const outputDir = body.outputDir ?? `.tmp/training-roleplay-execution-${Date.now()}`;
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
      tasks?: string[];
    }>(req, res);
    if (!body) return true;

    const outputPath =
      body.outputPath ?? `.tmp/training-trajectory-export-${Date.now()}.jsonl`;

    try {
      const explicitIds = Array.isArray(body.trajectoryIds)
        ? body.trajectoryIds.filter((id) => typeof id === "string" && id.trim())
        : [];
      const listedTrajectories =
        explicitIds.length > 0
          ? null
          : ((await trainingService.listTrajectories({
              limit: body.limit ?? 100,
              offset: 0,
            })) as {
              trajectories?: Array<Record<string, unknown>>;
            });
      const trajectoryIds =
        explicitIds.length > 0
          ? explicitIds
          : (listedTrajectories?.trajectories ?? [])
              .map((item) =>
                String(item.trajectoryId ?? item.id ?? ""),
              )
              .filter((id: string) => id.length > 0);

      const details = (
        await Promise.all(
          trajectoryIds.map((trajectoryId: string) =>
            trainingService.getTrajectoryById(trajectoryId),
          ),
        )
      ).filter(Boolean);

      let exported = 0;
      let taskDataset:
        | Pick<TrajectoryTaskDatasetExport, "counts" | "paths" | "summary">
        | undefined;

      if (body.splitByTask || body.outputDir || body.tasks?.length) {
        const {
          exportTrajectoryTaskDatasets,
        } = await import("../training/trajectory-task-datasets.js");
        const dataset = await exportTrajectoryTaskDatasets(
          details as any,
          body.outputDir ?? `.tmp/training-trajectory-export-${Date.now()}`,
          body.tasks as any,
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
          "../training/dataset-generator.js"
        );
        exported = await exportTrajectoriesAsTraining(
          details as Array<{
            steps: Array<{
              llmCalls: Array<{
                purpose?: string;
                systemPrompt?: string;
                userPrompt?: string;
                response?: string;
                model?: string;
              }>;
            }>;
            metadata?: Record<string, unknown>;
          }>,
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

  // === Vertex AI tuning ===

  if (method === "POST" && pathname === "/api/training/vertex/tune") {
    const body = await readJsonBody<{
      projectId: string;
      gcsBucket: string;
      baseModel?: string;
      trainingDataPath: string;
      validationDataPath?: string;
      epochs?: number;
      displayName?: string;
      region?: string;
    }>(req, res);
    if (!body) return true;

    if (!body.projectId || !body.gcsBucket || !body.trainingDataPath) {
      error(res, "projectId, gcsBucket, and trainingDataPath are required", 400);
      return true;
    }

    const { createTuningJob } = await import("../training/vertex-tuning.js");

    try {
      const job = await createTuningJob({
        projectId: body.projectId,
        region: body.region ?? "us-central1",
        gcsBucket: body.gcsBucket,
        baseModel: (body.baseModel === "flash" ? "gemini-2.5-flash" : "gemini-2.5-flash-lite") as any,
        trainingDataPath: body.trainingDataPath,
        validationDataPath: body.validationDataPath,
        epochs: body.epochs ?? 3,
        displayName: body.displayName ?? "eliza-should-respond",
      });
      json(res, { job }, 201);
    } catch (err) {
      error(res, `Tuning job creation failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/training/vertex/job-status") {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const jobName = url.searchParams.get("name");
    if (!jobName) {
      error(res, "name query parameter is required", 400);
      return true;
    }

    const { getTuningJobStatus } = await import("../training/vertex-tuning.js");

    try {
      const job = await getTuningJobStatus(jobName);
      json(res, { job });
    } catch (err) {
      error(res, `Failed to get tuning job status: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/training/vertex/orchestrate") {
    const body = await readJsonBody<{
      projectId: string;
      gcsBucket: string;
      trainingDataPath?: string;
      validationDataPath?: string;
      roleplayEpisodesPath?: string;
      roleplayManifestPath?: string;
      executeAllParticipantTurns?: boolean;
      slot?: string;
      scope?: "global" | "organization" | "user";
      ownerId?: string;
      baseModel?: string;
      displayName?: string;
      region?: string;
      epochs?: number;
      variantsPerBlueprint?: number;
      filterContexts?: string[];
      filterDecisions?: string[];
      limitBlueprints?: number;
      concurrency?: number;
    }>(req, res);
    if (!body) return true;

    if (!body.projectId || !body.gcsBucket) {
      error(res, "projectId and gcsBucket are required", 400);
      return true;
    }

    const anthropicKey =
      resolveStringSetting(runtime?.getSetting?.("ANTHROPIC_API_KEY")) ??
      process.env.ANTHROPIC_API_KEY;
    const openaiKey =
      resolveStringSetting(runtime?.getSetting?.("OPENAI_API_KEY")) ??
      process.env.OPENAI_API_KEY;

    const {
      createAnthropicTeacher,
      createOpenAITeacher,
      exportToGeminiJSONL,
      generateDataset,
    } = await import("../training/dataset-generator.js");
    const {
      normalizeVertexBaseModel,
      orchestrateVertexTuning,
    } = await import("../training/vertex-tuning.js");

    const slot = (body.slot ?? "should_respond") as
      | "should_respond"
      | "response_handler"
      | "action_planner"
      | "planner"
      | "response"
      | "media_description";

    try {
      let trainingDataPath = body.trainingDataPath;
      let datasetOutputDir: string | undefined;
      let datasetPaths:
        | {
            shouldRespondPath: string;
            contextRoutingPath: string;
            combinedPath: string;
          }
        | undefined;
      let roleplayExecution:
        | {
            episodesExecuted: number;
            outputDir: string;
            report: RoleplayExecutionReport;
            trajectoryDataset: Pick<
              TrajectoryTaskDatasetExport,
              "counts" | "paths" | "summary"
            > | null;
          }
        | undefined;

      if (!trainingDataPath) {
        datasetOutputDir = `.tmp/training-orchestration-${Date.now()}`;
        const roleplayInputPath =
          body.roleplayEpisodesPath ?? body.roleplayManifestPath;

        if (runtime && roleplayInputPath) {
          const {
            buildRoleplayExecutionReport,
            executeRoleplayEpisodes,
            exportRoleplayExecutionResults,
            loadRoleplayEpisodesFromPath,
          } = await import("../training/roleplay-executor.js");
          const episodes = await loadRoleplayEpisodesFromPath(roleplayInputPath);
          const roleplayOutputDir = `${datasetOutputDir}/roleplay-execution`;
          const executions = await executeRoleplayEpisodes(episodes, {
            runtime,
            executeAllParticipantTurns: body.executeAllParticipantTurns ?? false,
          });
          const exportedReplay = await exportRoleplayExecutionResults(
            executions,
            roleplayOutputDir,
          );
          const report = buildRoleplayExecutionReport(
            executions,
            exportedReplay.trajectoryDataset?.summary ?? null,
          );
          roleplayExecution = {
            episodesExecuted: executions.length,
            outputDir: roleplayOutputDir,
            report,
            trajectoryDataset: exportedReplay.trajectoryDataset
              ? {
                  counts: exportedReplay.trajectoryDataset.counts,
                  paths: exportedReplay.trajectoryDataset.paths,
                  summary: exportedReplay.trajectoryDataset.summary,
                }
              : null,
          };

          const roleplayTaskPath =
            slot === "should_respond" || slot === "response_handler"
              ? exportedReplay.trajectoryDataset?.paths.shouldRespondPath
              : slot === "action_planner" || slot === "planner"
                ? exportedReplay.trajectoryDataset?.paths.actionPlannerPath
                : slot === "response"
                  ? exportedReplay.trajectoryDataset?.paths.responsePath
                  : slot === "media_description"
                    ? exportedReplay.trajectoryDataset?.paths.mediaDescriptionPath
                    : undefined;

          if (roleplayTaskPath) {
            trainingDataPath = roleplayTaskPath;
          }
        }

        if (!trainingDataPath) {
          if (!anthropicKey && !openaiKey) {
            error(
              res,
              "No teacher model API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, provide trainingDataPath, or provide roleplayEpisodesPath/roleplayManifestPath.",
              400,
            );
            return true;
          }

          const teacher = anthropicKey
            ? createAnthropicTeacher(anthropicKey, runtime ?? undefined)
            : createOpenAITeacher(openaiKey!, runtime ?? undefined);
          const samples = await generateDataset({
            variantsPerBlueprint: body.variantsPerBlueprint ?? 5,
            teacher,
            outputDir: datasetOutputDir,
            concurrency: body.concurrency ?? 5,
            limitBlueprints: body.limitBlueprints,
            filterContexts: body.filterContexts as any,
            filterDecisions: body.filterDecisions as any,
          });
          datasetPaths = await exportToGeminiJSONL(samples, datasetOutputDir);
          trainingDataPath =
            slot === "should_respond" || slot === "response_handler"
              ? datasetPaths.shouldRespondPath
              : slot === "action_planner" || slot === "planner"
                ? datasetPaths.combinedPath
                : datasetPaths.combinedPath;
        }
      }

      const orchestration = await orchestrateVertexTuning({
        projectId: body.projectId,
        region: body.region ?? "us-central1",
        gcsBucket: body.gcsBucket,
        baseModel: normalizeVertexBaseModel(body.baseModel, slot),
        trainingDataPath,
        validationDataPath: body.validationDataPath,
        epochs: body.epochs ?? 3,
        displayName:
          body.displayName ??
          `eliza-${slot.replace(/_/g, "-")}-${Date.now()}`,
        slot,
        scope: body.scope ?? "global",
        ownerId: body.ownerId,
      });

      json(
        res,
        {
          ...orchestration,
          datasetOutputDir,
          datasetPaths,
          roleplayExecution,
        },
        201,
      );
    } catch (err) {
      error(res, `Vertex orchestration failed: ${String(err)}`, 500);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/training/vertex/jobs") {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const projectId = url.searchParams.get("projectId");
    const region = url.searchParams.get("region") ?? "us-central1";

    if (!projectId) {
      error(res, "projectId query parameter is required", 400);
      return true;
    }

    const { listTuningJobs } = await import("../training/vertex-tuning.js");

    try {
      const jobs = await listTuningJobs(projectId, region);
      json(res, { jobs });
    } catch (err) {
      error(res, `Failed to list tuning jobs: ${String(err)}`, 500);
    }
    return true;
  }

  return false;
}
