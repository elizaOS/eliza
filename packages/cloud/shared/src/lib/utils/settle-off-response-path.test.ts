// Exercises settle off response path behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { settleOffResponsePath } from "./settle-off-response-path";

/**
 * #8759 — the chat-completions billing/settlement chain runs OFF the response
 * hot path. settleOffResponsePath defers to executionCtx.waitUntil when present
 * (response returns before the chain settles) and falls back to inline await
 * otherwise. Previously entirely untested.
 */
describe("settleOffResponsePath (#8759 defer-billing)", () => {
  test("defers via waitUntil and resolves BEFORE the task settles", async () => {
    const waited: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
    };

    let taskSettled = false;
    let release = (): void => {};
    const task = () =>
      new Promise<void>((resolve) => {
        release = () => {
          taskSettled = true;
          resolve();
        };
      });

    await settleOffResponsePath(executionCtx, task);

    // The response path is unblocked: settleOffResponsePath resolved while the
    // billing task is still pending.
    expect(taskSettled).toBe(false);
    expect(waited).toHaveLength(1);

    // The deferred task DID start and waitUntil holds its promise.
    release();
    await waited[0];
    expect(taskSettled).toBe(true);
  });

  test("runs the task INLINE (awaited) when there is no executionCtx", async () => {
    let taskSettled = false;
    await settleOffResponsePath(undefined, async () => {
      await Promise.resolve();
      taskSettled = true;
    });
    // No waitUntil to defer to → the helper awaited the task before returning.
    expect(taskSettled).toBe(true);
  });

  test("runs inline when executionCtx has no waitUntil function", async () => {
    let taskSettled = false;
    await settleOffResponsePath({} as never, async () => {
      taskSettled = true;
    });
    expect(taskSettled).toBe(true);
  });

  test("inline mode propagates a task rejection to the caller", async () => {
    await expect(
      settleOffResponsePath(undefined, async () => {
        throw new Error("billUsage failed");
      }),
    ).rejects.toThrow("billUsage failed");
  });

  test("deferred mode hands the (possibly rejecting) task promise to waitUntil, not the response path", async () => {
    // A rejecting deferred task must NOT reject the response path — it is owned
    // by waitUntil. settleOffResponsePath itself resolves cleanly.
    const captured: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => {
        captured.push(p);
      },
    };
    await expect(
      settleOffResponsePath(executionCtx, async () => {
        throw new Error("deferred billUsage failed");
      }),
    ).resolves.toBeUndefined();
    expect(captured).toHaveLength(1);
    // The rejection lives on the waitUntil promise (consume it so it isn't unhandled).
    await expect(captured[0]).rejects.toThrow("deferred billUsage failed");
  });
});
