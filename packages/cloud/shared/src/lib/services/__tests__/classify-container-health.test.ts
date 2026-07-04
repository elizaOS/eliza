// Exercises classify container health behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { classifyContainerHealth } from "../admin-infrastructure";

type Params = Parameters<typeof classifyContainerHealth>[0];
const base = { lastHeartbeatAt: new Date().toISOString(), errorMessage: null };
const classify = (p: Record<string, unknown>) =>
  classifyContainerHealth({ ...base, ...p } as Params);
const rt = (over: Record<string, unknown> = {}) => ({
  state: "running",
  health: "healthy",
  status: "ok",
  ...over,
});

// Health classification drives admin/ops alerting; pin the status+severity each
// (dbStatus × runtime) combination maps to, especially the critical ones.
describe("classifyContainerHealth", () => {
  test("db error → failed/critical", () => {
    expect(classify({ dbStatus: "error", runtime: null })).toMatchObject({
      status: "failed",
      severity: "critical",
    });
  });

  test("stopped + no runtime → stopped/info (intentional)", () => {
    expect(classify({ dbStatus: "stopped", runtime: null })).toMatchObject({
      status: "stopped",
      severity: "info",
    });
  });

  test("pending/provisioning + no runtime → warming/info", () => {
    for (const dbStatus of ["pending", "provisioning"]) {
      expect(classify({ dbStatus, runtime: null })).toMatchObject({
        status: "warming",
        severity: "info",
      });
    }
  });

  test("active db but no runtime → missing/critical", () => {
    expect(classify({ dbStatus: "ready", runtime: null })).toMatchObject({
      status: "missing",
      severity: "critical",
    });
  });

  test("stopped db but runtime still present → degraded/warning", () => {
    expect(classify({ dbStatus: "stopped", runtime: rt() })).toMatchObject({
      status: "degraded",
      severity: "warning",
    });
  });

  test("runtime dead/exited → failed/critical", () => {
    for (const state of ["dead", "exited"]) {
      expect(classify({ dbStatus: "ready", runtime: rt({ state }) })).toMatchObject({
        status: "failed",
        severity: "critical",
      });
    }
  });

  test("runtime restarting → degraded; created → warming; unhealthy → failed", () => {
    expect(classify({ dbStatus: "ready", runtime: rt({ state: "restarting" }) }).status).toBe(
      "degraded",
    );
    expect(classify({ dbStatus: "ready", runtime: rt({ state: "created" }) }).status).toBe(
      "warming",
    );
    expect(classify({ dbStatus: "ready", runtime: rt({ health: "unhealthy" }) }).status).toBe(
      "failed",
    );
  });
});
