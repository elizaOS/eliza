/**
 * LogsRetentionService — the scheduled sweep that enforces
 * {@link planRetention} against the append-only `logs` table, keeping it
 * bounded so it cannot fill the disk.
 *
 * WHY a SECOND service (not just another partition on MemoryRetentionService):
 * the `logs` table is NOT a memory partition. It has its own adapter surface
 * (`getLogs` / `deleteLogs`) that is entirely separate from the memory
 * partitions' `getMemories` / `deleteManyMemories`, and deleting a log must NOT
 * cascade to any embedding. Sharing the memory sweep would either couple two
 * unrelated table families or smuggle `logs` into `RETENTION_PARTITIONS`
 * (which is deliberately memory-only). So logs get their own restart-safe
 * service that REUSES the pure planner + config primitives from
 * `memory-retention.ts` and only swaps the table adapter.
 *
 * Empirically (SOLIZA-M5-RETENTION-2026-07-20) `logs` is the single biggest
 * always-growing surface — ~3.9 log rows per memory row, ~3.4 KB/row, i.e. the
 * dominant linear-growth term left after #16714 bounded memories+embeddings.
 *
 * SCOPE: `logs` ONLY. `central_messages` and `memory_access_logs` were flagged
 * as unbounded too, but the core `IDatabaseAdapter` exposes NO clean
 * get-by-time + delete-by-id pair for them (unlike `logs`' getLogs/deleteLogs),
 * so bounding them cleanly would require new adapter methods / raw SQL — a
 * separate, larger change. They are intentionally deferred here rather than
 * bounded through a leaky back door. See the receipt for the follow-up note.
 *
 * Boot-time contract (identical discipline to MemoryRetentionService):
 *   - Config from `runtime.getSetting` (host-folded) with a `process.env`
 *     fallback, under the INDEPENDENT `ELIZA_LOGS_RETENTION_*` prefix.
 *   - OFF by default: no active bound => never schedules a sweep, no-op.
 *   - When active: one sweep after a short boot-settle delay, then every
 *     `intervalMinutes` (default 360 = 6h). Timers are `unref`'d so retention
 *     never keeps the process alive.
 *   - `stop()` clears timers; restart-safe / idempotent (re-plans from the
 *     live DB each boot, no persisted cursor).
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  planRetention,
  policyIsActive,
  type ResolvedRetentionConfig,
  type RetainableRow,
  resolveRetentionConfigWithPrefix,
} from "./memory-retention.ts";

export const LOGS_RETENTION_SERVICE = "eliza_logs_retention";

/** Env/settings prefix — independent from the memory retention config. */
export const LOGS_RETENTION_PREFIX = "ELIZA_LOGS_RETENTION";

const DEFAULT_INTERVAL_MINUTES = 360; // 6h
const START_DELAY_MS = 30_000; // let boot settle before first sweep
/** Upper bound on rows scanned per sweep (memory safety on the fetch). */
const SCAN_LIMIT = 100_000;
/** Stable bucket key for logs that carry no roomId (count bound still applies). */
const NULL_ROOM_KEY = "__no_room__";

/**
 * Minimal adapter surface the logs sweep needs — narrowed to exactly the two
 * `logs`-table methods on `IDatabaseAdapter`, for testability without a DB.
 */
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

/**
 * Structural guard: narrow the runtime's `adapter` (typed as the broad
 * IDatabaseAdapter) to the {@link LogsRetentionAdapter} surface the sweep needs.
 * Runtime-checks the two methods it calls so a non-conforming adapter is a
 * clean skip rather than a throw, and lets us narrow without an unsafe cast.
 */
function asLogsRetentionAdapter(adapter: unknown): LogsRetentionAdapter | null {
  if (!adapter || typeof adapter !== "object") return null;
  const candidate = adapter as Partial<LogsRetentionAdapter>;
  if (
    typeof candidate.getLogs !== "function" ||
    typeof candidate.deleteLogs !== "function"
  ) {
    return null;
  }
  return candidate as LogsRetentionAdapter;
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

  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private sweeping = false;
  private retentionConfig: ResolvedRetentionConfig = {};

  static async start(runtime: IAgentRuntime): Promise<LogsRetentionService> {
    const svc = new LogsRetentionService(runtime);
    svc.init();
    return svc;
  }

  private init(): void {
    this.retentionConfig = resolveRetentionConfigWithPrefix((key) => {
      const fromSettings = this.runtime.getSetting(key);
      if (fromSettings !== undefined && fromSettings !== null) {
        return String(fromSettings);
      }
      return process.env[key];
    }, LOGS_RETENTION_PREFIX);

    if (!policyIsActive(this.retentionConfig)) {
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

    // First sweep after a short delay (don't block boot), then on cadence.
    this.startTimer = setTimeout(() => {
      void this.sweep();
      this.timer = setInterval(
        () => void this.sweep(),
        intervalMinutes * 60 * 1000,
      );
      this.timer.unref?.();
    }, START_DELAY_MS);
    this.startTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one sweep over the logs table. Re-entrancy-guarded so a long sweep
   * never overlaps the next tick. Returns the sweep result (also useful in
   * tests / ops probes).
   */
  async sweep(): Promise<LogsSweepResult> {
    const empty: LogsSweepResult = {
      scanned: 0,
      evictable: 0,
      deleted: 0,
      clamped: false,
    };
    if (this.sweeping) {
      logger.debug("[logs-retention] sweep already in progress, skipping tick");
      return empty;
    }
    if (!policyIsActive(this.retentionConfig)) return empty;

    this.sweeping = true;
    try {
      const adapter = asLogsRetentionAdapter(this.runtime.adapter);
      if (!adapter) {
        logger.warn("[logs-retention] adapter missing getLogs, skipping sweep");
        return empty;
      }

      let rows: Array<{
        id?: string;
        roomId?: string;
        createdAt?: number | Date;
      }>;
      try {
        rows = await adapter.getLogs({ limit: SCAN_LIMIT });
      } catch (err) {
        logger.debug(
          `[logs-retention] getLogs failed (${(err as Error)?.message}); skipping sweep`,
        );
        return empty;
      }

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
        await adapter.deleteLogs(plan.deleteIds);
        deleted = plan.deleteIds.length;
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
    } catch (err) {
      logger.error(`[logs-retention] sweep failed: ${(err as Error)?.message}`);
      return empty;
    } finally {
      this.sweeping = false;
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
