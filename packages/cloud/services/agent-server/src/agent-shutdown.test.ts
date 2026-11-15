import { describe, expect, spyOn, test } from "bun:test";
import {
  AgentShutdownTimeoutError,
  shutdownBeforeDeadline,
} from "./agent-shutdown";

describe("agent-server shutdown deadline", () => {
  test("successful phases share one deadline and close cleanly", async () => {
    const calls: string[] = [];
    const failed = await shutdownBeforeDeadline(
      {
        drain: async () => {
          calls.push("drain");
        },
        cleanup: async () => {
          calls.push("cleanup");
        },
        quit: async () => {
          calls.push("quit");
        },
        disconnect: () => {
          calls.push("disconnect");
        },
        onFailure: () => {
          calls.push("failed");
        },
      },
      performance.now() + 1000,
    );
    expect(failed).toBe(false);
    expect(calls).toEqual(["drain", "cleanup", "quit"]);
  });

  for (const stalledPhase of ["drain", "cleanup", "quit"] as const) {
    test(`a stalled ${stalledPhase} cannot extend shutdown`, async () => {
      const pending = Promise.withResolvers<void>();
      const calls: string[] = [];
      const failures: unknown[] = [];
      const step = async (phase: string) => {
        calls.push(phase);
        if (phase === stalledPhase) await pending.promise;
      };
      const failed = await shutdownBeforeDeadline(
        {
          drain: () => step("drain"),
          cleanup: () => step("cleanup"),
          quit: () => step("quit"),
          disconnect: () => {
            calls.push("disconnect");
          },
          onFailure: (_phase, error) => {
            failures.push(error);
          },
        },
        performance.now() + 20,
      );
      expect(failed).toBe(true);
      expect(calls.at(-1)).toBe("disconnect");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(AgentShutdownTimeoutError);
      expect((failures[0] as AgentShutdownTimeoutError).phase).toBe(
        stalledPhase,
      );
      expect(calls).toHaveLength(
        ["drain", "cleanup", "quit"].indexOf(stalledPhase) + 2,
      );
      // The already-timed-out work stays observed when it eventually rejects.
      pending.reject(new Error("late failure"));
      await Promise.resolve();
    });
  }

  test("an expired overall deadline starts no new work", async () => {
    const calls: string[] = [];
    const failed = await shutdownBeforeDeadline(
      {
        drain: async () => {
          calls.push("drain");
        },
        cleanup: async () => {
          calls.push("cleanup");
        },
        quit: async () => {
          calls.push("quit");
        },
        disconnect: () => {
          calls.push("disconnect");
        },
        onFailure: () => {},
      },
      performance.now() - 1,
    );
    expect(failed).toBe(true);
    expect(calls).toEqual(["disconnect"]);
  });

  test("time consumed by drain is not granted again to cleanup", async () => {
    let clock = 1000;
    const now = spyOn(performance, "now").mockImplementation(() => clock);
    const calls: string[] = [];
    try {
      const failed = await shutdownBeforeDeadline(
        {
          drain: async () => {
            calls.push("drain");
            clock = 2000;
          },
          cleanup: async () => {
            calls.push("cleanup");
          },
          quit: async () => {
            calls.push("quit");
          },
          disconnect: () => {
            calls.push("disconnect");
          },
          onFailure: () => {},
        },
        2000,
      );
      expect(failed).toBe(true);
      expect(calls).toEqual(["drain", "disconnect"]);
    } finally {
      now.mockRestore();
    }
  });

  test("errors retain a failing exit result while later cleanup is attempted", async () => {
    const calls: string[] = [];
    const failed = await shutdownBeforeDeadline(
      {
        drain: async () => {
          calls.push("drain");
          throw new Error("drain failed");
        },
        cleanup: async () => {
          calls.push("cleanup");
        },
        quit: async () => {
          calls.push("quit");
          throw new Error("quit failed");
        },
        disconnect: () => {
          calls.push("disconnect");
        },
        onFailure: (phase) => {
          calls.push(`failed:${phase}`);
        },
      },
      performance.now() + 1000,
    );
    expect(failed).toBe(true);
    expect(calls).toEqual([
      "drain",
      "failed:drain",
      "cleanup",
      "quit",
      "failed:quit",
      "disconnect",
    ]);
  });

  test("a wall-clock rollback cannot extend the elapsed shutdown deadline", async () => {
    let wallClock = 1000;
    let elapsed = 1000;
    const wallNow = spyOn(Date, "now").mockImplementation(() => wallClock);
    const elapsedNow = spyOn(performance, "now").mockImplementation(
      () => elapsed,
    );
    const calls: string[] = [];
    const failures: unknown[] = [];
    try {
      const failed = await shutdownBeforeDeadline(
        {
          drain: async () => {
            calls.push("drain");
            wallClock = -10_000;
            elapsed = 2000;
          },
          cleanup: async () => {
            calls.push("cleanup");
          },
          quit: async () => {
            calls.push("quit");
          },
          disconnect: () => {
            calls.push("disconnect");
          },
          onFailure: (_phase, error) => {
            failures.push(error);
          },
        },
        2000,
      );
      expect(failed).toBe(true);
      expect(calls).toEqual(["drain", "disconnect"]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(AgentShutdownTimeoutError);
      expect((failures[0] as AgentShutdownTimeoutError).phase).toBe("cleanup");
    } finally {
      elapsedNow.mockRestore();
      wallNow.mockRestore();
    }
  });
});
