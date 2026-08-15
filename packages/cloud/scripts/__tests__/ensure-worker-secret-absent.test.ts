/**
 * Exercises the names-only Worker-secret removal boundary with an injected
 * Wrangler runner, including already-absent, verified deletion, and failures.
 */

import { describe, expect, test } from "bun:test";
import {
  ensureWorkerSecretAbsent,
  parseWorkerSecretNames,
  validateWranglerEnvironmentArgs,
} from "../ensure-worker-secret-absent.mjs";

describe("ensureWorkerSecretAbsent", () => {
  test("accepts an already-absent binding without issuing a delete", async () => {
    const calls: string[][] = [];
    const result = await ensureWorkerSecretAbsent({
      name: "STAGING_SESSION_EXCHANGE_ENABLED",
      wranglerArgs: ["--env", "staging"],
      run: async (args: string[]) => {
        calls.push(args);
        return JSON.stringify([
          { name: "OTHER_SECRET", type: "secret_text" },
          { name: "mixedCaseSecret", type: "secret_text" },
        ]);
      },
      sleep: async () => {},
    });

    expect(result).toBe("already-absent");
    expect(calls).toEqual([
      ["secret", "list", "--env", "staging", "--format", "json"],
    ]);
  });

  test("deletes a present binding and verifies the names-only inventory", async () => {
    const calls: string[][] = [];
    const outputs = [
      JSON.stringify([
        { name: "STAGING_SESSION_EXCHANGE_ENABLED", type: "secret_text" },
      ]),
      "",
      "[]",
    ];
    const result = await ensureWorkerSecretAbsent({
      name: "STAGING_SESSION_EXCHANGE_ENABLED",
      wranglerArgs: ["--env", "staging"],
      run: async (args: string[]) => {
        calls.push(args);
        return outputs.shift() ?? "[]";
      },
      sleep: async () => {},
    });

    expect(result).toBe("removed");
    expect(calls).toEqual([
      ["secret", "list", "--env", "staging", "--format", "json"],
      [
        "secret",
        "delete",
        "STAGING_SESSION_EXCHANGE_ENABLED",
        "--env",
        "staging",
      ],
      ["secret", "list", "--env", "staging", "--format", "json"],
    ]);
  });

  test("owns an ambiguous delete when the retry proves absence", async () => {
    const calls: string[][] = [];
    const result = await ensureWorkerSecretAbsent({
      name: "STAGING_SESSION_EXCHANGE_ENABLED",
      attempts: 2,
      retryDelayMs: 0,
      run: async (args: string[]) => {
        calls.push(args);
        if (calls.length === 1) {
          return JSON.stringify([{ name: "STAGING_SESSION_EXCHANGE_ENABLED" }]);
        }
        if (calls.length === 2) throw new Error("provider changed the prose");
        return "[]";
      },
      sleep: async () => {},
    });

    expect(result).toBe("removed");
    expect(calls).toHaveLength(3);
  });

  test("fails closed after bounded inventory failures without leaking output", async () => {
    const leaked = "sensitive-provider-diagnostic";
    const sleeps: number[] = [];
    await expect(
      ensureWorkerSecretAbsent({
        name: "STAGING_SESSION_EXCHANGE_ENABLED",
        attempts: 3,
        retryDelayMs: 7,
        run: async () => {
          throw new Error(leaked);
        },
        sleep: async (delay: number) => {
          sleeps.push(delay);
        },
      }),
    ).rejects.toThrow("Could not confirm Worker secret");
    expect(sleeps).toEqual([7, 7]);
    try {
      await ensureWorkerSecretAbsent({
        name: "STAGING_SESSION_EXCHANGE_ENABLED",
        attempts: 1,
        run: async () => {
          throw new Error(leaked);
        },
      });
    } catch (error) {
      expect(String(error)).not.toContain(leaked);
    }
  });
});

describe("Worker secret inventory validation", () => {
  test("rejects malformed inventories instead of fabricating absence", () => {
    expect(() => parseWorkerSecretNames("{}")).toThrow(
      "inventory was not an array",
    );
    expect(() => parseWorkerSecretNames('[{"type":"secret_text"}]')).toThrow(
      "invalid name",
    );
  });

  test("accepts only an optional exact Wrangler environment selector", () => {
    expect(validateWranglerEnvironmentArgs([])).toEqual([]);
    expect(validateWranglerEnvironmentArgs(["--env", "staging"])).toEqual([
      "--env",
      "staging",
    ]);
    expect(() => validateWranglerEnvironmentArgs(["--config", "x"])).toThrow(
      "--env selector",
    );
  });
});
