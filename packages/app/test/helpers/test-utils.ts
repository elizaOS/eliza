/** Small utilities shared across test helpers. */

/** Saves env values and returns a restore handle. */
export function saveEnv(...keys: string[]): { restore: () => void } {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  return {
    restore() {
      for (const key of keys) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    },
  };
}

/** Snapshots env vars with `set`, `clear`, and `restore` helpers. */
export function envSnapshot(keys: string[]): {
  save: () => void;
  set: (key: string, value: string) => void;
  clear: () => void;
  restore: () => void;
} {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  return {
    save() {
      for (const key of keys) {
        saved[key] = process.env[key];
      }
    },
    set(key: string, value: string) {
      process.env[key] = value;
    },
    clear() {
      for (const key of keys) {
        delete process.env[key];
      }
    },
    restore() {
      for (const key of keys) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    },
  };
}

/** Rejects when a promise does not settle within the given timeout. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "Operation",
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

/** Delays for the requested number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Creates a promise with external resolve and reject functions. */
export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
