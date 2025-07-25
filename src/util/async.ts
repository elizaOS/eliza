export const delay = <T = undefined>(
  ms: number = 0,
  value: T = undefined as T
): Promise<T> =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

export async function isResolved(promise) {
  return await Promise.race([
    delay(0, false),
    promise.then(
      () => true,
      () => false
    ),
  ]);
}

export async function isRejected(promise) {
  return await Promise.race([
    delay(0, false),
    promise.then(
      () => false,
      () => true
    ),
  ]);
}

export async function isFinished(promise) {
  return await Promise.race([
    delay(0, false),
    promise.then(
      () => true,
      () => true
    ),
  ]);
}

export class Mutex {
  private locked: boolean;
  private queue: (() => void)[];

  constructor() {
    this.locked = false;
    this.queue = [];
  }

  async acquire() {
    return new Promise<void>((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next!();
    } else {
      this.locked = false;
    }
  }

  async runExclusive<T>(fn: () => Promise<T>) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
