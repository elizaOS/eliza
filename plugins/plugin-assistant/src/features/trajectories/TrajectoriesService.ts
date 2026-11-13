/**
 * The single owner of trajectory persistence. Captures, lifecycle writes,
 * reads, rewards and exports all go through the row store in ./store, which
 * keeps one `trajectories` row per run and one `trajectory_steps` row per step.
 * Write settlement, late-capture admission and shutdown ownership live there.
 */
import { randomUUID } from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  type JsonValue,
  logger,
  resolveTrajectoryGate,
  Service,
  type TrajectoryDetailRecord,
  type TrajectoryExportOptions,
  type TrajectoryExportResult,
  type TrajectoryListOptions,
  type TrajectoryListResult,
  type TrajectoryStatus,
} from "@elizaos/core";
import { exportPersistedTrajectories } from "./store/trajectory-export.ts";
import {
  enqueueStepWrite,
  ensureTrajectoriesTable,
  hasRuntimeDb,
  lastWritePromises,
  normalizeLlmCallPayload,
  normalizeProviderAccessPayload,
  normalizeTrajectoryMetadata,
  warnRuntime,
} from "./store/trajectory-internals.ts";
import {
  acceptsNewTrajectoryCapture,
  acceptsTrajectoryStepCapture,
  activeTrajectoryStepId,
  appendLlmCall,
  appendSemanticStage,
  applyDatabaseTrajectoryReward,
  type BridgeStepState,
  clearPersistedTrajectoryRows,
  completeTrajectoryAction,
  type DatabaseTrajectoryStatistics,
  deletePersistedTrajectoryRows,
  enqueueLlmCallPatch,
  enqueueProviderAccess,
  flushTrajectoryWrites,
  getDatabaseTrajectoryDetail,
  listDatabaseTrajectories,
  loadPersistedTrajectoriesForExport,
  normalizeSemanticStagePayload,
  readDatabaseTrajectoryStatistics,
  releaseAllTrajectoryBridgeState,
  releaseTrajectoryBridgeState,
  rememberTrajectoryStep,
  reportInvalidTrajectoryCapture,
  resolveBridgeTrajectoryId,
  startChildTrajectoryStep,
  stopTrajectoryBridge,
  type TrajectoryRewardRequest,
  terminalizeBridgeTrajectory,
  writeStartedTrajectoryStep,
} from "./store/trajectory-storage.ts";

export type TrajectoryStats = Omit<DatabaseTrajectoryStatistics, "byStatus">;

export interface TrajectoryZipExportOptions {
  includePrompts?: boolean;
  trajectoryIds?: string[];
  source?: string;
  status?: TrajectoryStatus;
  runId?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  scenarioId?: string;
  /** Correlation join key (#13775): all trajectories in one root turn's trace. */
  traceId?: string;
  batchId?: string;
}

export interface TrajectoryZipEntry {
  name: string;
  data: string;
}

export interface TrajectoryZipExportResult {
  filename: string;
  entries: TrajectoryZipEntry[];
}

type StartTrajectoryOptions = {
  agentId?: string;
  roomId?: string;
  entityId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  scenarioId?: string;
  /** Correlation join key (#13775), read from the trajectory context. */
  traceId?: string;
  episodeId?: string;
  batchId?: string;
  groupIndex?: number;
};

function sanitizeZipFolderName(value: string): string {
  const trimmed = value.trim();
  const safe = trimmed.length > 256 ? trimmed.slice(0, 256) : trimmed;
  const sanitized = safe
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "trajectory";
}

function redactTrajectoryPrompts(
  trajectory: TrajectoryDetailRecord,
): TrajectoryDetailRecord {
  return {
    ...trajectory,
    steps: trajectory.steps?.map((step) => ({
      ...step,
      llmCalls: step.llmCalls?.map((call) => ({
        ...call,
        systemPrompt: "[redacted]",
        userPrompt: "[redacted]",
        response: "[redacted]",
      })),
    })),
  };
}

function buildZipSummary(trajectory: TrajectoryDetailRecord) {
  const status: "active" | "completed" | "error" =
    trajectory.status === "active"
      ? "active"
      : trajectory.status === "completed"
        ? "completed"
        : "error";
  let llmCallCount = 0;
  let providerAccessCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  for (const step of trajectory.steps ?? []) {
    providerAccessCount += step.providerAccesses?.length ?? 0;
    llmCallCount += step.llmCalls?.length ?? 0;
    for (const call of step.llmCalls ?? []) {
      totalPromptTokens += call.promptTokens ?? 0;
      totalCompletionTokens += call.completionTokens ?? 0;
      totalCacheReadInputTokens += call.cacheReadInputTokens ?? 0;
      totalCacheCreationInputTokens += call.cacheCreationInputTokens ?? 0;
    }
  }
  const metadata = (trajectory.metadata ?? {}) as Record<
    string,
    JsonValue | undefined
  >;
  const asNullableString = (value: JsonValue | undefined): string | null =>
    typeof value === "string" ? value : null;
  const endTime = trajectory.endTime ?? null;
  return {
    id: trajectory.trajectoryId,
    agentId: trajectory.agentId,
    roomId: asNullableString(metadata.roomId),
    entityId: asNullableString(metadata.entityId),
    conversationId: asNullableString(metadata.conversationId),
    source: trajectory.source ?? "chat",
    status,
    startTime: trajectory.startTime,
    endTime,
    durationMs: trajectory.durationMs ?? null,
    llmCallCount,
    providerAccessCount,
    totalPromptTokens,
    totalCompletionTokens,
    totalCacheReadInputTokens,
    totalCacheCreationInputTokens,
    metadata,
    createdAt: new Date(trajectory.startTime).toISOString(),
    updatedAt: new Date(endTime ?? trajectory.startTime).toISOString(),
  };
}

export class TrajectoriesService extends Service {
  static serviceType = "trajectories" as const;
  static override readonly allowsMultiple = true;
  get serviceType() {
    return TrajectoriesService.serviceType;
  }

  capabilityDescription =
    "Captures and persists LLM calls, provider accesses, and full trajectories for debugging, analysis, and RL training";

  /**
   * Returns the registered TrajectoriesService, or null before it starts.
   * Another service may share the "trajectories" type, so every registration
   * of that type is scanned.
   */
  static resolveFromRuntime(
    runtime: IAgentRuntime,
  ): TrajectoriesService | null {
    const first = runtime.getService(TrajectoriesService.serviceType);
    if (first instanceof TrajectoriesService) return first;
    for (const svc of runtime.getServicesByType(
      TrajectoriesService.serviceType,
    )) {
      if (svc instanceof TrajectoriesService) return svc;
    }
    return null;
  }

  private enabled = resolveTrajectoryGate().enabled;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    // Core and hosts hold these as detached callbacks; prompt optimization
    // wraps the instance's logLlmCall in place.
    this.logLlmCall = this.logLlmCall.bind(this);
    this.logProviderAccess = this.logProviderAccess.bind(this);
    this.logSemanticStage = this.logSemanticStage.bind(this);
    this.updateLlmCall = this.updateLlmCall.bind(this);
    this.startTrajectory = this.startTrajectory.bind(this);
    this.startStep = this.startStep.bind(this);
    this.getCurrentStepId = this.getCurrentStepId.bind(this);
    this.completeStep = this.completeStep.bind(this);
    this.flushWriteQueue = this.flushWriteQueue.bind(this);
    this.endTrajectory = this.endTrajectory.bind(this);
    this.isEnabled = this.isEnabled.bind(this);
    this.listTrajectories = this.listTrajectories.bind(this);
    this.getTrajectoryDetail = this.getTrajectoryDetail.bind(this);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new TrajectoriesService(runtime);
    if (!hasRuntimeDb(runtime)) {
      logger.warn(
        "[trajectory-persistence] No SQL database adapter; trajectory capture is unavailable",
      );
      return service;
    }
    // Persistence that is off by policy runs no table DDL at boot. A read, or
    // a capture after setEnabled(true), creates the tables on first use.
    if (service.enabled) await ensureTrajectoriesTable(runtime);
    return service;
  }

  /** Policy and a SQL adapter allow persistence; stop still drains accepted writes. */
  private persistenceEnabled(): boolean {
    return this.enabled && hasRuntimeDb(this.runtime);
  }

  async stop(): Promise<void> {
    try {
      await stopTrajectoryBridge(this.runtime);
    } finally {
      releaseAllTrajectoryBridgeState(this.runtime);
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) releaseAllTrajectoryBridgeState(this.runtime);
  }

  /** New capture is admitted: policy enables it, SQL can persist it, and stop has not begun. */
  isEnabled(): boolean {
    return acceptsNewTrajectoryCapture(this.runtime, this.persistenceEnabled());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Capture (called by @elizaos/core)
  // ─────────────────────────────────────────────────────────────────────────

  logLlmCall(...args: unknown[]): void {
    if (!this.isEnabled()) return;
    let normalized: ReturnType<typeof normalizeLlmCallPayload>;
    try {
      normalized = normalizeLlmCallPayload(args);
    } catch (error) {
      // error-policy:J7 malformed instrumentation cannot fail the agent loop.
      reportInvalidTrajectoryCapture(this.runtime, "llm", error);
      return;
    }
    if (!normalized) return;
    if (
      !acceptsTrajectoryStepCapture(
        this.runtime,
        this.persistenceEnabled(),
        normalized.stepId,
        "llm",
        typeof normalized.params.purpose === "string"
          ? normalized.params.purpose
          : undefined,
      )
    )
      return;
    const { stepId, params } = normalized;
    const trajectoryId = resolveBridgeTrajectoryId(this.runtime, stepId);
    const writePromise = enqueueStepWrite(
      this.runtime,
      trajectoryId,
      async () => {
        if (!this.persistenceEnabled()) return;
        if (!(await ensureTrajectoriesTable(this.runtime))) return;
        await appendLlmCall(this.runtime, trajectoryId, stepId, params);
      },
    );
    lastWritePromises.set(this.runtime as object, writePromise);
  }

  /** Split-argument form used by manual action instrumentation. */
  logLLMCall(stepId: string, details: Record<string, unknown>): void {
    this.logLlmCall(stepId, details);
  }

  updateLlmCall(
    stepId: string,
    callId: string,
    patch: Record<string, unknown>,
  ): void {
    enqueueLlmCallPatch(this.runtime, stepId, callId, patch, () =>
      this.persistenceEnabled(),
    );
  }

  logProviderAccess(...args: unknown[]): void {
    if (!this.isEnabled()) return;
    let normalized: ReturnType<typeof normalizeProviderAccessPayload>;
    try {
      normalized = normalizeProviderAccessPayload(args);
    } catch (error) {
      // error-policy:J7 malformed instrumentation cannot fail the agent loop.
      reportInvalidTrajectoryCapture(this.runtime, "provider", error);
      return;
    }
    if (!normalized) return;
    if (
      !acceptsTrajectoryStepCapture(
        this.runtime,
        this.persistenceEnabled(),
        normalized.stepId,
        "provider",
      )
    )
      return;
    const trajectoryId = resolveBridgeTrajectoryId(
      this.runtime,
      normalized.stepId,
    );
    const writePromise = enqueueProviderAccess(
      this.runtime,
      this,
      trajectoryId,
      normalized.stepId,
      normalized.params,
      () => this.persistenceEnabled(),
    );
    lastWritePromises.set(this.runtime as object, writePromise);
  }

  logProviderAccessByTrajectoryId(
    trajectoryId: string,
    access: Record<string, unknown>,
  ): void {
    const stepId = this.getCurrentStepId(trajectoryId);
    if (!stepId) {
      logger.debug(
        { trajectoryId },
        "[trajectory-persistence] No active step for provider access by trajectory",
      );
      return;
    }
    this.logProviderAccess(stepId, access);
  }

  logSemanticStage(...args: unknown[]): void {
    if (!this.isEnabled()) return;
    let normalized: ReturnType<typeof normalizeSemanticStagePayload>;
    try {
      normalized = normalizeSemanticStagePayload(args);
    } catch (error) {
      // error-policy:J7 malformed instrumentation cannot fail the agent loop.
      reportInvalidTrajectoryCapture(this.runtime, "semanticStage", error);
      return;
    }
    if (!normalized) return;
    if (
      !acceptsTrajectoryStepCapture(
        this.runtime,
        this.persistenceEnabled(),
        normalized.stepId,
        "semanticStage",
      )
    )
      return;
    const { stepId, semantic } = normalized;
    const trajectoryId = resolveBridgeTrajectoryId(this.runtime, stepId);
    const writePromise = enqueueStepWrite(
      this.runtime,
      trajectoryId,
      async () => {
        if (!this.persistenceEnabled()) return;
        if (!(await ensureTrajectoriesTable(this.runtime))) return;
        await appendSemanticStage(this.runtime, trajectoryId, stepId, semantic);
      },
    );
    lastWritePromises.set(this.runtime as object, writePromise);
  }

  /** In-memory capture buffers do not exist; every capture is persisted. */
  getLlmCallLogs(): readonly unknown[] {
    return [];
  }

  getProviderAccessLogs(): readonly unknown[] {
    return [];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start a trajectory. Supports both call styles:
   *   1) startTrajectory(stepId, { agentId, ...options }) uses stepId as the id
   *   2) startTrajectory(agentId, { ...optionsWithoutAgentId }) mints an id
   */
  async startTrajectory(
    stepIdOrAgentId: string,
    options?: StartTrajectoryOptions,
  ): Promise<string> {
    const claimedAgentId = options?.agentId ?? stepIdOrAgentId;
    if (claimedAgentId !== this.runtime.agentId) {
      throw new ElizaError("Trajectory start names another agent", {
        code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
        context: { agentId: this.runtime.agentId },
      });
    }
    if (!this.isEnabled()) return randomUUID();
    const stepId =
      typeof options?.agentId === "string"
        ? stepIdOrAgentId
        : `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startMetadata = normalizeTrajectoryMetadata(
      {
        ...(options?.metadata ?? {}),
        ...(options?.roomId !== undefined ? { roomId: options.roomId } : {}),
        ...(options?.entityId !== undefined
          ? { entityId: options.entityId }
          : {}),
        ...(options?.traceId !== undefined
          ? {
              correlation: {
                traceId: options.traceId,
                ...(options.roomId !== undefined
                  ? { roomId: options.roomId }
                  : {}),
                ...(options.scenarioId !== undefined
                  ? { runId: options.scenarioId }
                  : {}),
              },
            }
          : {}),
      },
      {
        scenarioId: options?.scenarioId,
        batchId: options?.batchId,
      },
    ).metadata;

    const writePromise = enqueueStepWrite(this.runtime, stepId, async () => {
      if (!this.persistenceEnabled()) return;
      if (!(await ensureTrajectoriesTable(this.runtime))) return;
      await writeStartedTrajectoryStep({
        runtime: this.runtime,
        stepId,
        source: options?.source ?? "chat",
        metadata: startMetadata,
        traceId: options?.traceId,
        episodeId: options?.episodeId,
        groupIndex: options?.groupIndex,
        createInitialStep: false,
      });
    });
    lastWritePromises.set(this.runtime as object, writePromise);
    rememberTrajectoryStep(this.runtime, stepId, stepId);
    return stepId;
  }

  startStep(trajectoryId: string, state: BridgeStepState = {}): string {
    if (!this.isEnabled()) return randomUUID();
    return startChildTrajectoryStep(
      this.runtime,
      this,
      trajectoryId,
      state,
      () => this.persistenceEnabled(),
    );
  }

  getCurrentStepId(trajectoryId: string): string | null {
    if (!this.isEnabled()) return null;
    return (
      activeTrajectoryStepId(
        this.runtime,
        resolveBridgeTrajectoryId(this.runtime, trajectoryId),
      ) ?? null
    );
  }

  /**
   * Settle an action on a step. Supports:
   *   completeStep(trajectoryId, action, rewardInfo?)
   *   completeStep(trajectoryId, stepId, action, rewardInfo?)
   */
  completeStep(
    trajectoryId: string,
    actionOrStepId: string | Record<string, unknown>,
    actionOrReward?: Record<string, unknown>,
    rewardInfo?: Record<string, unknown>,
  ): void {
    if (!this.isEnabled()) return;
    const explicitStepId =
      typeof actionOrStepId === "string" ? actionOrStepId : undefined;
    const action = explicitStepId ? actionOrReward : actionOrStepId;
    const reward = explicitStepId ? rewardInfo : actionOrReward;
    const ownerId = resolveBridgeTrajectoryId(this.runtime, trajectoryId);
    const stepId =
      explicitStepId ?? activeTrajectoryStepId(this.runtime, ownerId);
    if (!stepId || !action) {
      const error = new ElizaError("Trajectory action step is missing", {
        code: "TRAJECTORY_ACTION_STEP_REQUIRED",
        context: { trajectoryId: ownerId },
      });
      warnRuntime(
        this.runtime,
        "Trajectory action settlement did not identify an active child step",
        error,
      );
      this.runtime.reportError("TrajectoryStorage.completeStep", error, {
        trajectoryId: ownerId,
        ...(stepId ? { stepId } : {}),
        diagnosticOnly: true,
      });
      return;
    }
    try {
      completeTrajectoryAction(
        this.runtime,
        ownerId,
        stepId,
        action,
        reward,
        () => this.persistenceEnabled(),
      );
    } catch (error) {
      // error-policy:J7 Action telemetry cannot rewrite an already-settled tool
      // result, but malformed or unroutable settlement remains observable.
      warnRuntime(this.runtime, "Trajectory action settlement failed", error);
      this.runtime.reportError("TrajectoryStorage.completeStep", error, {
        trajectoryId: ownerId,
        stepId,
        diagnosticOnly: true,
      });
    }
  }

  async flushWriteQueue(trajectoryId?: string): Promise<void> {
    await flushTrajectoryWrites(this.runtime, trajectoryId);
  }

  async endTrajectory(
    stepIdOrTrajectoryId: string,
    status: TrajectoryStatus = "completed",
    finalMetrics?: Record<string, unknown>,
  ): Promise<void> {
    const trajectoryId = resolveBridgeTrajectoryId(
      this.runtime,
      stepIdOrTrajectoryId,
    );
    if (!this.isEnabled()) {
      releaseTrajectoryBridgeState(this.runtime, trajectoryId);
      return;
    }
    await terminalizeBridgeTrajectory(
      this.runtime,
      trajectoryId,
      status,
      finalMetrics,
      () => this.persistenceEnabled(),
    );
  }

  releaseTrajectoryOwnership(stepIdOrTrajectoryId: string): void {
    releaseTrajectoryBridgeState(
      this.runtime,
      resolveBridgeTrajectoryId(this.runtime, stepIdOrTrajectoryId),
    );
  }

  applyReward(params: TrajectoryRewardRequest): Promise<boolean> {
    return applyDatabaseTrajectoryReward(
      this.runtime,
      () => this.persistenceEnabled(),
      params,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reads and exports
  // ─────────────────────────────────────────────────────────────────────────

  listTrajectories(
    options: TrajectoryListOptions = {},
  ): Promise<TrajectoryListResult> {
    return listDatabaseTrajectories(this.runtime, options);
  }

  getTrajectoryDetail(
    trajectoryId: string,
  ): Promise<TrajectoryDetailRecord | null> {
    return getDatabaseTrajectoryDetail(this.runtime, trajectoryId);
  }

  async getStats(): Promise<TrajectoryStats> {
    const { byStatus: _byStatus, ...stats } =
      await readDatabaseTrajectoryStatistics(this.runtime);
    return stats;
  }

  deleteTrajectories(trajectoryIds: string[]): Promise<number> {
    return deletePersistedTrajectoryRows(this.runtime, trajectoryIds);
  }

  clearAllTrajectories(): Promise<number> {
    return clearPersistedTrajectoryRows(this.runtime);
  }

  async exportTrajectories(
    options: TrajectoryExportOptions,
  ): Promise<TrajectoryExportResult> {
    return exportPersistedTrajectories({
      agentId: this.runtime.agentId,
      persistedTrajectories: await loadPersistedTrajectoriesForExport(
        this.runtime,
        options,
      ),
      options,
    });
  }

  async exportTrajectoriesZip(
    options: TrajectoryZipExportOptions = {},
  ): Promise<TrajectoryZipExportResult> {
    const targetIds = Array.isArray(options.trajectoryIds)
      ? options.trajectoryIds.filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        )
      : [];

    if (targetIds.length === 0) {
      const seen = new Set<string>();
      let expectedTotal: number | undefined;
      do {
        const list = await this.listTrajectories({
          limit: 500,
          offset: targetIds.length,
          source: options.source,
          status: options.status,
          search: options.search,
          runId: options.runId,
          startDate: options.startDate,
          endDate: options.endDate,
          scenarioId: options.scenarioId,
          traceId: options.traceId,
          batchId: options.batchId,
        });
        expectedTotal ??= list.total;
        if (
          !Number.isSafeInteger(list.total) ||
          list.total < 0 ||
          list.total !== expectedTotal ||
          list.offset !== targetIds.length ||
          (list.trajectories.length === 0 && targetIds.length < expectedTotal)
        ) {
          throw new ElizaError(
            "Trajectory export inventory changed or is incomplete; retry the export",
            { code: "TRAJECTORY_EXPORT_INCOMPLETE" },
          );
        }
        for (const trajectory of list.trajectories) {
          if (seen.has(trajectory.id) || seen.size >= expectedTotal) {
            throw new ElizaError(
              "Trajectory export inventory repeated or changed; retry the export",
              { code: "TRAJECTORY_EXPORT_INCOMPLETE" },
            );
          }
          seen.add(trajectory.id);
          targetIds.push(trajectory.id);
        }
      } while (targetIds.length < expectedTotal);
    }

    const entries: TrajectoryZipEntry[] = [];
    const manifestRows: Array<{
      trajectoryId: string;
      folder: string;
      createdAt: string;
    }> = [];

    for (const trajectoryId of targetIds) {
      const detail = await this.getTrajectoryDetail(trajectoryId);
      if (!detail) {
        throw new ElizaError(
          "A requested trajectory is unavailable; retry with an accessible export selection",
          {
            code: "TRAJECTORY_EXPORT_INCOMPLETE",
            context: { trajectoryId },
          },
        );
      }
      const exportTrajectory =
        options.includePrompts === false
          ? redactTrajectoryPrompts(detail)
          : detail;
      const summary = buildZipSummary(exportTrajectory);
      const folderName = sanitizeZipFolderName(trajectoryId);
      entries.push({
        name: `${folderName}/trajectory.json`,
        data: JSON.stringify(exportTrajectory, null, 2),
      });
      entries.push({
        name: `${folderName}/summary.json`,
        data: JSON.stringify(summary, null, 2),
      });
      manifestRows.push({
        trajectoryId,
        folder: folderName,
        createdAt: summary.createdAt,
      });
    }

    entries.unshift({
      name: "manifest.json",
      data: JSON.stringify(
        { exportedAt: new Date().toISOString(), trajectories: manifestRows },
        null,
        2,
      ),
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return { filename: `trajectories-${timestamp}.zip`, entries };
  }
}
