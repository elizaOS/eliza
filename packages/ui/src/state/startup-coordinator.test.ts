import { describe, expect, it } from "vitest";
import { INITIAL_STARTUP_STATE, startupReducer } from "./startup-coordinator";

describe("startup coordinator", () => {
  it("starts by restoring session state", () => {
    expect(INITIAL_STARTUP_STATE).toEqual({ phase: "restoring-session" });
  });

  it("sends fresh installs directly into first-run setup", () => {
    expect(
      startupReducer(INITIAL_STARTUP_STATE, {
        type: "NO_SESSION",
        hadPriorFirstRun: false,
      }),
    ).toEqual({ phase: "first-run-required", serverReachable: false });
  });

  it("restores a saved session through target resolution and backend polling", () => {
    const resolved = startupReducer(INITIAL_STARTUP_STATE, {
      type: "SESSION_RESTORED",
      target: "embedded-local",
    });

    expect(resolved).toEqual({
      phase: "resolving-target",
      target: "embedded-local",
    });
    expect(startupReducer(resolved, { type: "BACKEND_POLL_RETRY" })).toEqual({
      phase: "polling-backend",
      target: "embedded-local",
      attempts: 0,
    });
  });

  it("resets back to session restoration", () => {
    expect(
      startupReducer(
        {
          phase: "error",
          reason: "agent-error",
          message: "failed",
          timedOut: false,
        },
        { type: "RESET" },
      ),
    ).toEqual({ phase: "restoring-session" });
  });
});
