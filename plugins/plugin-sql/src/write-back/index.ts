/**
 * WriteBackService — implements Electric's Pattern 1 (Online Writes).
 *
 * When an agent writes to its local PGlite, this service asynchronously
 * forwards the write to the cloud API, which inserts it into the central
 * Postgres. Electric then syncs the confirmed row back to PGlite via the
 * existing syncShapesToTables read path, completing the round-trip.
 *
 * Writes are fire-and-forget — the agent never blocks on the HTTP POST.
 * A small in-memory queue batches writes that arrive while a flush is
 * in-flight, avoiding duplicate concurrent POSTs. Writes that fail are
 * retried up to MAX_RETRIES times, then dropped with a warning log.
 *
 * Configured via:
 *   ELIZA_CLOUD_WRITE_BASE_URL — base URL of the cloud API, e.g.
 *     https://api.elizacloud.ai. The agentId is appended at runtime:
 *     {base}/api/v1/eliza/agents/{agentId}/write
 *   ELIZA_CLOUD_SERVICE_KEY — X-Service-Key value (WAIFU_SERVICE_KEY)
 *
 * If neither env var is set, the service is a no-op.
 */

import { logger } from "@elizaos/core";

const MAX_BATCH = 100;
const FLUSH_DEBOUNCE_MS = 200;
const MAX_RETRIES = 5;

interface PendingWrite {
  table: string;
  operation: "insert" | "upsert" | "delete";
  row: Record<string, unknown>;
  writeId: string;
  retries: number;
}

export interface WriteBackOptions {
  /** Base URL of the cloud API. AgentId is appended at runtime. */
  writeBaseUrl?: string | null;
  /** Agent UUID for constructing the write endpoint URL. */
  agentId?: string | null;
  /** X-Service-Key value for authentication. */
  serviceKey?: string | null;
}

function buildWriteUrl(baseUrl: string, agentId: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/api/v1/eliza/agents/${agentId}/write`;
}

export class WriteBackService {
  private writeUrl: string | null;
  private serviceKey: string | null;
  private queue: PendingWrite[] = [];
  private flushing = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Incrementing counter ensures unique writeIds even without crypto. */
  private writeCounter = 0;

  constructor(opts: WriteBackOptions = {}) {
    const baseUrl = opts.writeBaseUrl ?? process.env.ELIZA_CLOUD_WRITE_BASE_URL ?? null;
    const key = opts.serviceKey ?? process.env.ELIZA_CLOUD_SERVICE_KEY ?? null;
    const agentId = opts.agentId ?? process.env.AGENT_ID ?? null;

    if (baseUrl && agentId && key) {
      this.writeUrl = buildWriteUrl(baseUrl, agentId);
      this.serviceKey = key;
    } else {
      this.writeUrl = null;
      this.serviceKey = null;
    }
  }

  /** Whether the service is configured and active. */
  get enabled(): boolean {
    return !!this.writeUrl && !!this.serviceKey;
  }

  /**
   * Enqueue a write to be forwarded to the cloud API.
   * Returns immediately; the write is flushed asynchronously.
   */
  enqueue(
    table: string,
    operation: "insert" | "upsert" | "delete",
    row: Record<string, unknown>
  ): void {
    if (!this.enabled) return;

    this.writeCounter++;
    const writeId = `${Date.now()}-${this.writeCounter}`;

    this.queue.push({ table, operation, row, writeId, retries: 0 });

    if (this.queue.length >= MAX_BATCH) {
      this.scheduleFlush(0);
    } else {
      this.scheduleFlush(FLUSH_DEBOUNCE_MS);
    }
  }

  /**
   * Flush all pending writes synchronously. Waits for any in-progress
   * drain to complete, then picks up any remaining items.
   * Used during shutdown to drain the queue before the agent exits.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Wait for in-progress drain, then drain any stragglers.
    while (this.queue.length > 0) {
      if (!this.flushing) {
        await this.drainQueue();
      }
      // Brief yield to let an in-progress drain complete.
      await new Promise((r) => setTimeout(r, 10));
    }
    // One final drain in case items were added during the yield.
    if (!this.flushing) {
      await this.drainQueue();
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.drainQueue().catch(() => {
        // Errors logged inside drainQueue / sendBatch.
      });
    }, delayMs);
  }

  private async drainQueue(): Promise<void> {
    if (this.flushing) return;
    if (this.queue.length === 0) return;
    if (!this.enabled) {
      this.queue = [];
      return;
    }

    this.flushing = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_BATCH);
        await this.sendBatch(batch);
      }
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) {
        this.scheduleFlush(0);
      }
    }
  }

  private async sendBatch(batch: PendingWrite[]): Promise<void> {
    // Guard: only called from drainQueue which checks this.enabled, but
    // this avoids the non-null assertions that Biome flags.
    if (!this.writeUrl || !this.serviceKey) {
      logger.warn(
        { src: "plugin:sql" },
        "WriteBackService: sendBatch called while not configured — dropping batch"
      );
      return;
    }

    try {
      const response = await fetch(this.writeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Key": this.serviceKey,
        },
        body: JSON.stringify({ writes: batch }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        logger.warn(
          { src: "plugin:sql", status: response.status },
          `WriteBackService: cloud API returned ${response.status}: ${text.slice(0, 200)}`
        );
        this.requeueOrDrop(batch);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { src: "plugin:sql", error: msg },
        "WriteBackService: failed to send write batch — retrying"
      );
      this.requeueOrDrop(batch);
    }
  }

  private requeueOrDrop(batch: PendingWrite[]): void {
    const toRetry: PendingWrite[] = [];
    for (const write of batch) {
      write.retries++;
      if (write.retries <= MAX_RETRIES) {
        toRetry.push(write);
      } else {
        logger.warn(
          {
            src: "plugin:sql",
            table: write.table,
            writeId: write.writeId,
            retries: write.retries,
          },
          "WriteBackService: dropping write after max retries"
        );
      }
    }
    if (toRetry.length > 0) {
      // Re-queue at the front so older writes retry first.
      this.queue.unshift(...toRetry);
    }
  }
}
