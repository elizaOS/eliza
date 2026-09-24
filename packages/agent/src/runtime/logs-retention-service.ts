/**
 * Applies the host's opt-in logs retention policy through the core task clock.
 * Storage policy stays separate from scheduling; failures remain observable and
 * shutdown drains any sweep already in progress before releasing the service.
 */

import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  planRetention,
  policyIsActive,
  type ResolvedRetentionConfig,
  type RetainableRow,
  resolveRetentionConfigWithPrefix,
} from "./memory-retention.ts";

import { RetentionTask } from "./retention-task.ts";

export const LOGS_RETENTION_SERVICE = "eliza_logs_retention";

/** Env/settings prefix — independent from the memory retention config. */
export const LOGS_RETENTION_PREFIX = "ELIZA_LOGS_RETENTION";

const DEFAULT_INTERVAL_MINUTES = 360; // 6h
/** Upper bound on rows scanned per sweep (memory safety on the fetch). */
const SCAN_LIMIT = 100_000;
/** Stable bucket key for logs that carry no roomId (count bound still applies). */
const NULL_ROOM_KEY = "__no_room__";

/** Legacy public adapter shape retained for existing type consumers; the service uses the canonical runtime contract. */
export interface LogsRetentionAdapter {
  getLogs(params: {
    entityId?: string;
    roomId?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }): Promise<
    Array<{ id?: string; roomId?: string; createdAt?: number | Date }>
  >;
  deleteLogs(logIds: string[]): Promise<void>;
}

export interface LogsSweepResult {
  scanned: number;
  evictable: number;
  deleted: number;
  clamped: boolean;
}

export class LogsRetentionService extends Service {
  static override serviceType = LOGS_RETENTION_SERVICE;

  override capabilityDescription =
    "Scheduled bounded retention for the append-only logs table: prunes oldest rows past a day/row-count bound so the logs table (the biggest growth surface) cannot fill the disk";

  private readonly retentionTask = new RetentionTask<LogsSweepResult>(
    this.runtime,
    "HOST_LOGS_RETENTION",
    () => this.sweepOnce(),
  );
  private retentionConfig: ResolvedRetentionConfig = {};

  static async start(runtime: IAgentRuntime): Promise<LogsRetentionService> {
    const svc = new LogsRetentionService(runtime);
    await svc.init();
    return svc;
  }

  private async init(): Promise<void> {
    this.retentionConfig = resolveRetentionConfigWithPrefix((key) => {
      const fromSettings = this.runtime.getSetting(key);
      if (fromSettings !== undefined && fromSettings !== null) {
        return String(fromSettings);
      }
      return process.env[key];
    }, LOGS_RETENTION_PREFIX);

    if (!policyIsActive(this.retentionConfig)) {
      await this.retentionTask.start(undefined);
      logger.info(
        "[logs-retention] no active bound (ELIZA_LOGS_RETENTION_DAYS/MAX_ROWS_PER_ROOM unset) — logs retention DISABLED",
      );
      return;
    }

    const intervalMinutes =
      this.retentionConfig.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    logger.info(
      `[logs-retention] enabled: retentionDays=${this.retentionConfig.retentionDays ?? "off"} maxRowsPerRoom=${this.retentionConfig.maxRowsPerRoom ?? "off"} maxDeletePerSweep=${this.retentionConfig.maxDeletePerSweep ?? "none"} intervalMinutes=${intervalMinutes}`,
    );

    await this.retentionTask.start(intervalMinutes * 60 * 1000);
  }

  async stop(): Promise<void> {
    await this.retentionTask.stop();
  }

  /**
   * Run one sweep over the logs table. Re-entrancy-guarded so a long sweep
   * never overlaps the next tick. Returns the sweep result (also useful in
   * tests / ops probes).
   */
  sweep(): Promise<LogsSweepResult> {
    return this.retentionTask.run(() => this.sweepOnce());
  }

  private async sweepOnce(): Promise<LogsSweepResult> {
    if (!policyIsActive(this.retentionConfig)) {
      return { scanned: 0, evictable: 0, deleted: 0, clamped: false };
    }
    try {
      const adapter = this.runtime.adapter;

      const rows = await adapter.getLogs({ limit: SCAN_LIMIT });

      const retainable: RetainableRow[] = [];
      for (const r of rows) {
        if (!r.id) continue;
        retainable.push({
          id: r.id,
          // Bucket per room; null-room logs share one stable bucket so the
          // count bound still applies to them as a group.
          roomId: r.roomId ?? NULL_ROOM_KEY,
          createdAt: toMs(r.createdAt),
        });
      }

      const plan = planRetention(
        retainable,
        {
          retentionDays: this.retentionConfig.retentionDays,
          maxRowsPerRoom: this.retentionConfig.maxRowsPerRoom,
          maxDeletePerSweep: this.retentionConfig.maxDeletePerSweep,
        },
        Date.now(),
      );

      let deleted = 0;
      if (plan.deleteIds.length > 0) {
        const selected = new Set(plan.deleteIds);
        const ids = rows.flatMap((row) =>
          row.id && selected.has(row.id) ? [row.id] : [],
        );
        await adapter.deleteLogs(ids);
        deleted = ids.length;
      }

      const result: LogsSweepResult = {
        scanned: retainable.length,
        evictable: plan.evictable,
        deleted,
        clamped: plan.clamped,
      };

      if (deleted > 0) {
        logger.info(
          `[logs-retention] scanned=${result.scanned} evictable=${result.evictable} deleted=${deleted}${plan.clamped ? " (clamped, more next sweep)" : ""}`,
        );
      }
      return result;
    } catch (cause) {
      // error-policy:J2 TaskService or the direct caller owns failure reporting.
      throw new ElizaError("Unable to complete logs retention", {
        code: "LOGS_RETENTION_FAILED",
        cause,
        context: { agentId: this.runtime.agentId },
      });
    }
  }
}

/** Coerce a Date | epoch-ms | undefined into epoch ms (undefined => NaN). */
function toMs(v: number | Date | undefined): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return Number.NaN; // planner's tsOf treats NaN as "now" (keep-safe)
}

/** Resolve the registered service, or null when logs retention isn't installed. */
export function resolveLogsRetentionService(
  runtime: IAgentRuntime,
): LogsRetentionService | null {
  return runtime.getService<LogsRetentionService>(LOGS_RETENTION_SERVICE);
}
