/**
 * Unit coverage for the pure startup reducer and the shell-paintable predicate.
 * In-memory, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  INITIAL_STARTUP_STATE,
  isShellPaintable,
  startupReducer,
} from "./startup-coordinator";
import { deriveAgentReady } from "./types";

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

  it("carries a cloud-managed target from backend polling into starting-runtime", () => {
    const reached = startupReducer(
      { phase: "polling-backend", target: "cloud-managed", attempts: 0 },
      { type: "BACKEND_REACHED", firstRunComplete: true },
    );
    expect(reached).toEqual({
      phase: "starting-runtime",
      attempts: 0,
      target: "cloud-managed",
    });
  });

  it("carries the target through first-run into starting-runtime", () => {
    const firstRun = startupReducer(
      { phase: "polling-backend", target: "cloud-managed", attempts: 0 },
      { type: "BACKEND_REACHED", firstRunComplete: false },
    );
    expect(firstRun).toEqual({
      phase: "first-run-required",
      serverReachable: true,
      target: "cloud-managed",
    });
    expect(startupReducer(firstRun, { type: "FIRST_RUN_COMPLETE" })).toEqual({
      phase: "starting-runtime",
      attempts: 0,
      target: "cloud-managed",
    });
  });

  it("routes unavailable web backends into offline first-run with the target preserved", () => {
    expect(
      startupReducer(
        { phase: "polling-backend", target: "cloud-managed", attempts: 0 },
        { type: "BACKEND_UNAVAILABLE_FIRST_RUN" },
      ),
    ).toEqual({
      phase: "first-run-required",
      serverReachable: false,
      target: "cloud-managed",
    });
  });

  it("defaults a targetless first-run completion to embedded-local", () => {
    expect(
      startupReducer(
        { phase: "first-run-required", serverReachable: false },
        { type: "FIRST_RUN_COMPLETE" },
      ),
    ).toEqual({
      phase: "starting-runtime",
      attempts: 0,
      target: "embedded-local",
    });
  });

  it("keeps the target across starting-runtime self-transitions", () => {
    expect(
      startupReducer(
        { phase: "starting-runtime", attempts: 0, target: "cloud-managed" },
        { type: "AGENT_POLL_RETRY" },
      ),
    ).toEqual({
      phase: "starting-runtime",
      attempts: 1,
      target: "cloud-managed",
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

  it("surfaces a terminal native agent error during backend polling as the error phase (#11030)", () => {
    // The iOS device hang: the native transport fails TERMINALLY while the
    // backend poll runs (missing-endpoint / cloud-mode IPC policy). The
    // coordinator must surface the REAL message instead of polling forever.
    const message =
      "iOS Agent requires a configured HTTP endpoint for remote/cloud mode, or runtimeMode=local for dev/sideload local mode.";
    expect(
      startupReducer(
        { phase: "polling-backend", target: "embedded-local", attempts: 3 },
        { type: "AGENT_ERROR", message },
      ),
    ).toEqual({
      phase: "error",
      reason: "agent-error",
      message,
      timedOut: false,
    });
  });

  it("keeps the deadline path: BACKEND_TIMEOUT during polling still reaches the error phase", () => {
    expect(
      startupReducer(
        { phase: "polling-backend", target: "embedded-local", attempts: 12 },
        { type: "BACKEND_TIMEOUT" },
      ),
    ).toEqual({
      phase: "error",
      reason: "backend-timeout",
      message: "Backend did not respond within the timeout period.",
      timedOut: true,
    });
  });

  it("recovers from the terminal error phase via RETRY (the error view's button)", () => {
    expect(
      startupReducer(
        {
          phase: "error",
          reason: "agent-error",
          message: "iOS Agent requires a configured HTTP endpoint",
          timedOut: false,
        },
        { type: "RETRY" },
      ),
    ).toEqual({ phase: "restoring-session" });
  });

  it("keeps the healthy polling path unchanged: retries increment attempts, then BACKEND_REACHED advances", () => {
    const retried = startupReducer(
      { phase: "polling-backend", target: "embedded-local", attempts: 0 },
      { type: "BACKEND_POLL_RETRY" },
    );
    expect(retried).toEqual({
      phase: "polling-backend",
      target: "embedded-local",
      attempts: 1,
    });
    expect(
      startupReducer(retried, {
        type: "BACKEND_REACHED",
        firstRunComplete: true,
      }),
    ).toEqual({
      phase: "starting-runtime",
      attempts: 0,
      target: "embedded-local",
    });
  });
});

describe("isShellPaintable", () => {
  it("paints the live shell once the agent boot is underway", () => {
    expect(isShellPaintable("starting-runtime")).toBe(true);
    expect(isShellPaintable("hydrating")).toBe(true);
    expect(isShellPaintable("ready")).toBe(true);
  });

  it("paints the live shell during first-run so onboarding runs in the chat", () => {
    // Onboarding is now seeded into the live ContinuousChatOverlay (homescreen +
    // auto-opened chat) by the headless first-run conductor, not a full-screen
    // gate — so first-run-required is shell-paintable.
    expect(isShellPaintable("first-run-required")).toBe(true);
  });

  it("keeps the full-screen StartupScreen for pre-shell + interactive phases", () => {
    expect(isShellPaintable("restoring-session")).toBe(false);
    expect(isShellPaintable("resolving-target")).toBe(false);
    expect(isShellPaintable("polling-backend")).toBe(false);
    expect(isShellPaintable("pairing-required")).toBe(false);
    expect(isShellPaintable("error")).toBe(false);
  });
});

describe("deriveAgentReady", () => {
  it("is false with no status", () => {
    expect(deriveAgentReady(null)).toBe(false);
  });

  it("prefers the server-authoritative canRespond", () => {
    expect(
      deriveAgentReady({
        state: "running",
        agentName: "Eliza",
        model: undefined,
        canRespond: true,
        uptime: undefined,
        startedAt: undefined,
      }),
    ).toBe(true);
    // running but no provider wired → canRespond:false keeps the composer gated
    expect(
      deriveAgentReady({
        state: "running",
        agentName: "Eliza",
        model: "x",
        canRespond: false,
        uptime: undefined,
        startedAt: undefined,
      }),
    ).toBe(false);
  });

  it("falls back to running+model when canRespond is absent (older agents)", () => {
    expect(
      deriveAgentReady({
        state: "running",
        agentName: "Eliza",
        model: "gpt",
        uptime: undefined,
        startedAt: undefined,
      }),
    ).toBe(true);
    expect(
      deriveAgentReady({
        state: "starting",
        agentName: "Eliza",
        model: undefined,
        uptime: undefined,
        startedAt: undefined,
      }),
    ).toBe(false);
  });
});
