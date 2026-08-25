/**
 * Direct unit coverage for `runCommandWithRuntime`: success, default
 * error-and-exit reporting, throwable stringification, and the optional
 * `onError` callback branch.
 *
 * The harness drives the real helper with in-memory runtime recorders. It
 * does not mock the module under test.
 */
import { describe, expect, it } from "vitest";
import { runCommandWithRuntime } from "./cli-utils";

function createRuntime() {
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    errors,
    exits,
    runtime: {
      error: (message: string) => {
        errors.push(message);
      },
      exit: (code: number) => {
        exits.push(code);
      },
    },
  };
}

describe("runCommandWithRuntime", () => {
  it("awaits a successful action and does not report or exit", async () => {
    const { errors, exits, runtime } = createRuntime();
    const order: string[] = [];

    await runCommandWithRuntime(runtime, async () => {
      order.push("start");
      await Promise.resolve();
      order.push("done");
    });

    expect(order).toEqual(["start", "done"]);
    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("does not invoke onError when the action resolves", async () => {
    const { errors, exits, runtime } = createRuntime();
    const onErrorCalls: unknown[] = [];

    await runCommandWithRuntime(
      runtime,
      async () => undefined,
      (err) => {
        onErrorCalls.push(err);
      },
    );

    expect(onErrorCalls).toEqual([]);
    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("stringifies a thrown Error and exits with code 1 when onError is omitted", async () => {
    const { errors, exits, runtime } = createRuntime();

    await runCommandWithRuntime(runtime, async () => {
      throw new Error("boom");
    });

    expect(errors).toEqual(["Error: boom"]);
    expect(exits).toEqual([1]);
  });

  it("reports then exits, in that order, on the default failure path", async () => {
    const events: string[] = [];
    const runtime = {
      error: (message: string) => {
        events.push(`error:${message}`);
      },
      exit: (code: number) => {
        events.push(`exit:${code}`);
      },
    };

    await runCommandWithRuntime(runtime, async () => {
      throw new Error("ordered");
    });

    expect(events).toEqual(["error:Error: ordered", "exit:1"]);
  });

  it("stringifies a thrown string the same way String(err) does", async () => {
    const { errors, exits, runtime } = createRuntime();

    await runCommandWithRuntime(runtime, async () => {
      throw "plain failure";
    });

    expect(errors).toEqual(["plain failure"]);
    expect(exits).toEqual([1]);
  });

  it("stringifies non-Error throwables including numbers and objects", async () => {
    const numberCase = createRuntime();
    await runCommandWithRuntime(numberCase.runtime, async () => {
      throw 42;
    });
    expect(numberCase.errors).toEqual(["42"]);
    expect(numberCase.exits).toEqual([1]);

    const objectCase = createRuntime();
    await runCommandWithRuntime(objectCase.runtime, async () => {
      throw { reason: "nope" };
    });
    expect(objectCase.errors).toEqual(["[object Object]"]);
    expect(objectCase.exits).toEqual([1]);
  });

  it("delegates to onError with the original throwable and does not report or exit", async () => {
    const { errors, exits, runtime } = createRuntime();
    const received: unknown[] = [];
    const failure = new Error("delegated");

    await runCommandWithRuntime(
      runtime,
      async () => {
        throw failure;
      },
      (err) => {
        received.push(err);
      },
    );

    expect(received).toEqual([failure]);
    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("returns after onError without rethrowing the original failure", async () => {
    const { runtime } = createRuntime();

    await expect(
      runCommandWithRuntime(
        runtime,
        async () => {
          throw new Error("swallowed");
        },
        () => {},
      ),
    ).resolves.toBeUndefined();
  });

  it("does not catch throws from onError, and never reaches runtime.error/exit", async () => {
    const { errors, exits, runtime } = createRuntime();
    const callbackError = new Error("onError failed");

    await expect(
      runCommandWithRuntime(
        runtime,
        async () => {
          throw new Error("original");
        },
        () => {
          throw callbackError;
        },
      ),
    ).rejects.toBe(callbackError);

    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
  });
});
