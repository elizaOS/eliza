export class AsyncQueue {
  private queue: (() => Promise<void>)[] = [];
  private running = 0;
  private emptyListeners: (() => void)[] = [];
  private maxConcurrent: number;

  constructor(maxConcurrent: number = 1) {
    this.maxConcurrent = maxConcurrent;
  }

  async submit<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await work());
        } catch (err) {
          reject(err);
        }
      });
      void this.doNextWork();
    });
  }

  private async doNextWork(): Promise<void> {
    if (this.running >= this.maxConcurrent) {
      return;
    }

    const work = this.queue.shift();
    if (!work) {
      this.checkIfEmptyAndNotify();
      return;
    }

    this.running++;
    try {
      await work();
    } catch (err) {
      // Error handling without logging
    } finally {
      this.running--;
      void this.doNextWork();
    }
  }

  async size(): Promise<number> {
    return this.queue.length;
  }

  async waitUntilFinished(): Promise<void> {
    return new Promise((resolve) => {
      if (this.queue.length === 0 && this.running === 0) {
        resolve();
      } else {
        this.emptyListeners.push(resolve);
      }
    });
  }

  private checkIfEmptyAndNotify(): void {
    if (this.queue.length === 0 && this.running === 0) {
      while (this.emptyListeners.length) {
        const listener = this.emptyListeners.shift();
        if (listener) listener();
      }
    }
  }
}
