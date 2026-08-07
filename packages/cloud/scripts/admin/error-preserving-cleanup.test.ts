/**
 * Verifies that teardown remains observable and ordered without obscuring the
 * error that triggered it, including when more than one cleanup step fails.
 */

import { describe, expect, test } from "bun:test";
import {
  type CleanupFailure,
  runCleanupSteps,
  runWithCleanup,
} from "./error-preserving-cleanup";

describe("error-preserving cleanup", () => {
  test("retains the primary error while reporting every cleanup failure", async () => {
    const primary = new Error("primary migration failure");
    const unlock = new Error("unlock failed");
    const close = new Error("close failed");
    const observed: CleanupFailure[] = [];
    const cleanupOrder: string[] = [];

    const result = runWithCleanup(
      async () => {
        throw primary;
      },
      [
        {
          label: "advisory unlock",
          run: async () => {
            cleanupOrder.push("unlock");
            throw unlock;
          },
        },
        {
          label: "client close",
          run: async () => {
            cleanupOrder.push("close");
            throw close;
          },
        },
      ],
      (failure) => observed.push(failure),
    );

    await expect(result).rejects.toBe(primary);
    expect(cleanupOrder).toEqual(["unlock", "close"]);
    expect(observed.map((failure) => failure.cleanupError)).toEqual([
      unlock,
      close,
    ]);
    expect(
      observed.every((failure) => failure.primaryFailure?.error === primary),
    ).toBe(true);
  });

  test("makes the first cleanup failure fatal after a successful operation", async () => {
    const unlock = new Error("unlock failed");
    const close = new Error("close failed");
    const observed: CleanupFailure[] = [];

    const result = runWithCleanup(
      async () => "migrated",
      [
        { label: "advisory unlock", run: async () => Promise.reject(unlock) },
        { label: "client close", run: async () => Promise.reject(close) },
      ],
      (failure) => observed.push(failure),
    );

    await expect(result).rejects.toBe(unlock);
    expect(observed).toHaveLength(2);
    expect(observed.every((failure) => failure.primaryFailure === null)).toBe(
      true,
    );
  });

  test("returns the operation result when cleanup succeeds", async () => {
    const cleanupOrder: string[] = [];

    await expect(
      runWithCleanup(
        async () => "migrated",
        [
          {
            label: "advisory unlock",
            run: async () => {
              cleanupOrder.push("unlock");
            },
          },
          {
            label: "client close",
            run: async () => {
              cleanupOrder.push("close");
            },
          },
        ],
        () => {
          throw new Error("cleanup reporter must not run");
        },
      ),
    ).resolves.toBe("migrated");
    expect(cleanupOrder).toEqual(["unlock", "close"]);
  });

  test("prevents retry when rollback fails and preserves the migration error", async () => {
    const primary = Object.assign(new Error("lock timeout"), { code: "55P03" });
    const rollback = new Error("connection lost during rollback");
    const observed: CleanupFailure[] = [];
    let retryReached = false;

    const attempt = async (): Promise<void> => {
      await runCleanupSteps(
        [
          {
            label: "migration rollback",
            run: async () => {
              throw rollback;
            },
          },
        ],
        (failure) => observed.push(failure),
        { error: primary },
      );
      retryReached = true;
    };

    await expect(attempt()).rejects.toBe(primary);
    expect(retryReached).toBe(false);
    expect(observed).toEqual([
      {
        label: "migration rollback",
        cleanupError: rollback,
        primaryFailure: { error: primary },
      },
    ]);
  });
});
