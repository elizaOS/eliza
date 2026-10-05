/**
 * Bounded round-robin scheduler that keeps each harness FIFO while rotating
 * service across harness lanes sharing one subscription-backed model boundary.
 */

export class QueueCapacityError extends Error {
  readonly code = "gateway_queue_full";

  constructor() {
    super("The Claude subscription gateway queue is full.");
    this.name = "QueueCapacityError";
  }
}

interface PendingJob<T> {
  enqueuedAt: number;
  run: (queueWaitMs: number) => Promise<T>;
  resolve: (result: QueuedResult<T>) => void;
  reject: (error: unknown) => void;
}

export interface QueuedResult<T> {
  value: T;
  queueWaitMs: number;
}

export interface FairHarnessQueueOptions {
  concurrency?: number;
  maxPending?: number;
  now?: () => number;
}

export class FairHarnessQueue {
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly lanes = new Map<string, PendingJob<unknown>[]>();
  private readonly ring: string[] = [];
  private lastServed: string | null = null;
  private runningCount = 0;
  private pendingCount = 0;

  constructor(options: FairHarnessQueueOptions = {}) {
    this.concurrency = positiveInteger(options.concurrency ?? 1, "concurrency");
    this.maxPending = positiveInteger(options.maxPending ?? 128, "maxPending");
    this.now = options.now ?? (() => performance.now());
  }

  enqueue<T>(
    harness: string,
    run: (queueWaitMs: number) => Promise<T>,
  ): Promise<QueuedResult<T>> {
    if (this.pendingCount >= this.maxPending) throw new QueueCapacityError();
    if (!this.lanes.has(harness)) {
      this.lanes.set(harness, []);
      this.ring.push(harness);
    }
    this.pendingCount += 1;
    const result = new Promise<QueuedResult<T>>((resolve, reject) => {
      const lane = this.lanes.get(harness);
      if (!lane)
        throw new Error(
          "[ClaudeSubscriptionGateway] queue lane was not initialized",
        );
      lane.push({
        enqueuedAt: this.now(),
        run,
        resolve: resolve as (result: QueuedResult<unknown>) => void,
        reject,
      });
    });
    this.drain();
    return result;
  }

  snapshot(): {
    concurrency: number;
    running: number;
    pending: number;
    harnesses: number;
  } {
    return {
      concurrency: this.concurrency,
      running: this.runningCount,
      pending: this.pendingCount,
      harnesses: this.ring.length,
    };
  }

  private drain(): void {
    while (this.runningCount < this.concurrency && this.pendingCount > 0) {
      const harness = this.nextHarness();
      if (!harness) return;
      const lane = this.lanes.get(harness);
      const job = lane?.shift();
      if (!job) continue;
      this.lastServed = harness;
      this.pendingCount -= 1;
      this.runningCount += 1;
      const queueWaitMs = Math.max(0, this.now() - job.enqueuedAt);
      void job
        .run(queueWaitMs)
        .then((value) => job.resolve({ value, queueWaitMs }), job.reject)
        .finally(() => {
          this.runningCount -= 1;
          this.drain();
        });
    }
  }

  private nextHarness(): string | null {
    if (this.ring.length === 0) return null;
    const lastIndex =
      this.lastServed === null ? -1 : this.ring.indexOf(this.lastServed);
    for (let offset = 1; offset <= this.ring.length; offset += 1) {
      const index = (lastIndex + offset + this.ring.length) % this.ring.length;
      const harness = this.ring[index];
      if ((this.lanes.get(harness)?.length ?? 0) > 0) return harness;
    }
    return null;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `[ClaudeSubscriptionGateway] ${label} must be a positive integer`,
    );
  }
  return value;
}
