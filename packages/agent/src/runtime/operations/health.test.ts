/**
 * Unit coverage for the runtime-operations HealthChecker. Drives the real
 * class: register validation, list/unregister, empty and single-check runs,
 * required vs optional failure, timeouts, thrown checks, settlement order,
 * same-name overwrite, and the default singleton.
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { getDefaultHealthChecker, HealthChecker } from "./health.ts";
import { builtInHealthChecks } from "./health-checks.ts";
import type { HealthCheck, HealthCheckResult } from "./types.ts";

function runtime(): AgentRuntime {
  return { agentId: "agent-id" } as AgentRuntime;
}

function makeCheck(
  name: string,
  run: HealthCheck["run"],
  extras: { required?: boolean; timeoutMs?: number } = {},
): HealthCheck {
  const required = extras.required;
  const timeoutMs = extras.timeoutMs;
  return {
    name,
    required: required === undefined ? true : required,
    timeoutMs: timeoutMs === undefined ? 1000 : timeoutMs,
    run,
  };
}

function pass(
  name: string,
  extras: { required?: boolean; timeoutMs?: number } = {},
): HealthCheck {
  return makeCheck(name, async () => ({ ok: true }), extras);
}

function fail(
  name: string,
  reason: string,
  extras: { required?: boolean; timeoutMs?: number } = {},
): HealthCheck {
  return makeCheck(name, async () => ({ ok: false, reason }), extras);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("HealthChecker.register", () => {
  it("throws when the check is missing", () => {
    const checker = new HealthChecker();
    expect(() => checker.register(null as unknown as HealthCheck)).toThrowError(
      "[runtime-ops:health] register: check.name is required",
    );
    expect(() =>
      checker.register(undefined as unknown as HealthCheck),
    ).toThrowError("[runtime-ops:health] register: check.name is required");
  });

  it("throws when name is missing, empty, or not a string", () => {
    const checker = new HealthChecker();
    const run = async (): Promise<HealthCheckResult> => ({ ok: true });
    expect(() =>
      checker.register({
        required: true,
        timeoutMs: 10,
        run,
      } as unknown as HealthCheck),
    ).toThrowError("[runtime-ops:health] register: check.name is required");
    expect(() =>
      checker.register({
        name: "",
        required: true,
        timeoutMs: 10,
        run,
      }),
    ).toThrowError("[runtime-ops:health] register: check.name is required");
    expect(() =>
      checker.register({
        name: 12,
        required: true,
        timeoutMs: 10,
        run,
      } as unknown as HealthCheck),
    ).toThrowError("[runtime-ops:health] register: check.name is required");
  });

  it("throws when run is not a function", () => {
    const checker = new HealthChecker();
    expect(() =>
      checker.register({
        name: "broken",
        required: true,
        timeoutMs: 10,
        run: "nope",
      } as unknown as HealthCheck),
    ).toThrowError(
      "[runtime-ops:health] register: check.run must be a function (broken)",
    );
  });

  it("throws when timeoutMs is not a positive number", () => {
    const checker = new HealthChecker();
    const run = async (): Promise<HealthCheckResult> => ({ ok: true });
    expect(() =>
      checker.register({ name: "t0", required: true, timeoutMs: 0, run }),
    ).toThrowError(
      "[runtime-ops:health] register: check.timeoutMs must be > 0 (t0)",
    );
    expect(() =>
      checker.register({ name: "tneg", required: true, timeoutMs: -5, run }),
    ).toThrowError(
      "[runtime-ops:health] register: check.timeoutMs must be > 0 (tneg)",
    );
    expect(() =>
      checker.register({
        name: "tstr",
        required: true,
        timeoutMs: "10",
        run,
      } as unknown as HealthCheck),
    ).toThrowError(
      "[runtime-ops:health] register: check.timeoutMs must be > 0 (tstr)",
    );
  });

  it("accepts a whitespace-only name and a fractional timeoutMs", () => {
    const checker = new HealthChecker();
    checker.register(pass(" ", { timeoutMs: 0.5 }));
    expect(checker.list()).toHaveLength(1);
    expect(checker.list()[0]?.name).toBe(" ");
  });
});

describe("HealthChecker.list and unregister", () => {
  it("starts empty and preserves insertion order", () => {
    const checker = new HealthChecker();
    expect(checker.list()).toEqual([]);
    checker.register(pass("beta"));
    checker.register(pass("alpha"));
    expect(checker.list().map((c) => c.name)).toEqual(["beta", "alpha"]);
  });

  it("overwrites a duplicate name in place without changing order", () => {
    const checker = new HealthChecker();
    const first = pass("dup");
    const second = fail("dup", "replaced");
    checker.register(first);
    checker.register(pass("other"));
    checker.register(second);
    const listed = checker.list();
    expect(listed.map((c) => c.name)).toEqual(["dup", "other"]);
    expect(listed[0]).toBe(second);
    expect(listed).toHaveLength(2);
  });

  it("unregister is a no-op for a missing name and removes a present one", () => {
    const checker = new HealthChecker();
    checker.register(pass("keep"));
    checker.register(pass("drop"));
    expect(() => checker.unregister("missing")).not.toThrow();
    expect(checker.list().map((c) => c.name)).toEqual(["keep", "drop"]);
    checker.unregister("drop");
    expect(checker.list().map((c) => c.name)).toEqual(["keep"]);
    checker.unregister("drop");
    expect(checker.list().map((c) => c.name)).toEqual(["keep"]);
  });
});

describe("HealthChecker.runForRuntime", () => {
  it("returns ok with empty passed/failed when no checks are registered", async () => {
    const checker = new HealthChecker();
    await expect(checker.runForRuntime(runtime())).resolves.toEqual({
      passed: [],
      failed: [],
      ok: true,
    });
  });

  it("reports a single passing check", async () => {
    const checker = new HealthChecker();
    const seen: AgentRuntime[] = [];
    const rt = runtime();
    checker.register(
      makeCheck("one", async (received) => {
        seen.push(received);
        return { ok: true };
      }),
    );
    const report = await checker.runForRuntime(rt);
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.passed).toHaveLength(1);
    expect(report.passed[0]?.name).toBe("one");
    expect(report.passed[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(seen).toEqual([rt]);
  });

  it("fails the report when a required check fails", async () => {
    const checker = new HealthChecker();
    checker.register(fail("need", "not ready"));
    const report = await checker.runForRuntime(runtime());
    expect(report.ok).toBe(false);
    expect(report.passed).toEqual([]);
    expect(report.failed).toEqual([
      expect.objectContaining({
        name: "need",
        required: true,
        reason: "not ready",
      }),
    ]);
    expect(report.failed[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps ok true when only optional checks fail", async () => {
    const checker = new HealthChecker();
    checker.register(pass("req"));
    checker.register(fail("opt", "skipped surface", { required: false }));
    const report = await checker.runForRuntime(runtime());
    expect(report.ok).toBe(true);
    expect(report.passed.map((p) => p.name)).toEqual(["req"]);
    expect(report.failed).toEqual([
      expect.objectContaining({
        name: "opt",
        required: false,
        reason: "skipped surface",
      }),
    ]);
  });

  it("fails when any required check fails even if optionals pass", async () => {
    const checker = new HealthChecker();
    checker.register(fail("req", "broken"));
    checker.register(pass("opt", { required: false }));
    const report = await checker.runForRuntime(runtime());
    expect(report.ok).toBe(false);
    expect(report.passed.map((p) => p.name)).toEqual(["opt"]);
    expect(report.failed.map((f) => f.name)).toEqual(["req"]);
  });

  it("keeps ok true when every registered check is optional and all fail", async () => {
    const checker = new HealthChecker();
    checker.register(fail("a", "a-fail", { required: false }));
    checker.register(fail("b", "b-fail", { required: false }));
    const report = await checker.runForRuntime(runtime());
    expect(report.ok).toBe(true);
    expect(report.passed).toEqual([]);
    expect(report.failed.map((f) => f.name)).toEqual(["a", "b"]);
  });

  it("preserves registration order across mixed pass and fail results", async () => {
    const checker = new HealthChecker();
    checker.register(pass("first"));
    checker.register(fail("second", "no"));
    checker.register(pass("third"));
    const report = await checker.runForRuntime(runtime());
    expect(report.passed.map((p) => p.name)).toEqual(["first", "third"]);
    expect(report.failed.map((f) => f.name)).toEqual(["second"]);
  });

  it("runs checks in parallel rather than sequentially", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck("slow", async () => {
        await delay(40);
        return { ok: true };
      }),
    );
    checker.register(
      makeCheck("fast", async () => {
        await delay(40);
        return { ok: true };
      }),
    );
    const startedAt = Date.now();
    const report = await checker.runForRuntime(runtime());
    const elapsed = Date.now() - startedAt;
    expect(report.ok).toBe(true);
    expect(report.passed).toHaveLength(2);
    expect(elapsed).toBeLessThan(120);
  });

  it("records a timeout without waiting for a hung required check", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck(
        "hang",
        async () => {
          await delay(200);
          return { ok: true };
        },
        { timeoutMs: 30 },
      ),
    );
    const startedAt = Date.now();
    const report = await checker.runForRuntime(runtime());
    const elapsed = Date.now() - startedAt;
    expect(report.ok).toBe(false);
    expect(report.passed).toEqual([]);
    expect(report.failed).toEqual([
      expect.objectContaining({
        name: "hang",
        required: true,
        reason: "timeout after 30ms",
      }),
    ]);
    expect(elapsed).toBeLessThan(150);
    await delay(220);
  });

  it("lets a fast required check finish while a slow optional times out", async () => {
    const checker = new HealthChecker();
    checker.register(pass("ready", { timeoutMs: 200 }));
    checker.register(
      makeCheck(
        "slow-opt",
        async () => {
          await delay(200);
          return { ok: true };
        },
        { required: false, timeoutMs: 25 },
      ),
    );
    const report = await checker.runForRuntime(runtime());
    expect(report.ok).toBe(true);
    expect(report.passed.map((p) => p.name)).toEqual(["ready"]);
    expect(report.failed).toEqual([
      expect.objectContaining({
        name: "slow-opt",
        required: false,
        reason: "timeout after 25ms",
      }),
    ]);
    await delay(220);
  });

  it("wraps a thrown Error as a failed check", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck("boom", async () => {
        throw new Error("db down");
      }),
    );
    const report = await checker.runForRuntime(runtime());
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual([
      expect.objectContaining({
        name: "boom",
        required: true,
        reason: "threw: db down",
      }),
    ]);
  });

  it("wraps a thrown string and a non-error object via describeError", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck("as-string", async () => {
        throw "plain-string";
      }),
    );
    checker.register(
      makeCheck("as-object", async () => {
        throw { code: "EFAIL" };
      }),
    );
    const report = await checker.runForRuntime(runtime());
    expect(report.ok).toBe(false);
    expect(report.failed.map((f) => f.reason)).toEqual([
      "threw: plain-string",
      'threw: {"code":"EFAIL"}',
    ]);
  });

  it("runs the overwritten check, not the first registration", async () => {
    const checker = new HealthChecker();
    checker.register(pass("swap"));
    checker.register(fail("swap", "now failing"));
    const report = await checker.runForRuntime(runtime());
    expect(report.ok).toBe(false);
    expect(report.passed).toEqual([]);
    expect(report.failed.map((f) => f.reason)).toEqual(["now failing"]);
  });

  it("does not run an unregistered check", async () => {
    const checker = new HealthChecker();
    let ran = false;
    checker.register(
      makeCheck("gone", async () => {
        ran = true;
        return { ok: true };
      }),
    );
    checker.unregister("gone");
    const report = await checker.runForRuntime(runtime());
    expect(ran).toBe(false);
    expect(report).toEqual({ passed: [], failed: [], ok: true });
  });

  it("runs every registered check with no capacity cap", async () => {
    const checker = new HealthChecker();
    for (let i = 0; i < 20; i += 1) {
      checker.register(pass(`c${i}`));
    }
    const report = await checker.runForRuntime(runtime());
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.passed.map((p) => p.name)).toEqual(
      Array.from({ length: 20 }, (_, i) => `c${i}`),
    );
  });
});

describe("getDefaultHealthChecker", () => {
  it("returns a process singleton pre-registered with the built-in checks", () => {
    const first = getDefaultHealthChecker();
    const second = getDefaultHealthChecker();
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(HealthChecker);
    expect(first.list().map((c) => c.name)).toEqual(
      builtInHealthChecks.map((c) => c.name),
    );
    expect(first.list()).toHaveLength(4);
  });
});
