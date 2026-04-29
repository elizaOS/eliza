import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "@elizaos/core";
import { HealthChecker } from "./health.js";
import type { HealthCheck, HealthCheckResult } from "./types.js";

// Minimal runtime stub — checks under test only read what they ask for, and
// the unit tests here use checks that ignore the argument entirely.
const stubRuntime = {} as AgentRuntime;

function makeCheck(overrides: Partial<HealthCheck> & Pick<HealthCheck, "name" | "run">): HealthCheck {
  return {
    required: true,
    timeoutMs: 100,
    ...overrides,
  };
}

describe("HealthChecker.register", () => {
  test("rejects nameless check", () => {
    const checker = new HealthChecker();
    expect(() =>
      checker.register({
        name: "",
        required: true,
        timeoutMs: 100,
        run: async () => ({ ok: true }),
      }),
    ).toThrow();
  });

  test("rejects non-positive timeout", () => {
    const checker = new HealthChecker();
    expect(() =>
      checker.register({
        name: "x",
        required: true,
        timeoutMs: 0,
        run: async () => ({ ok: true }),
      }),
    ).toThrow();
  });

  test("unregister removes the check", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck({ name: "a", run: async () => ({ ok: true }) }),
    );
    checker.unregister("a");
    const report = await checker.runForRuntime(stubRuntime);
    expect(report.passed).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
});

describe("HealthChecker.runForRuntime", () => {
  test("all checks pass → ok=true, passed populated, failed empty", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck({ name: "a", run: async () => ({ ok: true }) }),
    );
    checker.register(
      makeCheck({ name: "b", run: async () => ({ ok: true }) }),
    );
    checker.register(
      makeCheck({
        name: "c",
        required: false,
        run: async () => ({ ok: true }),
      }),
    );

    const report = await checker.runForRuntime(stubRuntime);
    expect(report.ok).toBe(true);
    expect(report.passed.map((p) => p.name).sort()).toEqual(["a", "b", "c"]);
    expect(report.failed).toHaveLength(0);
  });

  test("required failure → ok=false, recorded in failed[] with required=true", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck({ name: "ok-one", run: async () => ({ ok: true }) }),
    );
    checker.register(
      makeCheck({
        name: "bad-required",
        required: true,
        run: async (): Promise<HealthCheckResult> => ({
          ok: false,
          reason: "boom",
        }),
      }),
    );

    const report = await checker.runForRuntime(stubRuntime);
    expect(report.ok).toBe(false);
    expect(report.passed.map((p) => p.name)).toEqual(["ok-one"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].name).toBe("bad-required");
    expect(report.failed[0].required).toBe(true);
    expect(report.failed[0].reason).toBe("boom");
  });

  test("optional failure → ok=true, recorded in failed[] with required=false", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck({ name: "ok-one", run: async () => ({ ok: true }) }),
    );
    checker.register(
      makeCheck({
        name: "bad-optional",
        required: false,
        run: async (): Promise<HealthCheckResult> => ({
          ok: false,
          reason: "soft-fail",
        }),
      }),
    );

    const report = await checker.runForRuntime(stubRuntime);
    expect(report.ok).toBe(true);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].name).toBe("bad-optional");
    expect(report.failed[0].required).toBe(false);
    expect(report.failed[0].reason).toBe("soft-fail");
  });

  test("timeout sentinel triggers when run exceeds timeoutMs", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck({
        name: "slow",
        required: true,
        timeoutMs: 50,
        run: () =>
          new Promise<HealthCheckResult>((resolve) => {
            setTimeout(() => resolve({ ok: true }), 5000);
          }),
      }),
    );

    const start = Date.now();
    const report = await checker.runForRuntime(stubRuntime);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000); // sanity: did not wait the full 5s
    expect(report.ok).toBe(false);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].name).toBe("slow");
    expect(report.failed[0].reason).toMatch(/timeout after 50ms/);
  });

  test("checks run in parallel, not series", async () => {
    const checker = new HealthChecker();
    const slow = (name: string): HealthCheck => ({
      name,
      required: false,
      timeoutMs: 1000,
      run: () =>
        new Promise<HealthCheckResult>((resolve) => {
          setTimeout(() => resolve({ ok: true }), 200);
        }),
    });
    checker.register(slow("p1"));
    checker.register(slow("p2"));

    const start = Date.now();
    const report = await checker.runForRuntime(stubRuntime);
    const elapsed = Date.now() - start;

    // Two 200ms checks running serially would take ~400ms. In parallel,
    // ~200ms. Allow generous slack for CI jitter but well under serial.
    expect(elapsed).toBeLessThan(300);
    expect(report.ok).toBe(true);
    expect(report.passed).toHaveLength(2);
  });

  test("thrown error inside run() is captured as a failure, not a rejection", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck({
        name: "thrower",
        required: true,
        run: async () => {
          throw new Error("kaboom");
        },
      }),
    );
    const report = await checker.runForRuntime(stubRuntime);
    expect(report.ok).toBe(false);
    expect(report.failed[0].name).toBe("thrower");
    expect(report.failed[0].reason).toMatch(/kaboom/);
  });

  test("empty registry → ok=true with no entries", async () => {
    const checker = new HealthChecker();
    const report = await checker.runForRuntime(stubRuntime);
    expect(report.ok).toBe(true);
    expect(report.passed).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
  });

  test("slow optional check does not block fast required check from finishing", async () => {
    const checker = new HealthChecker();
    checker.register(
      makeCheck({
        name: "fast-required",
        required: true,
        timeoutMs: 1000,
        run: async () => ({ ok: true }),
      }),
    );
    checker.register({
      name: "slow-optional",
      required: false,
      timeoutMs: 50,
      run: () =>
        new Promise<HealthCheckResult>((resolve) => {
          setTimeout(() => resolve({ ok: true }), 5000);
        }),
    });

    const start = Date.now();
    const report = await checker.runForRuntime(stubRuntime);
    const elapsed = Date.now() - start;

    // Bounded by the slow check's timeout (50ms), not its actual work (5s).
    expect(elapsed).toBeLessThan(500);
    // fast-required passed; slow-optional timed out but didn't flip ok.
    expect(report.ok).toBe(true);
    expect(report.passed.map((p) => p.name)).toContain("fast-required");
    expect(report.failed.map((f) => f.name)).toContain("slow-optional");
  });
});
