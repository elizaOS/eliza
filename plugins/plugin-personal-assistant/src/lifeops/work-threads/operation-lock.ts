/**
 * Per-key FIFO locks for work-thread state changes. The WORK_THREAD action
 * holds a thread's lock while it commits a stop, completion or follow-up
 * replacement, and the scheduler holds the same lock while it admits and
 * fires that thread's follow-up, so a follow-up can never be claimed between
 * a thread-state read and a concurrent commit of the thread.
 */
const workThreadOperationQueues = new Map<string, Promise<void>>();

export function workThreadLockKey(workThreadId: string): string {
  return `thread:${workThreadId}`;
}

export async function withWorkThreadOperationLocks<T>(
  keys: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  if (keys.length === 0) {
    return operation();
  }
  const releases: Array<() => void> = [];
  for (const key of keys) {
    const previous = workThreadOperationQueues.get(key) ?? Promise.resolve();
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    workThreadOperationQueues.set(key, tail);
    await previous;
    releases.push(() => {
      releaseCurrent();
      if (workThreadOperationQueues.get(key) === tail) {
        workThreadOperationQueues.delete(key);
      }
    });
  }
  try {
    return await operation();
  } finally {
    for (const release of releases.reverse()) {
      release();
    }
  }
}
