/**
 * Unit coverage for the pure startup reducer and the shell-paintable predicate.
 * In-memory, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  connectionModeToTarget,
  createAndroidPolicy,
  createDesktopPolicy,
  createElizaOSPolicy,
  createIosPolicy,
  createMobilePolicy,
  createWebPolicy,
  INITIAL_STARTUP_STATE,
  isShellPaintable,
  isStartupLoading,
  isStartupTerminal,
  startupReducer,
  toLegacyStartupPhase,
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

  it("uses the runtime committed during a targetless fresh first-run", () => {
    expect(
      startupReducer(
        { phase: "first-run-required", serverReachable: false },
        { type: "FIRST_RUN_COMPLETE", target: "cloud-managed" },
      ),
    ).toEqual({
      phase: "starting-runtime",
      attempts: 0,
      target: "cloud-managed",
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

  it("surfaces every backend boundary outcome without fabricating readiness", () => {
    const polling = {
      phase: "polling-backend" as const,
      target: "cloud-managed" as const,
      attempts: 2,
    };

    expect(startupReducer(polling, { type: "BACKEND_AUTH_REQUIRED" })).toEqual({
      phase: "pairing-required",
    });
    expect(startupReducer(polling, { type: "BACKEND_NOT_FOUND" })).toEqual({
      phase: "error",
      reason: "backend-unreachable",
      message: "Backend returned 404 — check the API base URL.",
      timedOut: false,
    });
    expect(
      startupReducer(polling, {
        type: "AGENT_ERROR",
        message: "native transport failed",
      }),
    ).toEqual({
      phase: "error",
      reason: "agent-error",
      message: "native transport failed",
      timedOut: false,
    });
  });

  it("completes the runtime, hydration, and agent-switch sequence", () => {
    const starting = {
      phase: "starting-runtime" as const,
      attempts: 0,
      target: "cloud-managed" as const,
    };
    const hydrating = startupReducer(starting, { type: "AGENT_RUNNING" });
    expect(hydrating).toEqual({ phase: "hydrating" });
    const ready = startupReducer(hydrating, { type: "HYDRATION_COMPLETE" });
    expect(ready).toEqual({ phase: "ready" });
    expect(
      startupReducer(ready, {
        type: "SWITCH_AGENT",
        target: "remote-backend",
      }),
    ).toEqual({
      phase: "polling-backend",
      target: "remote-backend",
      attempts: 0,
    });
  });
});

describe("startup policy and presentation helpers", () => {
  it("keeps every stock mobile policy Cloud-first with the local runtime available", () => {
    for (const policy of [
      createMobilePolicy(),
      createIosPolicy(),
      createAndroidPolicy(),
    ]) {
      expect(policy).toMatchObject({
        supportsLocalRuntime: true,
        defaultTarget: "cloud-managed",
        backendTimeoutMs: 180_000,
        agentReadyTimeoutMs: 300_000,
      });
    }
  });

  it("keeps desktop and ElizaOS local-first while plain web has no implicit target", () => {
    expect(createDesktopPolicy().defaultTarget).toBe("embedded-local");
    expect(createElizaOSPolicy().defaultTarget).toBe("embedded-local");
    expect(createWebPolicy()).toMatchObject({
      supportsLocalRuntime: false,
      defaultTarget: null,
    });
  });

  it.each([
    [undefined, "embedded-local"],
    ["local", "embedded-local"],
    ["cloud", "cloud-managed"],
    ["remote", "remote-backend"],
  ] as const)("maps connection mode %s to %s", (mode, expected) => {
    expect(connectionModeToTarget(mode)).toBe(expected);
  });

  it("distinguishes loading, terminal, and legacy presentation phases", () => {
    expect(isStartupLoading({ phase: "restoring-session" })).toBe(true);
    expect(isStartupLoading({ phase: "hydrating" })).toBe(true);
    expect(isStartupLoading({ phase: "ready" })).toBe(false);
    expect(isStartupTerminal({ phase: "ready" })).toBe(true);
    expect(
      isStartupTerminal({
        phase: "error",
        reason: "unknown",
        message: "failed",
        timedOut: false,
      }),
    ).toBe(true);
    expect(toLegacyStartupPhase({ phase: "restoring-session" })).toBe(
      "starting-backend",
    );
    expect(
      toLegacyStartupPhase({
        phase: "starting-runtime",
        attempts: 0,
        target: "cloud-managed",
      }),
    ).toBe("initializing-agent");
    expect(toLegacyStartupPhase({ phase: "ready" })).toBe("ready");
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
