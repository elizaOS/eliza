/**
 * Trajectory storage — write operations.
 *
 * Handles saving, updating, deleting trajectories, installing the database
 * logger, and the DatabaseTrajectoryLogger service class.
 */

import path from "node:path";
import {
  logger as coreLogger,
  type IAgentRuntime,
  Service,
} from "@elizaos/core";
import type {
  Trajectory,
  TrajectoryExportResult,
  TrajectoryListItem,
  TrajectoryListOptions,
  TrajectoryListResult,
  TrajectoryStatus,
  TrajectoryStepKind,
} from "../types/trajectory.ts";
import {
  exportPersistedTrajectories,
  persistedTrajectoryToDetailRecord,
  type RuntimeTrajectoryExportOptions,
  trajectoryRowToListItem,
} from "./trajectory-export.ts";
import {
  asRecord,
  type CompleteStepOptions,
  capScriptForPersistence,
  computeBySource,
  createBaseTrajectory,
  enqueueStepWrite,
  enrichTrajectoryLlmCall,
  ensureStep,
  ensureTrajectoriesTable,
  executeRawSql,
  extractInsightsFromResponse,
  extractRows,
  hasRuntimeDb,
  lastWritePromises,
  loadTrajectoryById,
  mergeMetadata,
  normalizeLlmCallPayload,
  normalizeProviderAccessPayload,
  normalizeStatus,
  normalizeStepId,
  normalizeTrajectoryMetadata,
  type PersistedLlmCall,
  type PersistedProviderAccess,
  type PersistedTrajectory,
  parsePersistedTrajectoryRow,
  patchedLoggers,
  pushChatExchange,
  readOrchestratorTrajectoryContext,
  resolveTrajectoryArchiveDirectory,
  resolveTrajectoryLogger,
  type StartStepOptions,
  saveTrajectory,
  shouldEnableTrajectoryLoggingByDefault,
  shouldRunObservationExtraction,
  shouldSuppressNoInputEmbeddingCall,
  sqlQuote,
  stepWriteQueues,
  toArchiveSafeTimestamp,
  toNumber,
  toOptionalNumber,
  toText,
  truncateRecord,
  warnRuntime,
  writeCompressedJsonlRows,
} from "./trajectory-internals.ts";

// Re-export types needed by consumers
export type {
  CompleteStepOptions,
  StartStepOptions,
} from "./trajectory-internals.ts";

// ---------------------------------------------------------------------------
// appendLlmCall / appendProviderAccess
// ---------------------------------------------------------------------------

async function appendLlmCall(
  runtime: IAgentRuntime,
  stepId: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (shouldSuppressNoInputEmbeddingCall(params)) return;

  const now = toNumber(params.timestamp, Date.now());
  const trajectory =
    (await loadTrajectoryById(runtime, stepId)) ??
    createBaseTrajectory(stepId, now);

  trajectory.source = trajectory.source || "runtime";
  trajectory.status =
    trajectory.status === "active" ? "active" : trajectory.status;

  const orchestratorCtx = readOrchestratorTrajectoryContext(runtime);

  const fullResponse = toText(params.response, "");
  const purpose =
    orchestratorCtx?.decisionType ?? toText(params.purpose, "action");
  const insights = extractInsightsFromResponse(fullResponse, purpose);

  const step = ensureStep(trajectory, stepId, now);
  const call = enrichTrajectoryLlmCall({
    callId: toText(params.callId, `${stepId}-call-${step.llmCalls.length + 1}`),
    timestamp: now,
    provider: toText(params.provider, ""),
    model: toText(params.model, "unknown"),
    modelType: toText(params.modelType, ""),
    systemPrompt: toText(params.systemPrompt, ""),
    userPrompt: toText(params.userPrompt ?? params.input, ""),
    prompt: toText(params.prompt ?? params.userPrompt ?? params.input, ""),
    messages: Array.isArray(params.messages) ? params.messages : undefined,
    tools: params.tools,
    toolChoice: params.toolChoice,
    output: params.output,
    responseSchema: params.responseSchema,
    providerOptions: params.providerOptions,
    response: fullResponse,
    toolCalls: Array.isArray(params.toolCalls) ? params.toolCalls : undefined,
    finishReason: toText(params.finishReason, ""),
    providerMetadata: params.providerMetadata,
    temperature: toNumber(params.temperature, 0),
    maxTokens: toNumber(params.maxTokens, 0),
    purpose,
    actionType: orchestratorCtx
      ? "orchestrator.useModel"
      : toText(params.actionType, "runtime.useModel"),
    latencyMs: toNumber(params.latencyMs, 0),
  }) as PersistedLlmCall;

  const promptTokens = toOptionalNumber(params.promptTokens);
  const completionTokens = toOptionalNumber(params.completionTokens);
  const cacheReadInputTokens = toOptionalNumber(params.cacheReadInputTokens);
  const cacheCreationInputTokens = toOptionalNumber(
    params.cacheCreationInputTokens,
  );
  if (promptTokens !== undefined) call.promptTokens = promptTokens;
  if (completionTokens !== undefined) call.completionTokens = completionTokens;
  if (cacheReadInputTokens !== undefined) {
    call.cacheReadInputTokens = cacheReadInputTokens;
  }
  if (cacheCreationInputTokens !== undefined) {
    call.cacheCreationInputTokens = cacheCreationInputTokens;
  }
  if (typeof params.modelVersion === "string") {
    call.modelVersion = params.modelVersion;
  }
  if (typeof params.reasoning === "string") {
    call.reasoning = params.reasoning;
  }
  const topP = toOptionalNumber(params.topP);
  if (topP !== undefined) {
    call.topP = topP;
  }
  if (typeof params.modelSlot === "string") {
    call.modelSlot = params.modelSlot;
  }
  if (typeof params.runId === "string") {
    call.runId = params.runId;
  }
  if (typeof params.roomId === "string") {
    call.roomId = params.roomId;
  }
  if (typeof params.messageId === "string") {
    call.messageId = params.messageId;
  }
  if (typeof params.executionTraceId === "string") {
    call.executionTraceId = params.executionTraceId;
  }
  if (typeof params.createdAt === "string") {
    call.createdAt = params.createdAt;
  }
  if (typeof params.tokenUsageEstimated === "boolean") {
    call.tokenUsageEstimated = params.tokenUsageEstimated;
  }

  step.llmCalls.push(call);
  trajectory.startTime = Math.min(trajectory.startTime, now);
  trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
  trajectory.updatedAt = new Date(now).toISOString();

  if (insights.length > 0) {
    const meta = (trajectory.metadata ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(meta.insights)
      ? (meta.insights as string[])
      : [];
    meta.insights = [...existing, ...insights].slice(-20);
    trajectory.metadata = meta;
  }

  if (
    !orchestratorCtx &&
    trajectory.source === "chat" &&
    shouldRunObservationExtraction(runtime)
  ) {
    pushChatExchange(runtime, {
      userPrompt: toText(params.userPrompt ?? params.input, ""),
      response: fullResponse,
      trajectoryId: trajectory.id,
      timestamp: now,
    });
  }

  if (orchestratorCtx) {
    trajectory.source = "orchestrator";
    const meta = (trajectory.metadata ?? {}) as Record<string, unknown>;
    meta.orchestrator = {
      decisionType: orchestratorCtx.decisionType,
      ...(orchestratorCtx.sessionId && {
        sessionId: orchestratorCtx.sessionId,
      }),
      ...(orchestratorCtx.taskLabel && {
        taskLabel: orchestratorCtx.taskLabel,
      }),
      ...(orchestratorCtx.repo && {
        repo: orchestratorCtx.repo,
      }),
      ...(orchestratorCtx.workdir && {
        workdir: orchestratorCtx.workdir,
      }),
      ...(orchestratorCtx.originalTask && {
        originalTask: orchestratorCtx.originalTask,
      }),
    };
    trajectory.metadata = meta;
  }

  await saveTrajectory(runtime, trajectory);
}

async function appendProviderAccess(
  runtime: IAgentRuntime,
  stepId: string,
  params: Record<string, unknown>,
): Promise<void> {
  const now = toNumber(params.timestamp, Date.now());
  const trajectory =
    (await loadTrajectoryById(runtime, stepId)) ??
    createBaseTrajectory(stepId, now);

  trajectory.source = trajectory.source || "runtime";
  trajectory.status =
    trajectory.status === "active" ? "active" : trajectory.status;

  const step = ensureStep(trajectory, stepId, now);
  const access: PersistedProviderAccess = {
    providerId: toText(
      params.providerId,
      `${stepId}-provider-${step.providerAccesses.length + 1}`,
    ),
    providerName: toText(params.providerName, "unknown"),
    timestamp: now,
    data: truncateRecord(asRecord(params.data) ?? {}),
    query: (() => {
      const queryRecord = asRecord(params.query);
      return queryRecord ? truncateRecord(queryRecord) : undefined;
    })(),
    purpose: toText(params.purpose, "provider"),
  };
  if (typeof params.runId === "string") {
    access.runId = params.runId;
  }
  if (typeof params.roomId === "string") {
    access.roomId = params.roomId;
  }
  if (typeof params.messageId === "string") {
    access.messageId = params.messageId;
  }
  if (typeof params.executionTraceId === "string") {
    access.executionTraceId = params.executionTraceId;
  }
  if (typeof params.createdAt === "string") {
    access.createdAt = params.createdAt;
  }

  step.providerAccesses.push(access);
  trajectory.startTime = Math.min(trajectory.startTime, now);
  trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
  trajectory.updatedAt = new Date(now).toISOString();

  await saveTrajectory(runtime, trajectory);
}

// ---------------------------------------------------------------------------
// Auto-train trigger notification
// ---------------------------------------------------------------------------

interface TrainingTriggerEntry {
  notifyTrajectoryCompleted: (trajectoryId: string) => Promise<void>;
}

/**
 * Fire-and-forget notification to the optional TrainingTriggerService.
 *
 * Registered by `@elizaos/app-core` when `@elizaos/app-training` is installed
 * (see `runtime/eliza.ts` → `registerTrackCTrainingCrons`). Slim installs
 * never register the service and this resolves to a no-op.
 *
 * Errors are logged at debug level only — auto-train counter increments
 * must never block or break trajectory persistence.
 */
function notifyTrainingTrigger(
  runtime: IAgentRuntime,
  trajectoryId: string,
): void {
  const entries = runtime.services.get("TRAINING_TRIGGER_SERVICE" as never);
  if (!Array.isArray(entries) || entries.length === 0) return;
  const entry: unknown = entries[0];
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof (entry as { notifyTrajectoryCompleted?: unknown })
      .notifyTrajectoryCompleted !== "function"
  ) {
    return;
  }
  const trigger = entry as TrainingTriggerEntry;
  void trigger.notifyTrajectoryCompleted(trajectoryId).catch((err: unknown) => {
    coreLogger.debug?.(
      `[trajectory-storage] training trigger notify failed for ${trajectoryId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// writeStartedTrajectoryStep / writeCompletedTrajectoryStep
// ---------------------------------------------------------------------------

async function writeStartedTrajectoryStep({
  runtime,
  stepId,
  source,
  metadata,
}: StartStepOptions): Promise<void> {
  const now = Date.now();
  const trajectory =
    (await loadTrajectoryById(runtime, stepId)) ??
    createBaseTrajectory(stepId, now, source, metadata);

  trajectory.source = source?.trim() || trajectory.source || "runtime";
  trajectory.status = "active";
  trajectory.metadata = mergeMetadata(trajectory.metadata, metadata);
  trajectory.startTime = Math.min(trajectory.startTime, now);
  trajectory.endTime = null;
  ensureStep(trajectory, stepId, now);
  trajectory.updatedAt = new Date(now).toISOString();

  await saveTrajectory(runtime, trajectory);
}

async function writeCompletedTrajectoryStep({
  runtime,
  stepId,
  status = "completed",
  source,
  metadata,
}: CompleteStepOptions): Promise<void> {
  const now = Date.now();
  const trajectory =
    (await loadTrajectoryById(runtime, stepId)) ??
    createBaseTrajectory(stepId, now, source, metadata);

  trajectory.source = source?.trim() || trajectory.source || "runtime";
  trajectory.status = normalizeStatus(status, "completed");
  trajectory.metadata = mergeMetadata(trajectory.metadata, metadata);
  trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
  trajectory.startTime = Math.min(trajectory.startTime, now);
  ensureStep(trajectory, stepId, now);
  trajectory.updatedAt = new Date(now).toISOString();

  await saveTrajectory(runtime, trajectory);
}

function buildTrajectoryWhereClauses(options: TrajectoryListOptions): string[] {
  const whereClauses: string[] = [];
  if (options.source) {
    whereClauses.push(`source = ${sqlQuote(options.source)}`);
  }
  if (options.status) {
    whereClauses.push(`status = ${sqlQuote(options.status)}`);
  }
  if (options.scenarioId) {
    whereClauses.push(`scenario_id = ${sqlQuote(options.scenarioId)}`);
  }
  if (options.batchId) {
    whereClauses.push(`batch_id = ${sqlQuote(options.batchId)}`);
  }
  if (options.startDate) {
    const startTime = new Date(options.startDate).getTime();
    if (Number.isFinite(startTime)) {
      whereClauses.push(`start_time >= ${startTime}`);
    }
  }
  if (options.endDate) {
    const endTime = new Date(options.endDate).getTime();
    if (Number.isFinite(endTime)) {
      whereClauses.push(`start_time <= ${endTime}`);
    }
  }
  if (options.search) {
    const searchPattern = `%${options.search
      .toLowerCase()
      .replace(/\\/g, "\\\\")
      .replace(/[%_]/g, "\\$&")}%`;
    const quotedPattern = sqlQuote(searchPattern);
    whereClauses.push(
      `(
        LOWER(COALESCE(id, '')) LIKE ${quotedPattern}
        OR LOWER(COALESCE(scenario_id, '')) LIKE ${quotedPattern}
        OR LOWER(COALESCE(batch_id, '')) LIKE ${quotedPattern}
        OR LOWER(COALESCE(CAST(metadata AS TEXT), '')) LIKE ${quotedPattern}
        OR LOWER(COALESCE(CAST(steps_json AS TEXT), '')) LIKE ${quotedPattern}
      )`,
    );
  }
  return whereClauses;
}

function buildTrajectoryWhereClause(options: TrajectoryListOptions): string {
  const whereClauses = buildTrajectoryWhereClauses(options);
  return whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
}

async function loadPersistedTrajectoriesForExport(
  runtime: IAgentRuntime,
  options: RuntimeTrajectoryExportOptions,
): Promise<PersistedTrajectory[]> {
  if (!hasRuntimeDb(runtime)) {
    return [];
  }

  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) {
    return [];
  }

  const whereClauses = buildTrajectoryWhereClauses({
    startDate: options.startDate,
    endDate: options.endDate,
    scenarioId: options.scenarioId,
    batchId: options.batchId,
  });
  if (options.trajectoryIds && options.trajectoryIds.length > 0) {
    const ids = options.trajectoryIds
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (ids.length > 0) {
      whereClauses.push(`id IN (${ids.map((id) => sqlQuote(id)).join(", ")})`);
    }
  }
  const whereClause =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  try {
    const result = await executeRawSql(
      runtime,
      `SELECT * FROM trajectories ${whereClause} ORDER BY created_at DESC LIMIT 10000`,
    );
    const rows = extractRows(result);
    return rows
      .map((row) => {
        const record = asRecord(row);
        if (!record) return null;
        return parsePersistedTrajectoryRow(
          record,
          toText(record.id ?? record.trajectory_id, ""),
        );
      })
      .filter((trajectory): trajectory is PersistedTrajectory =>
        Boolean(trajectory),
      );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public write API
// ---------------------------------------------------------------------------

export async function installDatabaseTrajectoryLogger(
  runtime: IAgentRuntime,
): Promise<void> {
  if (!hasRuntimeDb(runtime)) {
    console.warn(
      "[trajectory-persistence] installDatabaseTrajectoryLogger: no database adapter found on runtime",
    );
    return;
  }

  const logger = await resolveTrajectoryLogger(runtime);
  if (!logger) {
    console.warn(
      "[trajectory-persistence] installDatabaseTrajectoryLogger: no logger found to patch",
    );
    return;
  }

  const loggerObject = logger as object;
  if (patchedLoggers.has(loggerObject)) return;

  const shouldEnableByDefault = shouldEnableTrajectoryLoggingByDefault();
  const isEnabled =
    typeof logger.isEnabled === "function"
      ? logger.isEnabled()
      : shouldEnableByDefault;
  if (
    typeof logger.setEnabled === "function" &&
    isEnabled !== shouldEnableByDefault
  ) {
    try {
      logger.setEnabled(shouldEnableByDefault);
    } catch {
      // Ignore logger enable failures and continue.
    }
  }

  if (Array.isArray(logger.llmCalls)) {
    logger.llmCalls.splice(0, logger.llmCalls.length);
  }
  if (Array.isArray(logger.providerAccess)) {
    logger.providerAccess.splice(0, logger.providerAccess.length);
  }

  const llmLogger = logger.logLlmCall;
  const originalLogLlmCall =
    typeof llmLogger === "function"
      ? (...args: unknown[]) => Reflect.apply(llmLogger, logger, args)
      : null;
  const providerAccessLogger = logger.logProviderAccess;
  const originalLogProviderAccess =
    typeof providerAccessLogger === "function"
      ? (...args: unknown[]) =>
          Reflect.apply(providerAccessLogger, logger, args)
      : null;

  logger.logLlmCall = (...args: unknown[]) => {
    if (originalLogLlmCall) {
      try {
        originalLogLlmCall(...args);
      } catch (err) {
        warnRuntime(runtime, "Trajectory logger logLlmCall threw", err);
      }
    }

    const normalized = normalizeLlmCallPayload(args);
    if (!normalized) return;

    const writePromise = enqueueStepWrite(
      runtime,
      normalized.stepId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(runtime);
        if (!tableReady) return;
        await appendLlmCall(runtime, normalized.stepId, normalized.params);
      },
    );
    const runtimeKey = runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  };

  logger.logProviderAccess = (...args: unknown[]) => {
    if (originalLogProviderAccess) {
      try {
        originalLogProviderAccess(...args);
      } catch (err) {
        warnRuntime(runtime, "Trajectory logger logProviderAccess threw", err);
      }
    }

    const normalized = normalizeProviderAccessPayload(args);
    if (!normalized) return;

    const writePromise = enqueueStepWrite(
      runtime,
      normalized.stepId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(runtime);
        if (!tableReady) return;
        await appendProviderAccess(
          runtime,
          normalized.stepId,
          normalized.params,
        );
      },
    );
    const runtimeKey = runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  };

  logger.getLlmCallLogs = () => [];
  logger.getProviderAccessLogs = () => [];

  const loggerAny = logger as typeof logger & {
    startTrajectory?: (
      stepIdOrAgentId: string,
      options?: {
        agentId?: string;
        roomId?: string;
        entityId?: string;
        source?: string;
        metadata?: Record<string, unknown>;
        scenarioId?: string;
        batchId?: string;
      },
    ) => Promise<string>;
    startStep?: (trajectoryId: string) => string;
    endTrajectory?: (
      stepIdOrTrajectoryId: string,
      status?: string,
    ) => Promise<void>;
    listTrajectories?: (
      options?: TrajectoryListOptions,
    ) => Promise<TrajectoryListResult>;
    getTrajectoryDetail?: (trajectoryId: string) => Promise<Trajectory | null>;
    getStats?: () => Promise<unknown>;
  };

  loggerAny.startTrajectory = async (
    stepIdOrAgentId: string,
    options?: {
      agentId?: string;
      roomId?: string;
      entityId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
      scenarioId?: string;
      batchId?: string;
    },
  ): Promise<string> => {
    const isLegacySignature = typeof options?.agentId === "string";
    const stepId = isLegacySignature
      ? stepIdOrAgentId
      : `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startMetadata = normalizeTrajectoryMetadata(options?.metadata, {
      scenarioId: options?.scenarioId,
      batchId: options?.batchId,
    }).metadata;

    const writePromise = enqueueStepWrite(runtime, stepId, async () => {
      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return;

      await writeStartedTrajectoryStep({
        runtime,
        stepId,
        source: options?.source ?? "chat",
        metadata: startMetadata,
      });
    });

    const runtimeKey = runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);

    return stepId;
  };

  loggerAny.startStep = (trajectoryId: string): string => {
    return trajectoryId;
  };

  loggerAny.endTrajectory = async (
    stepIdOrTrajectoryId: string,
    status = "completed",
  ): Promise<void> => {
    const writePromise = enqueueStepWrite(
      runtime,
      stepIdOrTrajectoryId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(runtime);
        if (!tableReady) return;

        await writeCompletedTrajectoryStep({
          runtime,
          stepId: stepIdOrTrajectoryId,
          status: status as TrajectoryStatus,
        });

        // Notify the auto-train trigger service (registered by app-core when
        // app-training is installed). Optional — the chain is a no-op if the
        // service was never registered, which is the case for slim installs.
        if (status === "completed") {
          notifyTrainingTrigger(runtime, stepIdOrTrajectoryId);
        }
      },
    );

    const runtimeKey = runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  };

  // Add query methods for API endpoints
  loggerAny.listTrajectories = async (
    options: TrajectoryListOptions = {},
  ): Promise<TrajectoryListResult> => {
    if (!hasRuntimeDb(runtime)) {
      return { trajectories: [], total: 0, offset: 0, limit: 50 };
    }

    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady) {
      return { trajectories: [], total: 0, offset: 0, limit: 50 };
    }

    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);

    const whereClause = buildTrajectoryWhereClause(options);

    try {
      const countResult = await executeRawSql(
        runtime,
        `SELECT count(*) AS total FROM trajectories ${whereClause}`,
      );
      const countRow = asRecord(extractRows(countResult)[0]);
      const total = toNumber(countRow?.total, 0);

      const result = await executeRawSql(
        runtime,
        `SELECT * FROM trajectories ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      );

      const rows = extractRows(result);
      const trajectories = rows
        .map((row) => trajectoryRowToListItem(row, runtime.agentId))
        .filter(Boolean) as TrajectoryListItem[];

      return { trajectories, total, offset, limit };
    } catch (err) {
      console.error("[trajectory-persistence] listTrajectories error:", err);
      return { trajectories: [], total: 0, offset, limit };
    }
  };

  loggerAny.getTrajectoryDetail = async (
    trajectoryId: string,
  ): Promise<Trajectory | null> => {
    if (!hasRuntimeDb(runtime)) return null;

    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady) return null;

    const persisted = await loadTrajectoryById(runtime, trajectoryId);
    if (!persisted) return null;

    return persistedTrajectoryToDetailRecord(persisted, runtime.agentId);
  };

  loggerAny.getStats = async (): Promise<unknown> => {
    const emptyStats = {
      totalTrajectories: 0,
      totalLlmCalls: 0,
      totalProviderAccesses: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      averageDurationMs: 0,
      bySource: {},
      byModel: {},
    };

    if (!hasRuntimeDb(runtime)) return emptyStats;

    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady) return emptyStats;

    try {
      const aggResult = await executeRawSql(
        runtime,
        `SELECT
          count(*) AS total,
          COALESCE(sum(llm_call_count), 0) AS total_llm_calls,
          COALESCE(sum(provider_access_count), 0) AS total_provider_accesses,
          COALESCE(sum(total_prompt_tokens), 0) AS total_prompt_tokens,
          COALESCE(sum(total_completion_tokens), 0) AS total_completion_tokens,
          COALESCE(avg(duration_ms), 0) AS avg_duration_ms
        FROM trajectories`,
      );
      const row = asRecord(extractRows(aggResult)[0]);

      const bySource = await computeBySource(runtime);

      return {
        totalTrajectories: toNumber(row?.total, 0),
        totalLlmCalls: toNumber(row?.total_llm_calls, 0),
        totalProviderAccesses: toNumber(row?.total_provider_accesses, 0),
        totalPromptTokens: toNumber(row?.total_prompt_tokens, 0),
        totalCompletionTokens: toNumber(row?.total_completion_tokens, 0),
        averageDurationMs: toNumber(row?.avg_duration_ms, 0),
        bySource,
        byModel: {},
      };
    } catch {
      return emptyStats;
    }
  };

  // Add methods required by the trajectory-routes duck-type check
  const loggerForRoutes = logger as typeof logger & {
    isEnabled?: () => boolean;
    setEnabled?: (enabled: boolean) => void;
    deleteTrajectories?: (trajectoryIds: string[]) => Promise<number>;
    clearAllTrajectories?: () => Promise<number>;
    exportTrajectories?: (
      options: RuntimeTrajectoryExportOptions,
    ) => Promise<TrajectoryExportResult>;
  };

  let _enabled = shouldEnableByDefault;

  if (typeof loggerForRoutes.isEnabled !== "function") {
    loggerForRoutes.isEnabled = () => _enabled;
  }
  if (typeof loggerForRoutes.setEnabled !== "function") {
    loggerForRoutes.setEnabled = (enabled: boolean) => {
      _enabled = enabled;
    };
  }

  if (typeof loggerForRoutes.deleteTrajectories !== "function") {
    loggerForRoutes.deleteTrajectories = async (
      trajectoryIds: string[],
    ): Promise<number> => {
      if (!hasRuntimeDb(runtime) || trajectoryIds.length === 0) return 0;
      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return 0;

      const ids = trajectoryIds.map((id) => sqlQuote(id)).join(", ");
      try {
        await executeRawSql(
          runtime,
          `DELETE FROM trajectories WHERE id IN (${ids})`,
        );
        return trajectoryIds.length;
      } catch {
        return 0;
      }
    };
  }

  if (typeof loggerForRoutes.clearAllTrajectories !== "function") {
    loggerForRoutes.clearAllTrajectories = async (): Promise<number> => {
      if (!hasRuntimeDb(runtime)) return 0;
      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return 0;

      try {
        const countResult = await executeRawSql(
          runtime,
          "SELECT count(*) AS total FROM trajectories",
        );
        const countRow = asRecord(extractRows(countResult)[0]);
        const total = toNumber(countRow?.total, 0);
        await executeRawSql(runtime, "DELETE FROM trajectories");
        return total;
      } catch {
        return 0;
      }
    };
  }

  if (typeof loggerForRoutes.exportTrajectories !== "function") {
    loggerForRoutes.exportTrajectories = async (
      options: RuntimeTrajectoryExportOptions,
    ): Promise<TrajectoryExportResult> => {
      const persistedTrajectories = await loadPersistedTrajectoriesForExport(
        runtime,
        options,
      );
      return exportPersistedTrajectories({
        agentId: runtime.agentId,
        persistedTrajectories,
        options,
      });
    };
  }

  patchedLoggers.add(loggerObject);

  void ensureTrajectoriesTable(runtime).catch((err) => {
    coreLogger.warn(`[trajectory] Trajectories table init failed: ${err}`);
  });
}

export async function startTrajectoryStepInDatabase({
  runtime,
  stepId,
  source,
  metadata,
}: StartStepOptions): Promise<boolean> {
  if (!hasRuntimeDb(runtime)) return false;
  const normalizedStepId = normalizeStepId(stepId);
  if (!normalizedStepId) return false;

  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return false;

  await enqueueStepWrite(runtime, normalizedStepId, async () => {
    await writeStartedTrajectoryStep({
      runtime,
      stepId: normalizedStepId,
      source,
      metadata,
    });
  });

  return true;
}

/**
 * Annotate an existing trajectory step with structural metadata (kind
 * discriminator, script, child step IDs, used skills). Safe to call for any
 * of the new trajectory step fields; passing `undefined` for a field leaves
 * the existing value alone, while passing an explicit value overwrites.
 */
export async function annotateTrajectoryStep({
  runtime,
  stepId,
  kind,
  script,
  childSteps,
  appendChildSteps,
  usedSkills,
}: {
  runtime: IAgentRuntime;
  stepId: string;
  kind?: TrajectoryStepKind;
  script?: string;
  /** Replace child steps wholesale. */
  childSteps?: string[];
  /** Append the given child step IDs (deduped, order preserved). */
  appendChildSteps?: string[];
  usedSkills?: string[];
}): Promise<boolean> {
  if (!hasRuntimeDb(runtime)) return false;
  const normalizedStepId = normalizeStepId(stepId);
  if (!normalizedStepId) return false;

  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return false;

  await enqueueStepWrite(runtime, normalizedStepId, async () => {
    const now = Date.now();
    const trajectory =
      (await loadTrajectoryById(runtime, normalizedStepId)) ??
      createBaseTrajectory(normalizedStepId, now);
    const step = ensureStep(trajectory, normalizedStepId, now);

    if (kind !== undefined) {
      step.kind = kind;
    }
    if (script !== undefined) {
      const capped = capScriptForPersistence(script);
      step.script = capped.script;
      if (capped.scriptHash !== undefined) {
        step.scriptHash = capped.scriptHash;
      } else {
        step.scriptHash = undefined;
      }
    }
    if (childSteps !== undefined) {
      step.childSteps = [...childSteps];
    }
    if (appendChildSteps && appendChildSteps.length > 0) {
      const seen = new Set<string>(step.childSteps ?? []);
      const merged = step.childSteps ? [...step.childSteps] : [];
      for (const child of appendChildSteps) {
        const trimmed = typeof child === "string" ? child.trim() : "";
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        merged.push(trimmed);
      }
      step.childSteps = merged;
    }
    if (usedSkills !== undefined) {
      step.usedSkills = [...usedSkills];
    }

    trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
    trajectory.updatedAt = new Date(now).toISOString();
    await saveTrajectory(runtime, trajectory);
  });

  return true;
}

export async function completeTrajectoryStepInDatabase({
  runtime,
  stepId,
  status = "completed",
  source,
  metadata,
}: CompleteStepOptions): Promise<boolean> {
  if (!hasRuntimeDb(runtime)) return false;
  const normalizedStepId = normalizeStepId(stepId);
  if (!normalizedStepId) return false;

  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return false;

  await enqueueStepWrite(runtime, normalizedStepId, async () => {
    await writeCompletedTrajectoryStep({
      runtime,
      stepId: normalizedStepId,
      status,
      source,
      metadata,
    });
  });

  return true;
}

export async function deletePersistedTrajectoryRows(
  runtime: IAgentRuntime,
  trajectoryIds: string[],
): Promise<number | null> {
  if (!hasRuntimeDb(runtime)) return null;
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return 0;

  const normalized = trajectoryIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (normalized.length === 0) return 0;

  const values = normalized.map((id) => sqlQuote(id)).join(", ");
  try {
    const result = await executeRawSql(
      runtime,
      `DELETE FROM trajectories WHERE id IN (${values}) RETURNING id`,
    );
    return extractRows(result).length;
  } catch {
    try {
      await executeRawSql(
        runtime,
        `DELETE FROM trajectories WHERE id IN (${values})`,
      );
      return normalized.length;
    } catch {
      return null;
    }
  }
}

export async function clearPersistedTrajectoryRows(
  runtime: IAgentRuntime,
): Promise<number | null> {
  if (!hasRuntimeDb(runtime)) return null;
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return 0;

  try {
    const countResult = await executeRawSql(
      runtime,
      "SELECT count(*) AS total FROM trajectories",
    );
    const countRow = asRecord(extractRows(countResult)[0]);
    const total = toNumber(countRow?.total, 0);
    await executeRawSql(runtime, "DELETE FROM trajectories");
    return total;
  } catch {
    return null;
  }
}

/**
 * Wait for all pending trajectory writes to complete.
 * Useful for tests to ensure writes are flushed before assertions.
 */
export async function flushTrajectoryWrites(
  runtime: IAgentRuntime,
): Promise<void> {
  const runtimeKey = runtime as object;
  const perStep = stepWriteQueues.get(runtimeKey);
  if (perStep) {
    const pending = Array.from(perStep.values());
    if (pending.length > 0) {
      await Promise.all(pending);
    }
  }
  const lastWrite = lastWritePromises.get(runtimeKey);
  if (lastWrite) {
    await lastWrite;
  }
}

// ============================================================================
// DatabaseTrajectoryLogger - Full implementation for trajectory-routes.ts
// ============================================================================

/**
 * Database-backed trajectory logger service that implements the full API
 * expected by trajectory-routes.ts.
 */
export class DatabaseTrajectoryLogger extends Service {
  static serviceType = "trajectories";
  capabilityDescription =
    "Database-backed trajectory logging service for LLM call persistence";

  private enabled = shouldEnableTrajectoryLoggingByDefault();

  /**
   * Static start method required by @elizaos/core runtime.
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new DatabaseTrajectoryLogger(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    if (hasRuntimeDb(this.runtime)) {
      await ensureTrajectoriesTable(this.runtime);
      // Fire-and-forget TTL pruning on startup
      pruneOldTrajectories(this.runtime, 30)
        .then((count) => {
          if (count && count > 0) {
            console.warn(
              `[trajectory-persistence] Pruned ${count} trajectories older than 30 days`,
            );
          }
        })
        .catch(() => {
          /* non-critical */
        });
    }
  }

  async stop(): Promise<void> {
    await flushTrajectoryWrites(this.runtime);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async startTrajectory(
    stepIdOrAgentId: string,
    options?: {
      agentId?: string;
      roomId?: string;
      entityId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<string> {
    if (!this.enabled) return stepIdOrAgentId;

    const isLegacySignature = typeof options?.agentId === "string";
    const stepId = isLegacySignature
      ? stepIdOrAgentId
      : `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const writePromise = enqueueStepWrite(this.runtime, stepId, async () => {
      const tableReady = await ensureTrajectoriesTable(this.runtime);
      if (!tableReady) return;

      await writeStartedTrajectoryStep({
        runtime: this.runtime,
        stepId,
        source: options?.source ?? "chat",
        metadata: options?.metadata,
      });
    });

    const runtimeKey = this.runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);

    return stepId;
  }

  startStep(trajectoryId: string): string {
    return trajectoryId;
  }

  async annotateStep(params: {
    stepId: string;
    kind?: TrajectoryStepKind;
    script?: string;
    childSteps?: string[];
    appendChildSteps?: string[];
    usedSkills?: string[];
  }): Promise<void> {
    if (!this.enabled) return;
    await annotateTrajectoryStep({
      runtime: this.runtime,
      ...params,
    });
  }

  async endTrajectory(
    stepIdOrTrajectoryId: string,
    status: TrajectoryStatus = "completed",
  ): Promise<void> {
    if (!this.enabled) return;

    const writePromise = enqueueStepWrite(
      this.runtime,
      stepIdOrTrajectoryId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(this.runtime);
        if (!tableReady) return;

        await writeCompletedTrajectoryStep({
          runtime: this.runtime,
          stepId: stepIdOrTrajectoryId,
          status,
        });
      },
    );

    const runtimeKey = this.runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }

  logLlmCall(params: Record<string, unknown>): void {
    if (!this.enabled) return;
    const normalized = normalizeLlmCallPayload([params]);
    if (!normalized) return;

    const writePromise = enqueueStepWrite(
      this.runtime,
      normalized.stepId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(this.runtime);
        if (!tableReady) return;
        await appendLlmCall(this.runtime, normalized.stepId, normalized.params);
      },
    );
    const runtimeKey = this.runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }

  logProviderAccess(params: Record<string, unknown>): void {
    if (!this.enabled) return;
    const normalized = normalizeProviderAccessPayload([params]);
    if (!normalized) return;

    const writePromise = enqueueStepWrite(
      this.runtime,
      normalized.stepId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(this.runtime);
        if (!tableReady) return;
        await appendProviderAccess(
          this.runtime,
          normalized.stepId,
          normalized.params,
        );
      },
    );
    const runtimeKey = this.runtime as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }

  getLlmCallLogs(): readonly unknown[] {
    return [];
  }

  getProviderAccessLogs(): readonly unknown[] {
    return [];
  }

  async listTrajectories(
    options: TrajectoryListOptions,
  ): Promise<TrajectoryListResult> {
    if (!hasRuntimeDb(this.runtime)) {
      return { trajectories: [], total: 0, offset: 0, limit: 50 };
    }

    const tableReady = await ensureTrajectoriesTable(this.runtime);
    if (!tableReady) {
      return { trajectories: [], total: 0, offset: 0, limit: 50 };
    }

    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);

    const whereClause = buildTrajectoryWhereClause(options);

    try {
      const countResult = await executeRawSql(
        this.runtime,
        `SELECT count(*) AS total FROM trajectories ${whereClause}`,
      );
      const countRow = asRecord(extractRows(countResult)[0]);
      const total = toNumber(countRow?.total, 0);

      const result = await executeRawSql(
        this.runtime,
        `SELECT * FROM trajectories ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      );

      const rows = extractRows(result);
      const trajectories = rows
        .map((row) => trajectoryRowToListItem(row, this.runtime.agentId))
        .filter(Boolean) as TrajectoryListItem[];

      return { trajectories, total, offset, limit };
    } catch (err) {
      console.error("[DatabaseTrajectoryLogger] listTrajectories error:", err);
      return { trajectories: [], total: 0, offset, limit };
    }
  }

  async getTrajectoryDetail(trajectoryId: string): Promise<Trajectory | null> {
    if (!hasRuntimeDb(this.runtime)) return null;

    const tableReady = await ensureTrajectoriesTable(this.runtime);
    if (!tableReady) return null;

    const persisted = await loadTrajectoryById(this.runtime, trajectoryId);
    if (!persisted) return null;

    return persistedTrajectoryToDetailRecord(persisted, this.runtime.agentId);
  }

  async getStats(): Promise<unknown> {
    if (!hasRuntimeDb(this.runtime)) {
      return { total: 0, byStatus: {}, bySource: {} };
    }

    const tableReady = await ensureTrajectoriesTable(this.runtime);
    if (!tableReady) {
      return { total: 0, byStatus: {}, bySource: {} };
    }

    try {
      const countResult = await executeRawSql(
        this.runtime,
        "SELECT count(*) AS total FROM trajectories",
      );
      const countRow = asRecord(extractRows(countResult)[0]);
      const total = toNumber(countRow?.total, 0);

      const bySource = await computeBySource(this.runtime);

      return {
        total,
        enabled: this.enabled,
        byStatus: {},
        bySource,
      };
    } catch {
      return { total: 0, byStatus: {}, bySource: {} };
    }
  }

  async deleteTrajectories(trajectoryIds: string[]): Promise<number> {
    const result = await deletePersistedTrajectoryRows(
      this.runtime,
      trajectoryIds,
    );
    return result ?? 0;
  }

  async clearAllTrajectories(): Promise<number> {
    const result = await clearPersistedTrajectoryRows(this.runtime);
    return result ?? 0;
  }

  async exportTrajectories(
    options: RuntimeTrajectoryExportOptions,
  ): Promise<TrajectoryExportResult> {
    const persistedTrajectories = await loadPersistedTrajectoriesForExport(
      this.runtime,
      options,
    );
    return exportPersistedTrajectories({
      agentId: this.runtime.agentId,
      persistedTrajectories,
      options,
    });
  }
}

/**
 * Create and register a database-backed trajectory logger service on the runtime.
 */
export function createDatabaseTrajectoryLogger(
  runtime: IAgentRuntime,
): DatabaseTrajectoryLogger {
  const logger = new DatabaseTrajectoryLogger(runtime);
  return logger;
}

// ---------------------------------------------------------------------------
// Archive / prune
// ---------------------------------------------------------------------------

async function exportRawTrajectoriesToCompressedArchive(
  runtime: IAgentRuntime,
  cutoff: string,
  archivedAt: string,
): Promise<{ archivePath: string; rowCount: number }> {
  const rawRowsResult = await executeRawSql(
    runtime,
    `SELECT
      id, id AS trajectory_id, agent_id, source, status, start_time, end_time,
      duration_ms, step_count, llm_call_count, provider_access_count,
      total_prompt_tokens, total_completion_tokens, total_reward, scenario_id,
      batch_id, steps_json,
      metadata, created_at, updated_at, episode_length, ai_judge_reward,
      ai_judge_reasoning, archetype
    FROM trajectories
    WHERE created_at < ${sqlQuote(cutoff)}`,
  );
  const rawRows = extractRows(rawRowsResult)
    .map((row) => asRecord(row))
    .filter(Boolean) as Record<string, unknown>[];

  if (rawRows.length === 0) {
    return { archivePath: "", rowCount: 0 };
  }

  const archiveDir = await resolveTrajectoryArchiveDirectory();
  const archiveName = `trajectories-before-${toArchiveSafeTimestamp(cutoff)}-archived-${toArchiveSafeTimestamp(archivedAt)}.jsonl.gz`;
  const archivePath = path.join(archiveDir, archiveName);
  await writeCompressedJsonlRows(archivePath, rawRows);

  return { archivePath, rowCount: rawRows.length };
}

/**
 * Archive and then delete trajectories older than `maxAgeDays`.
 */
export async function pruneOldTrajectories(
  runtime: IAgentRuntime,
  maxAgeDays = 30,
): Promise<number | null> {
  if (!hasRuntimeDb(runtime)) return null;
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return 0;

  const cutoff = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const archivedAt = new Date().toISOString();

  try {
    // Step 1: Persist full training rows to compressed local archive.
    let archivePath = "";
    try {
      const archived = await exportRawTrajectoriesToCompressedArchive(
        runtime,
        cutoff,
        archivedAt,
      );
      archivePath = archived.archivePath;
      if (archived.rowCount > 0 && !archivePath) {
        return 0;
      }
    } catch (err) {
      console.warn(
        "[trajectory-persistence] Could not write compressed trajectory archive, skipping prune",
        err,
      );
      return null;
    }

    // Step 2: Copy summary rows to archive table (idempotent).
    let summaryArchived = false;
    try {
      await executeRawSql(
        runtime,
        `INSERT OR IGNORE INTO trajectory_archive (
          id, agent_id, source, status, start_time, end_time, duration_ms,
          step_count, llm_call_count, provider_access_count,
          total_prompt_tokens, total_completion_tokens, total_reward,
          scenario_id, batch_id, metadata, observations, archive_blob_path,
          created_at, updated_at, archived_at
        )
        SELECT
          id, agent_id, source, status, start_time, end_time, duration_ms,
          step_count, llm_call_count, provider_access_count,
          total_prompt_tokens, total_completion_tokens, total_reward,
          scenario_id, batch_id, metadata,
          COALESCE(json_extract(metadata, '$.observations'), '[]'),
          ${sqlQuote(archivePath)},
          created_at, updated_at,
          ${sqlQuote(archivedAt)}
        FROM trajectories
        WHERE created_at < ${sqlQuote(cutoff)}`,
      );
      summaryArchived = true;
    } catch {
      // PostgreSQL uses ON CONFLICT DO NOTHING instead of INSERT OR IGNORE
      try {
        await executeRawSql(
          runtime,
          `INSERT INTO trajectory_archive (
            id, agent_id, source, status, start_time, end_time, duration_ms,
            step_count, llm_call_count, provider_access_count,
            total_prompt_tokens, total_completion_tokens, total_reward,
            scenario_id, batch_id, metadata, observations, archive_blob_path,
            created_at, updated_at, archived_at
          )
          SELECT
            id, agent_id, source, status, start_time, end_time, duration_ms,
            step_count, llm_call_count, provider_access_count,
            total_prompt_tokens, total_completion_tokens, total_reward,
            scenario_id, batch_id, metadata,
            COALESCE(metadata::json->>'observations', '[]'),
            ${sqlQuote(archivePath)},
            created_at, updated_at,
            ${sqlQuote(archivedAt)}
          FROM trajectories
          WHERE created_at < ${sqlQuote(cutoff)}
          ON CONFLICT (id) DO NOTHING`,
        );
        summaryArchived = true;
      } catch {
        console.warn(
          "[trajectory-persistence] Could not write summary trajectory archive rows",
        );
      }
    }

    if (!summaryArchived) {
      console.warn(
        "[trajectory-persistence] Summary archive insert failed, skipping prune delete",
      );
      return null;
    }

    // Step 3: Delete the archived rows from the main table.
    const countResult = await executeRawSql(
      runtime,
      `SELECT count(*) AS total FROM trajectories WHERE created_at < ${sqlQuote(cutoff)}`,
    );
    const countRow = asRecord(extractRows(countResult)[0]);
    const count = toNumber(countRow?.total, 0);
    if (count > 0) {
      await executeRawSql(
        runtime,
        `DELETE FROM trajectories WHERE created_at < ${sqlQuote(cutoff)}`,
      );
    }
    return count;
  } catch {
    return null;
  }
}
