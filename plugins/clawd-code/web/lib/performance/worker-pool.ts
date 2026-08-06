/**
 * Lightweight web worker pool. Keeps a fixed number of workers alive
 * and queues tasks when all workers are busy.
 */

interface WorkerTask<T> {
  payload: unknown;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  transferables?: Transferable[];
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
}

export class WorkerPool<T = unknown> {
  private slots: WorkerSlot[] = [];
  private queue: WorkerTask<T>[] = [];
  private readonly size: number;
  private readonly workerFactory: () => Worker;

  constructor(workerFactory: () => Worker, size = navigator.hardwareConcurrency ?? 2) {
    this.workerFactory = workerFactory;
    this.size = Math.min(size, 4); // Cap at 4 to avoid too many threads
  }

  private createSlot(): WorkerSlot {
    const worker = this.workerFactory();
    const slot: WorkerSlot = { worker, busy: false };
    return slot;
  }

  private getFreeSlot(): WorkerSlot | null {
    return this.slots.find((s) => !s.busy) ?? null;
  }

  private ensureSlots(): void {
    while (this.slots.length < this.size) {
      this.slots.push(this.createSlot());
    }
  }

  run(payload: unknown, transferables?: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.ensureSlots();
      const task: WorkerTask<T> = { payload, resolve, reject, transferables };
      const slot = this.getFreeSlot();
      if (slot) {
        this.dispatch(slot, task);
      } else {
        this.queue.push(task);
      }
    });
  }

  private dispatch(slot: WorkerSlot, task: WorkerTask<T>): void {
    slot.busy = true;

    const handleMessage = (e: MessageEvent) => {
      slot.worker.removeEventListener("message", handleMessage);
      slot.worker.removeEventListener("error", handleError);
      slot.busy = false;
      task.resolve(e.data as T);
      this.dequeue();
    };

    const handleError = (e: ErrorEvent) => {
      slot.worker.removeEventListener("message", handleMessage);
      slot.worker.removeEventListener("error", handleError);
      slot.busy = false;
      task.reject(new Error(e.message));
      this.dequeue();
    };

    slot.worker.addEventListener("message", handleMessage);
    slot.worker.addEventListener("error", handleError);

    if (task.transferables?.length) {
      slot.worker.postMessage(task.payload, task.transferables);
    } else {
      slot.worker.postMessage(task.payload);
    }
  }

  private dequeue(): void {
    if (!this.queue.length) return;
    const task = this.queue.shift()!;
    const slot = this.getFreeSlot();
    if (slot) this.dispatch(slot, task);
  }

  terminate(): void {
    for (const slot of this.slots) {
      slot.worker.terminate();
    }
    this.slots = [];
    this.queue = [];
  }
}

/**
 * Singleton pools lazily initialized per worker module URL.
 * Avoids spawning duplicate workers when multiple components
 * import the same pool.
 */
const pools = new Map<string, WorkerPool>();

export function getWorkerPool<T>(key: string, factory: () => Worker): WorkerPool<T> {
  if (!pools.has(key)) {
    pools.set(key, new WorkerPool<T>(factory));
  }
  return pools.get(key) as WorkerPool<T>;
}
