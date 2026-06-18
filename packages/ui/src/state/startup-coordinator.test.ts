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
});

describe("isShellPaintable", () => {
  it("paints the live shell once the agent boot is underway", () => {
    expect(isShellPaintable("starting-runtime")).toBe(true);
    expect(isShellPaintable("hydrating")).toBe(true);
    expect(isShellPaintable("ready")).toBe(true);
  });

  it("keeps the full-screen StartupScreen for pre-shell + interactive phases", () => {
    expect(isShellPaintable("restoring-session")).toBe(false);
    expect(isShellPaintable("resolving-target")).toBe(false);
    expect(isShellPaintable("polling-backend")).toBe(false);
    expect(isShellPaintable("first-run-required")).toBe(false);
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
