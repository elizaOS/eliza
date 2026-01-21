/**
 * Trajectory context management for benchmark/training traces.
 *
 * Mirrors the streaming context design:
 * - Node.js: AsyncLocalStorage for async-safe propagation
 * - Browser: stack-based fallback
 */
export interface TrajectoryContext {
  trajectoryStepId?: string;
}

export interface ITrajectoryContextManager {
  run<T>(
    context: TrajectoryContext | undefined,
    fn: () => T | Promise<T>,
  ): T | Promise<T>;
  active(): TrajectoryContext | undefined;
}

class StackContextManager implements ITrajectoryContextManager {
  private stack: Array<TrajectoryContext | undefined> = [];

  run<T>(
    context: TrajectoryContext | undefined,
    fn: () => T | Promise<T>,
  ): T | Promise<T> {
    this.stack.push(context);
    try {
      return fn();
    } finally {
      this.stack.pop();
    }
  }

  active(): TrajectoryContext | undefined {
    return this.stack.length > 0
      ? this.stack[this.stack.length - 1]
      : undefined;
  }
}

let globalContextManager: ITrajectoryContextManager | null = null;
let contextManagerInitialized = false;

function isNodeEnvironment(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions !== "undefined" &&
    typeof process.versions.node !== "undefined"
  );
}

async function createContextManager(): Promise<ITrajectoryContextManager> {
  if (isNodeEnvironment()) {
    try {
      // Dynamic import to avoid bundling Node.js code in browser builds
      const { AsyncLocalStorage } = await import("node:async_hooks");
      return {
        storage: new AsyncLocalStorage<TrajectoryContext | undefined>(),
        run<T>(
          context: TrajectoryContext | undefined,
          fn: () => T | Promise<T>,
        ): T | Promise<T> {
          return (
            this as {
              storage: InstanceType<
                typeof AsyncLocalStorage<TrajectoryContext | undefined>
              >;
            }
          ).storage.run(context, fn);
        },
        active(): TrajectoryContext | undefined {
          return (
            this as {
              storage: InstanceType<
                typeof AsyncLocalStorage<TrajectoryContext | undefined>
              >;
            }
          ).storage.getStore();
        },
      } as ITrajectoryContextManager & {
        storage: InstanceType<
          typeof AsyncLocalStorage<TrajectoryContext | undefined>
        >;
      };
    } catch {
      return new StackContextManager();
    }
  }
  return new StackContextManager();
}

function getOrCreateContextManager(): ITrajectoryContextManager {
  if (!globalContextManager) {
    globalContextManager = new StackContextManager();

    if (isNodeEnvironment() && !contextManagerInitialized) {
      contextManagerInitialized = true;
      createContextManager()
        .then((manager) => {
          globalContextManager = manager;
        })
        .catch(() => {
          // Keep using StackContextManager
        });
    }
  }
  return globalContextManager;
}

export function setTrajectoryContextManager(
  manager: ITrajectoryContextManager,
): void {
  globalContextManager = manager;
  contextManagerInitialized = true;
}

export function getTrajectoryContextManager(): ITrajectoryContextManager {
  return getOrCreateContextManager();
}

export function runWithTrajectoryContext<T>(
  context: TrajectoryContext | undefined,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return getOrCreateContextManager().run(context, fn);
}

export function getTrajectoryContext(): TrajectoryContext | undefined {
  return getOrCreateContextManager().active();
}
