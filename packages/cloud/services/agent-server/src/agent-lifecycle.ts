/** Serializes mutations of one hosted agent and retains failed cleanup ownership. */
export class AgentMutationQueue {
  private readonly pending = new Map<string, Promise<void>>();

  run<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(agentId);
    // Run the first operation immediately so its capacity reservation is visible
    // before another request can start. Later operations wait for their owner.
    const current = previous
      ? previous.then(operation, operation)
      : operation();
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(agentId, settled);
    void settled.then(() => {
      if (this.pending.get(agentId) === settled) this.pending.delete(agentId);
    });
    return current;
  }
}

/** Observe queued work until an absolute performance.now() deadline. */
export async function settleBeforeDeadline(
  work: Promise<unknown>,
  deadline: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function startAndPublishRuntime<
  T extends { stop(): Promise<void> },
>(
  runtime: T,
  start: (runtime: T) => Promise<void>,
  publish: (runtime: T) => Promise<void>,
  retainFailedCleanup: (runtime: T) => void,
): Promise<void> {
  try {
    await start(runtime);
    await publish(runtime);
  } catch (failure) {
    try {
      await runtime.stop();
    } catch (cleanupFailure) {
      // Keep the runtime reachable for a later stop/drain retry. Losing its
      // reference here would leak the allocation while freeing its capacity.
      retainFailedCleanup(runtime);
      throw new AggregateError(
        [failure, cleanupFailure],
        "Agent startup and cleanup failed",
      );
    }
    throw failure;
  }
}
