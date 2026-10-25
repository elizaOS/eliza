/** Owned development children, composed with the existing group shutdown drain.
 * No restart, discovery, process adoption or application readiness policy.
 */
import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import {
  isSpawnedProcessGroupAlive,
  signalSpawnedProcessGroup,
} from "./kill-process-tree.ts";
import { drainSpawnedChildren } from "./shutdown-drain.ts";

export function createDevelopmentProcessScope(options: {
  cwd: string;
  drainWindowMs: number;
  onUnexpectedExit: (result: {
    name: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnFailed: boolean;
  }) => void;
}) {
  if (
    !Number.isSafeInteger(options.drainWindowMs) ||
    options.drainWindowMs <= 0 ||
    options.drainWindowMs > 2_147_483_647
  )
    throw new RangeError("Drain window must be a positive Node timer value");
  const controller = new AbortController();
  const owned: { name: string; child: ChildProcess }[] = [];
  const closed = new WeakMap<ChildProcess, Promise<void>>();
  let stopping = false;
  let stopPromise: ReturnType<typeof drainSpawnedChildren> | undefined;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    // Publish the promise before abort callbacks can reenter stop().
    stopPromise = Promise.resolve().then(() =>
      drainSpawnedChildren({
        children: [...owned].reverse(),
        drainWindowMs: options.drainWindowMs,
        signalTree: signalSpawnedProcessGroup,
        isTargetAlive: isSpawnedProcessGroupAlive,
      }),
    );
    controller.abort(new Error("Development process scope stopped"));
    return stopPromise;
  };
  const onSignal = () => {
    void stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return {
    signal: controller.signal,
    get stopping() {
      return stopping;
    },
    stop,
    launch(
      name: string,
      command: string,
      args: string[],
      environment: NodeJS.ProcessEnv,
      stdio: SpawnOptions["stdio"] = "inherit",
    ) {
      controller.signal.throwIfAborted();
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: environment,
        stdio,
        detached: process.platform !== "win32",
      });
      owned.push({ name, child });
      closed.set(
        child,
        new Promise((resolve) => child.once("close", () => resolve())),
      );
      let reported = false;
      const failed = (
        code: number | null,
        signal: NodeJS.Signals | null,
        spawnFailed: boolean,
      ) => {
        if (stopping || reported) return;
        reported = true;
        // Begin stopping siblings before reporting host diagnostics.
        void stop();
        options.onUnexpectedExit({ name, code, signal, spawnFailed });
      };
      child.once("error", () => failed(null, null, true));
      child.once("exit", (code, signal) => failed(code, signal, false));
      return child;
    },
    waitForClose(child: ChildProcess) {
      const completion = closed.get(child);
      if (!completion)
        throw new Error("Child does not belong to this development scope");
      return completion;
    },
    async dispose() {
      try {
        return await stop();
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
    },
  };
}
