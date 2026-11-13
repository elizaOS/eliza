/** Lifecycle regressions include a real child process to prove failed-start cleanup. */
import { describe, expect, test } from "bun:test";
import {
  AgentMutationQueue,
  settleBeforeDeadline,
  startAndPublishRuntime,
} from "./agent-lifecycle";

describe("hosted agent lifecycle ownership", () => {
  for (const failedPhase of ["initialize", "publish"] as const) {
    test(`a failed ${failedPhase} stops the allocated runtime`, async () => {
      const child = Bun.spawn(
        [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const failure = new Error(`${failedPhase} failed`);
      let retained = false;
      const runtime = {
        async stop() {
          child.kill();
          await child.exited;
        },
      };
      try {
        await expect(
          startAndPublishRuntime(
            runtime,
            async () => {
              if (failedPhase === "initialize") throw failure;
            },
            async () => {
              if (failedPhase === "publish") throw failure;
            },
            () => {
              retained = true;
            },
          ),
        ).rejects.toBe(failure);
        expect(await child.exited).not.toBe(0);
        expect(retained).toBe(false);
      } finally {
        child.kill();
        await child.exited;
      }
    });
  }

  test("a failed cleanup retains its runtime for a later stop retry", async () => {
    const startupFailure = new Error("startup failed");
    const cleanupFailure = new Error("stop failed");
    const runtime = {
      async stop() {
        throw cleanupFailure;
      },
    };
    let retained: typeof runtime | undefined;
    let thrown: unknown;
    try {
      await startAndPublishRuntime(
        runtime,
        async () => {
          throw startupFailure;
        },
        async () => {},
        (value) => {
          retained = value;
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(retained).toBe(runtime);
    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError))
      throw new Error("Missing aggregate failure");
    expect(thrown.errors).toEqual([startupFailure, cleanupFailure]);
  });

  test("delete waits for an older stop so that late completion cannot resurrect the agent", async () => {
    const queue = new AgentMutationQueue();
    const gate = Promise.withResolvers<void>();
    const states: string[] = [];
    const stop = queue.run("agent", async () => {
      states.push("stopping");
      await gate.promise;
      states.push("stopped");
    });
    const remove = queue.run("agent", async () => {
      states.push("deleted");
    });
    await queue.run("other-agent", async () => {
      states.push("other-running");
    });
    expect(states).toEqual(["stopping", "other-running"]);
    gate.resolve();
    await Promise.all([stop, remove]);
    expect(states).toEqual(["stopping", "other-running", "stopped", "deleted"]);
  });

  test("a rejected mutation leaves the next owner eligible to retry", async () => {
    const queue = new AgentMutationQueue();
    const first = queue.run("agent", async () => {
      throw new Error("failed");
    });
    const second = queue.run("agent", async () => "retried");
    await expect(first).rejects.toThrow("failed");
    expect(await second).toBe("retried");
  });

  test("a stuck mutation cannot extend the shutdown deadline", async () => {
    const gate = Promise.withResolvers<void>();
    expect(
      await settleBeforeDeadline(gate.promise, performance.now() - 1),
    ).toBe(false);
    // The timed-out work remains observed even if its eventual result is a failure.
    gate.reject(new Error("late failure"));
    await Promise.resolve();
  });
});
