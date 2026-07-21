/**
 * MemoryRetentionService — the scheduled sweep that enforces
 * {@link planRetention} against the live memory store, keeping the append-only
 * `memories`/`embeddings` partitions bounded so they cannot fill the disk.
 *
 * Boot-time contract:
 *   - Resolves config from `runtime.getSetting` (host-folded) with a
 *     `process.env` fallback for host-level ops config, via
 *     {@link resolveRetentionConfig}.
 *   - If no bound is active, the service registers but NEVER schedules a sweep
 *     — a hard "off by default" guarantee.
 *   - When active, runs one sweep on start (after a short delay so boot isn't
 *     blocked) and then every `intervalMinutes` (default 360 = 6h). The timer
 *     is `unref`'d so retention never keeps the process alive.
 *   - `stop()` clears the timer; the service is restart-safe (idempotent — a
 *     fresh boot re-plans from the current DB, no persisted cursor to corrupt).
 *
 * Only the memory partitions are touched. Batch deletion goes through the
 * adapter's `deleteManyMemories`, which removes each memory's embeddings in the
 * same transaction; no other table is referenced.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  planRetention,
  policyIsActive,
  type ResolvedRetentionConfig,
  type RetainableRow,
  resolveRetentionConfig,
} from "./memory-retention.ts";

export const MEMORY_RETENTION_SERVICE = "eliza_memory_retention";

const DEFAULT_INTERVAL_MINUTES = 360; // 6h
const START_DELAY_MS = 30_000; // let boot settle before first sweep
/** Upper bound on rows scanned per partition per sweep (memory safety). */
const SCAN_LIMIT = 100_000;

/**
 * The memory partitions this sweep governs. Mirrors the canonical partition
 * list the runtime writes into (`getAllMemories`); kept explicit so a new
 * partition is a deliberate, reviewed addition rather than an accidental
 * scope change.
 */
export const RETENTION_PARTITIONS = [
  "memories",
  "messages",
  "facts",
  "documents",
] as const;

/** Minimal adapter surface the sweep needs — narrowed for testability. */
export interface RetentionAdapter {
  getMemories(params: {
    agentId?: string;
    tableName: string;
    limit?: number;
    orderBy?: "createdAt";
    orderDirection?: "asc" | "desc";
  }): Promise<Array<{ id?: string; roomId: string; createdAt?: number }>>;
  deleteManyMemories(ids: string[]): Promise<void>;
}

export interface SweepResult {
  partition: string;
  scanned: number;
  evictable: number;
  deleted: number;
  clamped: boolean;
}

export class MemoryRetentionService extends Service {
  static override serviceType = MEMORY_RETENTION_SERVICE;

  override capabilityDescription =
    "Scheduled bounded retention for the memories/embeddings partitions: prunes oldest rows past a day/row-count bound so the store cannot fill the disk";

  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private sweeping = false;
  private retentionConfig: ResolvedRetentionConfig = {};

  static async start(runtime: IAgentRuntime): Promise<MemoryRetentionService> {
    const svc = new MemoryRetentionService(runtime);
    svc.init();
    return svc;
  }

  private init(): void {
    this.retentionConfig = resolveRetentionConfig((key) => {
      const fromSettings = this.runtime.getSetting(key);
      if (fromSettings !== undefined && fromSettings !== null) {
        return String(fromSettings);
      }
      return process.env[key];
    });

    if (!policyIsActive(this.retentionConfig)) {
      logger.info(
        "[memory-retention] no active bound (retentionDays/maxRowsPerRoom unset) — retention DISABLED",
      );
      return;
    }

    const intervalMinutes =
      this.retentionConfig.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    logger.info(
      `[memory-retention] enabled: retentionDays=${this.retentionConfig.retentionDays ?? "off"} maxRowsPerRoom=${this.retentionConfig.maxRowsPerRoom ?? "off"} maxDeletePerSweep=${this.retentionConfig.maxDeletePerSweep ?? "none"} intervalMinutes=${intervalMinutes}`,
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
   * Run one sweep across all retention partitions. Re-entrancy-guarded so a
   * long sweep never overlaps the next tick. Returns per-partition results
   * (also useful in tests / ops probes).
   */
  async sweep(): Promise<SweepResult[]> {
    if (this.sweeping) {
      logger.debug(
        "[memory-retention] sweep already in progress, skipping tick",
      );
      return [];
    }
    if (!policyIsActive(this.retentionConfig)) return [];

    this.sweeping = true;
    const results: SweepResult[] = [];
    try {
      const adapter = this.runtime.adapter as unknown as RetentionAdapter;
      if (!adapter || typeof adapter.getMemories !== "function") {
        logger.warn(
          "[memory-retention] adapter missing getMemories, skipping sweep",
        );
        return [];
      }

      // A running per-sweep budget so the global maxDeletePerSweep is shared
      // across partitions (not applied fresh per partition).
      let budget = this.retentionConfig.maxDeletePerSweep;

      for (const partition of RETENTION_PARTITIONS) {
        if (budget !== undefined && budget <= 0) {
          results.push({
            partition,
            scanned: 0,
            evictable: 0,
            deleted: 0,
            clamped: true,
          });
          continue;
        }

        let rows: Array<{ id?: string; roomId: string; createdAt?: number }>;
        try {
          rows = await adapter.getMemories({
            agentId: this.runtime.agentId,
            tableName: partition,
            limit: SCAN_LIMIT,
            orderBy: "createdAt",
            orderDirection: "asc",
          });
        } catch (err) {
          // A partition that doesn't exist / errors must not abort the sweep.
          logger.debug(
            `[memory-retention] partition ${partition} query failed (${(err as Error)?.message}); skipping`,
          );
          continue;
        }

        const retainable: RetainableRow[] = [];
        for (const r of rows) {
          if (!r.id) continue;
          retainable.push({
            id: r.id,
            roomId: r.roomId,
            createdAt:
              typeof r.createdAt === "number" ? r.createdAt : Date.now(),
          });
        }

        const plan = planRetention(
          retainable,
          {
            retentionDays: this.retentionConfig.retentionDays,
            maxRowsPerRoom: this.retentionConfig.maxRowsPerRoom,
            maxDeletePerSweep: budget,
          },
          Date.now(),
        );

        let deleted = 0;
        if (plan.deleteIds.length > 0) {
          await adapter.deleteManyMemories(plan.deleteIds);
          deleted = plan.deleteIds.length;
          if (budget !== undefined) budget -= deleted;
        }

        results.push({
          partition,
          scanned: retainable.length,
          evictable: plan.evictable,
          deleted,
          clamped: plan.clamped,
        });

        if (deleted > 0) {
          logger.info(
            `[memory-retention] ${partition}: scanned=${retainable.length} evictable=${plan.evictable} deleted=${deleted}${plan.clamped ? " (clamped, more next sweep)" : ""}`,
          );
        }
      }
    } catch (err) {
      logger.error(
        `[memory-retention] sweep failed: ${(err as Error)?.message}`,
      );
    } finally {
      this.sweeping = false;
    }
    return results;
  }
}

/** Resolve the registered service, or null when retention isn't installed. */
export function resolveMemoryRetentionService(
  runtime: IAgentRuntime,
): MemoryRetentionService | null {
  return runtime.getService<MemoryRetentionService>(MEMORY_RETENTION_SERVICE);
}
