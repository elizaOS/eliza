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
      disposePromise ??= (async () => {
        const errors: unknown[] = [];
        for (const teardown of [...teardowns].reverse()) {
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
      })();
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
    void options.lifecycle
      .dispose("signal shutdown")
      .catch((error) => {
        options.onError(error);
      })
      .then(() => exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
}
