/**
 * Applies the host's opt-in memory retention policy through the core task clock.
 * Storage policy stays separate from scheduling; failures remain observable and
 * shutdown drains any sweep already in progress before releasing the service.
 */

import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  planRetention,
  policyIsActive,
  type ResolvedRetentionConfig,
  type RetainableRow,
  resolveRetentionConfig,
} from "./memory-retention.ts";

import { RetentionTask } from "./retention-task.ts";

export const MEMORY_RETENTION_SERVICE = "eliza_memory_retention";

const DEFAULT_INTERVAL_MINUTES = 360; // 6h

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

/** Legacy public adapter shape retained for existing type consumers; the service uses the canonical runtime contract. */
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

  private readonly retentionTask = new RetentionTask<SweepResult[]>(
    this.runtime,
    "HOST_MEMORY_RETENTION",
    () => this.sweepOnce(),
  );
  private retentionConfig: ResolvedRetentionConfig = {};

  static async start(runtime: IAgentRuntime): Promise<MemoryRetentionService> {
    const svc = new MemoryRetentionService(runtime);
    await svc.init();
    return svc;
  }

  private async init(): Promise<void> {
    this.retentionConfig = resolveRetentionConfig((key) => {
      const fromSettings = this.runtime.getSetting(key);
      if (fromSettings !== undefined && fromSettings !== null) {
        return String(fromSettings);
      }
      return process.env[key];
    });

    if (!policyIsActive(this.retentionConfig)) {
      await this.retentionTask.start(undefined);
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

    await this.retentionTask.start(intervalMinutes * 60 * 1000);
  }

  async stop(): Promise<void> {
    await this.retentionTask.stop();
  }

  /**
   * Run one sweep across all retention partitions. Re-entrancy-guarded so a
   * long sweep never overlaps the next tick. Returns per-partition results
   * (also useful in tests / ops probes).
   */
  sweep(): Promise<SweepResult[]> {
    return this.retentionTask.run(() => this.sweepOnce());
  }

  private async sweepOnce(): Promise<SweepResult[]> {
    if (!policyIsActive(this.retentionConfig)) return [];
    const results: SweepResult[] = [];
    try {
      const adapter = this.runtime.adapter;

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

        const rows = await adapter.getMemories({
          agentId: this.runtime.agentId,
          tableName: partition,
          includeEmbedding: false,
          orderBy: "createdAt",
          orderDirection: "asc",
        });

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
          const selected = new Set(plan.deleteIds);
          const ids = rows.flatMap((row) =>
            row.id && selected.has(row.id) ? [row.id] : [],
          );
          await this.runtime.deleteMemories(ids);
          deleted = ids.length;
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
    } catch (cause) {
      // error-policy:J2 TaskService or the direct caller owns failure reporting.
      throw new ElizaError("Unable to complete memory retention", {
        code: "MEMORY_RETENTION_FAILED",
        cause,
        context: { agentId: this.runtime.agentId },
      });
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
