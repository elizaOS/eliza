/**
 * Owns idempotent runtime teardown and the optional process-signal adapter.
 * Runtime construction publishes this lifecycle to hosts; only CLI/direct-run
 * boundaries install SIGINT/SIGTERM handlers or choose an exit code.
 */

export interface AgentProcessLifecycle {
  addTeardown(teardown: () => void | Promise<void>): () => void;
  dispose(reason?: string): Promise<void>;
}

export function createAgentProcessLifecycle(options: {
  disposeRuntime: (reason: string) => Promise<void>;
  disposeSandbox?: () => Promise<void>;
}): AgentProcessLifecycle {
  const teardowns = new Set<() => void | Promise<void>>();
  let disposePromise: Promise<void> | null = null;

  return {
    addTeardown(teardown) {
      if (disposePromise) {
        throw new Error("Cannot add teardown after lifecycle disposal started");
      }
      teardowns.add(teardown);
      return () => {
        teardowns.delete(teardown);
      };
    },
    async dispose(reason = "host shutdown") {
      if (!disposePromise) {
        const pendingTeardowns = [...teardowns].reverse();
        // Publish the shared promise before invoking any host callbacks. A
        // synchronous reentrant dispose must join this teardown, not start it again.
        disposePromise = Promise.resolve().then(async () => {
          const errors: unknown[] = [];
          for (const teardown of pendingTeardowns) {
            try {
              await teardown();
            } catch (error) {
              errors.push(error);
            }
          }
          if (options.disposeSandbox) {
            try {
              await options.disposeSandbox();
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            await options.disposeRuntime(reason);
          } catch (error) {
            errors.push(error);
          }
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              "Agent process lifecycle disposal failed",
            );
          }
        });
      }
      await disposePromise;
    },
  };
}

export function installProcessSignalHandlers(options: {
  lifecycle: AgentProcessLifecycle;
  onError: (error: unknown) => void;
  exit?: (code: number) => never;
}): () => void {
  const exit = options.exit ?? process.exit;
  let shutdownStarted = false;
  const shutdown = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void options.lifecycle.dispose("signal shutdown").then(
      () => exit(0),
      (error) => {
        try {
          options.onError(error);
        } finally {
          exit(1);
        }
      },
    );
  };
  // Keep both signal handlers installed until the drain selects the exit status.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
}
