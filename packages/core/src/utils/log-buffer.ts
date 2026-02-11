import { createLogger } from '../logger';
import type { IDatabaseAdapter, LogWriteParams } from '../types';

const LOG_FLUSH_THRESHOLD = 10;
const LOG_FLUSH_INTERVAL_MS = 5_000;

const logger = createLogger({ namespace: 'log-buffer' });

export class LogBuffer {
  private entries: LogWriteParams[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private destroyed = false;

  constructor(private readonly getAdapter: () => IDatabaseAdapter) {}

  push(entry: LogWriteParams): void {
    if (this.destroyed) return;
    this.entries.push(entry);

    if (this.entries.length >= LOG_FLUSH_THRESHOLD) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  async flush(): Promise<void> {
    while (this.flushing) {
      await this.flushing;
    }

    if (this.entries.length === 0) return;

    this.clearTimer();
    this.flushing = (async () => {
      while (this.entries.length > 0) {
        const batch = this.entries;
        this.entries = [];
        await this.writeBatch(batch);
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.clearTimer();
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, LOG_FLUSH_INTERVAL_MS);
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async writeBatch(batch: LogWriteParams[]): Promise<void> {
    const adapter = this.getAdapter();
    try {
      let logBatchFn: IDatabaseAdapter['logBatch'] | undefined;
      try {
        logBatchFn = adapter.logBatch;
      } catch (error) {
        logger.warn(
          {
            src: 'agent',
            count: batch.length,
            error: error instanceof Error ? error.message : String(error),
          },
          'logBatch unavailable, using per-entry writes'
        );
      }

      if (typeof logBatchFn === 'function') {
        try {
          await logBatchFn.call(adapter, batch);
          return;
        } catch (error) {
          const failedEntries =
            error &&
            typeof error === 'object' &&
            Array.isArray((error as { failedEntries?: unknown }).failedEntries)
              ? ((error as { failedEntries: LogWriteParams[] }).failedEntries ?? [])
              : batch;

          logger.warn(
            {
              src: 'agent',
              count: batch.length,
              fallbackCount: failedEntries.length,
              error: error instanceof Error ? error.message : String(error),
            },
            'logBatch failed, using per-entry writes'
          );

          const writeResults = await Promise.allSettled(
            failedEntries.map((entry) => adapter.log(entry))
          );
          const failedWrites = writeResults.filter((result) => result.status === 'rejected').length;
          if (failedWrites > 0) {
            logger.warn(
              {
                src: 'agent',
                attempted: failedEntries.length,
                failed: failedWrites,
              },
              'Fallback log writes failed'
            );
          }
          return;
        }
      }

      const writeResults = await Promise.allSettled(batch.map((entry) => adapter.log(entry)));
      const failedWrites = writeResults.filter((result) => result.status === 'rejected').length;
      if (failedWrites > 0) {
        logger.warn(
          {
            src: 'agent',
            attempted: batch.length,
            failed: failedWrites,
          },
          'Fallback log writes failed'
        );
      }
    } catch (error) {
      logger.warn(
        {
          src: 'agent',
          count: batch.length,
          error: error instanceof Error ? error.message : String(error),
        },
        'Unexpected failure while writing log batch'
      );
    }
  }
}
