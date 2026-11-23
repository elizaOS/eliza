/**
 * The runtime `TrajectoryRecorder` on the trajectory store.
 *
 * Each recorded trajectory (the planner/evaluator stage record with its root
 * message, run/scenario correlation and cost metrics) is captured once:
 * - the store keeps the header and stages in the trajectory rows through
 *   `TrajectoriesService` when it persists (policy on, SQL adapter present);
 * - the per-file `RecordedTrajectory` JSON under the trajectory directory is
 *   the store's export, rewritten after every change ("export on flush") so
 *   `ELIZA_TRAJECTORY_DIR` readers see the live record. Without SQL or without
 *   the service, the export is the only copy.
 * Metrics are derived from the stages by the store projection, so the row and
 * the file cannot disagree.
 */
import crypto from "node:crypto";
import {
  cloneTrajectoryValue,
  composeToolDiagnosticRedactor,
  getTrajectoryContext,
  type IAgentRuntime,
  isTrajectoryRecordingEnabled,
  type ListTrajectoriesOptions,
  projectRecordedStageToolDiagnostics,
  type RecordedStage,
  type RecordedTrajectory,
  type RecorderLogger,
  readEnv,
  resolveTraceCorrelationFromEnv,
  type StartTrajectoryInput,
  type ToolDiagnosticTextRedactor,
  type TrajectoryRecorder,
  toWellFormedUnicode,
} from "@elizaos/core";
import {
  annotateStageCost,
  buildRecordedTrajectory,
  type RecordedTrajectoryHeader,
} from "./store/recorded-trajectory.ts";
import {
  isTrajectoryMarkdownReviewEnabled,
  listRecordedTrajectoryFiles,
  readRecordedTrajectoryFile,
  resolveTrajectoryDir,
  resolveTrajectoryMarkdownDir,
  writeRecordedTrajectoryFile,
} from "./store/recorded-trajectory-files.ts";
import {
  type RecordedTrajectoryLocation,
  TrajectoriesService,
} from "./TrajectoriesService.ts";

export interface CreateTrajectoryRecorderOptions {
  /**
   * The runtime whose `TrajectoriesService` stores the trajectories. Its
   * logger, `reportError` and `redactSecrets` are the defaults for the
   * options below. Without a runtime (or without a persisting service) only
   * the per-file export is written.
   */
  runtime?: Pick<
    IAgentRuntime,
    "getService" | "getServicesByType" | "reportError" | "logger"
  > &
    Partial<Pick<IAgentRuntime, "redactSecrets">>;
  /** Export directory. Defaults to {@link resolveTrajectoryDir}. */
  rootDir?: string;
  logger?: RecorderLogger;
  enabled?: boolean;
  reportError?: (
    scope: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) => void;
  /**
   * Runtime-known-secret redaction composed into the final-persistence
   * diagnostic projection (see {@link projectRecordedStageToolDiagnostics}).
   * The shared tool-shape pattern pass always runs; this only adds
   * character-configured secret masking.
   */
  redactSecrets?: (text: string) => string;
}

interface ActiveRecord {
  header: RecordedTrajectoryHeader;
  stages: RecordedStage[];
  location: RecordedTrajectoryLocation | null;
}

function safeRandomId(prefix: string): string {
  const rand = Math.random().toString(16).slice(2, 10);
  const ts = Date.now().toString(16).slice(-6);
  return `${prefix}-${ts}${rand}`;
}

function cloneRootMessageForRecord(
  rootMessage: StartTrajectoryInput["rootMessage"],
): RecordedTrajectory["rootMessage"] {
  return {
    id: String(rootMessage.id),
    text: toWellFormedUnicode(String(rootMessage.text)),
    sender:
      rootMessage.sender === undefined
        ? undefined
        : toWellFormedUnicode(String(rootMessage.sender)),
  };
}

class StoreTrajectoryRecorder implements TrajectoryRecorder {
  private readonly rootDir: string;
  private readonly markdownDir: string | undefined;
  private readonly logger?: RecorderLogger;
  private readonly reportError?: CreateTrajectoryRecorderOptions["reportError"];
  private readonly enabled: boolean;
  private readonly redactText: ToolDiagnosticTextRedactor;
  private readonly service: TrajectoriesService | null;
  private readonly active = new Map<string, ActiveRecord>();
  private readonly flushQueues = new Map<string, Promise<void>>();

  constructor(opts: CreateTrajectoryRecorderOptions) {
    const runtime = opts.runtime;
    this.rootDir = opts.rootDir ?? resolveTrajectoryDir();
    this.logger =
      opts.logger ?? (runtime?.logger as RecorderLogger | undefined);
    this.reportError =
      opts.reportError ?? runtime?.reportError.bind(runtime) ?? undefined;
    this.redactText = composeToolDiagnosticRedactor({
      redactSecrets:
        opts.redactSecrets ?? runtime?.redactSecrets?.bind(runtime),
    });
    this.enabled =
      opts.enabled !== undefined
        ? opts.enabled
        : isTrajectoryRecordingEnabled();
    this.markdownDir =
      this.enabled && isTrajectoryMarkdownReviewEnabled()
        ? resolveTrajectoryMarkdownDir(this.rootDir)
        : undefined;
    this.service = runtime
      ? TrajectoriesService.resolveFromRuntime(runtime as IAgentRuntime)
      : null;
  }

  startTrajectory(input: StartTrajectoryInput): string {
    const id = safeRandomId("tj");
    if (!this.enabled) return id;

    // Explicit input wins, else the env the spawner set, else (traceId only)
    // mint one so every trajectory is joinable even without a parent trace.
    const inherited = resolveTraceCorrelationFromEnv();
    const header: RecordedTrajectoryHeader = {
      trajectoryId: id,
      agentId: input.agentId,
      roomId: input.roomId,
      // The scenario CLI stamps these before each run/scenario (cli.ts); an
      // explicit call-site value wins. readEnv treats blank as unset.
      runId: input.runId ?? readEnv("ELIZA_LIFEOPS_RUN_ID"),
      scenarioId: input.scenarioId ?? readEnv("ELIZA_LIFEOPS_SCENARIO_ID"),
      traceId: input.traceId ?? inherited.traceId ?? crypto.randomUUID(),
      taskId: input.taskId ?? inherited.taskId,
      sessionId: input.sessionId ?? inherited.sessionId,
      parentStepId: input.parentStepId ?? inherited.parentStepId,
      codingActionProfile: input.codingActionProfile,
      rootMessage: cloneRootMessageForRecord(input.rootMessage),
      startedAt: Date.now(),
      status: "running",
      stageIds: [],
    };
    const record: ActiveRecord = {
      header,
      stages: [],
      location: this.storeCall("start", id, () =>
        this.service
          ? this.service.startRecordedTrajectory(
              cloneTrajectoryValue(header),
              getTrajectoryContext()?.trajectoryStepId,
            )
          : null,
      ),
    };
    this.active.set(id, record);

    // The initial export is diagnostic and detached from message delivery.
    void this.queueExport(record).catch((err) => {
      // error-policy:J7 Report a missing initial export without aborting the
      // message path that started it.
      this.reportError?.("TrajectoryRecorder.initialFlush", err, {
        trajectoryId: id,
      });
      this.logger?.warn?.(
        { err: (err as Error).message, trajectoryId: id },
        "[TrajectoryRecorder] initial flush failed",
      );
    });
    return id;
  }

  async recordStage(trajectoryId: string, stage: RecordedStage): Promise<void> {
    if (!this.enabled) return;
    const record = this.active.get(trajectoryId);
    if (!record) {
      this.logger?.warn?.(
        { trajectoryId },
        "[TrajectoryRecorder] recordStage: trajectory not found (was startTrajectory called?)",
      );
      return;
    }

    const recordedStage = cloneTrajectoryValue(stage);
    projectRecordedStageToolDiagnostics(recordedStage, this.redactText);
    annotateStageCost(recordedStage, this.logger);
    record.stages.push(recordedStage);
    record.header.stageIds.push(recordedStage.stageId);
    const location = record.location;
    if (location && this.service) {
      const service = this.service;
      this.storeCall("stage", trajectoryId, () =>
        service.logRecordedStage(location, trajectoryId, recordedStage),
      );
    }

    // The export rewrites the whole file. Large model prompts can make one
    // file several megabytes, so it stays off the user-visible planner path:
    // the snapshot is queued in record order and the terminal endTrajectory
    // awaits the same queue, which remains the durability boundary.
    void this.queueExport(record).catch((error) => {
      // error-policy:J7 the export is diagnostic; a failed write is reported.
      this.logger?.warn?.(
        { err: (error as Error).message, trajectoryId, stageKind: stage.kind },
        "[TrajectoryRecorder] failed to persist stage file",
      );
      this.reportError?.("TrajectoryRecorder.persistStage", error, {
        trajectoryId,
        stageKind: stage.kind,
        diagnosticOnly: true,
      });
    });
  }

  async endTrajectory(
    trajectoryId: string,
    status: "finished" | "errored",
  ): Promise<void> {
    if (!this.enabled) return;
    const record = this.active.get(trajectoryId);
    if (!record) {
      this.logger?.warn?.(
        { trajectoryId },
        "[TrajectoryRecorder] endTrajectory: trajectory not found",
      );
      return;
    }

    record.header.status = status;
    record.header.endedAt = Date.now();
    try {
      const location = record.location;
      const storeEnd =
        location && this.service
          ? this.service
              .endRecordedTrajectory(
                location,
                cloneTrajectoryValue(record.header),
              )
              .catch((error) => {
                // error-policy:J7 a failed store write is reported; the
                // export below still carries the terminal record.
                this.reportStoreFailure("end", trajectoryId, error);
              })
          : undefined;
      await Promise.all([storeEnd, this.queueExport(record)]);
    } finally {
      // Always retire the trajectory, even when the terminal export fails;
      // otherwise late recordStage calls keep resurrecting a dead record.
      this.active.delete(trajectoryId);
      this.flushQueues.delete(trajectoryId);
    }
  }

  async load(trajectoryId: string): Promise<RecordedTrajectory | null> {
    const record = this.active.get(trajectoryId);
    if (record) return buildRecordedTrajectory(record.header, record.stages);
    return readRecordedTrajectoryFile(this.rootDir, trajectoryId);
  }

  list(opts: ListTrajectoriesOptions = {}): Promise<RecordedTrajectory[]> {
    return listRecordedTrajectoryFiles(this.rootDir, opts);
  }

  private storeCall<T>(
    phase: "start" | "stage",
    trajectoryId: string,
    call: () => T | null,
  ): T | null {
    try {
      return call();
    } catch (error) {
      // error-policy:J7 the store write is observability; a fault is reported
      // and the export still runs.
      this.reportStoreFailure(phase, trajectoryId, error);
      return null;
    }
  }

  private reportStoreFailure(
    phase: "start" | "stage" | "end",
    trajectoryId: string,
    error: unknown,
  ): void {
    this.logger?.warn?.(
      { err: (error as Error)?.message, trajectoryId, phase },
      "[TrajectoryRecorder] store write failed",
    );
    this.reportError?.("TrajectoryRecorder.store", error, {
      trajectoryId,
      phase,
      diagnosticOnly: true,
    });
  }

  private queueExport(record: ActiveRecord): Promise<void> {
    const trajectoryId = record.header.trajectoryId;
    const snapshot = cloneTrajectoryValue(
      buildRecordedTrajectory(record.header, record.stages),
    );
    const previous = this.flushQueues.get(trajectoryId) ?? Promise.resolve();
    // error-policy:J5 rejection-suppression: a prior export's failure (already
    // surfaced to its caller) must not block this snapshot's export.
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await writeRecordedTrajectoryFile(this.rootDir, snapshot, {
          markdownDir: this.markdownDir,
          logger: this.logger,
        });
      });
    this.flushQueues.set(trajectoryId, next);
    // error-policy:J5 rejection-suppression: the returned `next` is observed
    // by the caller; this branch only cleans up the queue map.
    void next
      .finally(() => {
        if (this.flushQueues.get(trajectoryId) === next) {
          this.flushQueues.delete(trajectoryId);
        }
      })
      .catch(() => undefined);
    return next;
  }
}

/**
 * Construct the runtime `TrajectoryRecorder`. It stores trajectories through
 * the runtime's `TrajectoriesService` and exports each one as a per-file
 * `RecordedTrajectory` under `rootDir` (default: `ELIZA_TRAJECTORY_DIR` →
 * `ELIZA_STATE_DIR/trajectories` → state-dir/trajectories).
 *
 * Pass `enabled: false` to short-circuit every method.
 */
export function createTrajectoryRecorder(
  opts: CreateTrajectoryRecorderOptions = {},
): TrajectoryRecorder {
  return new StoreTrajectoryRecorder(opts);
}
