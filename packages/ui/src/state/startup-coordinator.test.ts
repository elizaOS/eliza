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
  type StartupEvent,
  type StartupState,
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

  it.each([
    { phase: "first-run-required", serverReachable: false } as const,
    {
      phase: "starting-runtime",
      attempts: 2,
      target: "embedded-local",
    } as const,
    { phase: "ready" } as const,
    {
      phase: "error",
      reason: "agent-error",
      message: "old target failed",
      timedOut: false,
    } as const,
  ])("replaces the active target from $phase", (state) => {
    expect(
      startupReducer(state, {
        type: "SWITCH_AGENT",
        target: "remote-backend",
      }),
    ).toEqual({
      phase: "polling-backend",
      target: "remote-backend",
      attempts: 0,
    });
  });

  it.each([
    {
      phase: "starting-runtime",
      attempts: 2,
      target: "embedded-local",
    } as const,
    { phase: "ready" } as const,
  ])("restarts target restoration when retrying from $phase", (state) => {
    expect(startupReducer(state, { type: "RETRY" })).toEqual({
      phase: "restoring-session",
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

  const transitionCases: Array<{
    state: StartupState;
    event: StartupEvent;
    expected: StartupState;
  }> = [
    {
      state: { phase: "restoring-session" },
      event: {
        type: "EXISTING_INSTALL_DETECTED",
        target: "embedded-local",
      },
      expected: { phase: "resolving-target", target: "embedded-local" },
    },
    {
      state: { phase: "restoring-session" },
      event: { type: "NO_SESSION", hadPriorFirstRun: true },
      expected: {
        phase: "error",
        reason: "backend-unreachable",
        message:
          "Previously configured backend is unreachable. Check your connection or reset.",
        timedOut: false,
      },
    },
    {
      state: { phase: "restoring-session" },
      event: { type: "AGENT_ERROR", message: "restore failed" },
      expected: {
        phase: "error",
        reason: "agent-error",
        message: "restore failed",
        timedOut: false,
      },
    },
    {
      state: {
        phase: "polling-backend",
        target: "remote-backend",
        attempts: 2,
      },
      event: { type: "BACKEND_AUTH_REQUIRED" },
      expected: { phase: "pairing-required" },
    },
    {
      state: {
        phase: "polling-backend",
        target: "remote-backend",
        attempts: 2,
      },
      event: { type: "BACKEND_NOT_FOUND" },
      expected: {
        phase: "error",
        reason: "backend-unreachable",
        message: "Backend returned 404 — check the API base URL.",
        timedOut: false,
      },
    },
    {
      state: { phase: "pairing-required" },
      event: { type: "PAIRING_SUCCESS" },
      expected: { phase: "restoring-session" },
    },
    {
      state: {
        phase: "starting-runtime",
        attempts: 0,
        target: "embedded-local",
      },
      event: { type: "AGENT_RUNNING" },
      expected: { phase: "hydrating" },
    },
    {
      state: {
        phase: "starting-runtime",
        attempts: 3,
        target: "embedded-local",
      },
      event: { type: "AGENT_STARTING" },
      expected: {
        phase: "starting-runtime",
        attempts: 4,
        target: "embedded-local",
      },
    },
    {
      state: {
        phase: "starting-runtime",
        attempts: 1,
        target: "embedded-local",
      },
      event: { type: "AGENT_ERROR", message: "runtime failed" },
      expected: {
        phase: "error",
        reason: "agent-error",
        message: "runtime failed",
        timedOut: false,
      },
    },
    {
      state: {
        phase: "starting-runtime",
        attempts: 8,
        target: "embedded-local",
      },
      event: { type: "AGENT_TIMEOUT" },
      expected: {
        phase: "error",
        reason: "agent-timeout",
        message: "Agent did not reach running state within the timeout period.",
        timedOut: true,
      },
    },
    {
      state: {
        phase: "starting-runtime",
        attempts: 1,
        target: "remote-backend",
      },
      event: { type: "BACKEND_AUTH_REQUIRED" },
      expected: { phase: "pairing-required" },
    },
    {
      state: { phase: "hydrating" },
      event: { type: "HYDRATION_COMPLETE" },
      expected: { phase: "ready" },
    },
    {
      state: {
        phase: "error",
        reason: "backend-timeout",
        message: "timed out",
        timedOut: true,
      },
      event: { type: "BACKEND_REACHED", firstRunComplete: true },
      expected: {
        phase: "starting-runtime",
        attempts: 0,
        target: "embedded-local",
      },
    },
    {
      state: {
        phase: "error",
        reason: "backend-timeout",
        message: "timed out",
        timedOut: true,
      },
      event: { type: "BACKEND_REACHED", firstRunComplete: false },
      expected: { phase: "first-run-required", serverReachable: true },
    },
    {
      state: {
        phase: "error",
        reason: "backend-unreachable",
        message: "offline",
        timedOut: false,
      },
      event: { type: "BACKEND_UNAVAILABLE_FIRST_RUN" },
      expected: { phase: "first-run-required", serverReachable: false },
    },
    {
      state: {
        phase: "error",
        reason: "agent-error",
        message: "failed",
        timedOut: false,
      },
      event: { type: "AGENT_RUNNING" },
      expected: { phase: "hydrating" },
    },
  ];

  it.each(transitionCases)("handles $state.phase + $event.type", ({
    state,
    event,
    expected,
  }) => {
    expect(startupReducer(state, event)).toEqual(expected);
  });

  it.each([
    {
      state: { phase: "restoring-session" } as const,
      event: { type: "HYDRATION_COMPLETE" } as const,
    },
    {
      state: { phase: "pairing-required" } as const,
      event: { type: "AGENT_RUNNING" } as const,
    },
    {
      state: { phase: "first-run-required", serverReachable: true } as const,
      event: { type: "FIRST_RUN_OPTIONS_LOADED" } as const,
    },
    {
      state: { phase: "hydrating" } as const,
      event: { type: "BACKEND_REACHED", firstRunComplete: true } as const,
    },
    {
      state: { phase: "ready" } as const,
      event: { type: "AGENT_RUNNING" } as const,
    },
  ])("preserves $state.phase for its non-transition event", ({
    state,
    event,
  }) => {
    expect(startupReducer(state, event)).toBe(state);
  });
});

describe("startup policies and selectors", () => {
  it.each([
    {
      name: "desktop",
      factory: createDesktopPolicy,
      expected: {
        supportsLocalRuntime: true,
        backendTimeoutMs: 180_000,
        agentReadyTimeoutMs: 300_000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
      },
    },
    {
      name: "web",
      factory: createWebPolicy,
      expected: {
        supportsLocalRuntime: false,
        backendTimeoutMs: 180_000,
        agentReadyTimeoutMs: 180_000,
        probeForExistingInstall: false,
        defaultTarget: null,
      },
    },
    {
      name: "mobile",
      factory: createMobilePolicy,
      expected: {
        supportsLocalRuntime: true,
        backendTimeoutMs: 180_000,
        agentReadyTimeoutMs: 300_000,
        probeForExistingInstall: true,
        defaultTarget: "cloud-managed",
        nativeConsecutiveFailureBudgetMs: 90_000,
      },
    },
    {
      name: "iOS",
      factory: createIosPolicy,
      expected: {
        supportsLocalRuntime: true,
        backendTimeoutMs: 180_000,
        agentReadyTimeoutMs: 300_000,
        probeForExistingInstall: false,
        defaultTarget: "cloud-managed",
        nativeConsecutiveFailureBudgetMs: 90_000,
      },
    },
    {
      name: "Android",
      factory: createAndroidPolicy,
      expected: {
        supportsLocalRuntime: true,
        backendTimeoutMs: 180_000,
        agentReadyTimeoutMs: 300_000,
        probeForExistingInstall: false,
        defaultTarget: "cloud-managed",
        nativeConsecutiveFailureBudgetMs: 90_000,
      },
    },
    {
      name: "elizaOS",
      factory: createElizaOSPolicy,
      expected: {
        supportsLocalRuntime: true,
        backendTimeoutMs: 180_000,
        agentReadyTimeoutMs: 300_000,
        probeForExistingInstall: true,
        defaultTarget: "embedded-local",
        nativeConsecutiveFailureBudgetMs: 90_000,
      },
    },
  ])("returns the $name platform contract", ({ factory, expected }) => {
    expect(factory()).toEqual(expected);
  });

  it("maps persisted connection modes to runtime targets", () => {
    expect(connectionModeToTarget("cloud")).toBe("cloud-managed");
    expect(connectionModeToTarget("remote")).toBe("remote-backend");
    expect(connectionModeToTarget("local")).toBe("embedded-local");
    expect(connectionModeToTarget(undefined)).toBe("embedded-local");
  });

  it.each([
    ["restoring-session", true, false, "starting-backend"],
    ["resolving-target", true, false, "starting-backend"],
    ["polling-backend", true, false, "starting-backend"],
    ["starting-runtime", true, false, "initializing-agent"],
    ["hydrating", true, false, "ready"],
    ["ready", false, true, "ready"],
    ["error", false, true, "ready"],
    ["pairing-required", false, false, "ready"],
  ] as const)("classifies %s for loading, terminal, and legacy consumers", (phase, loading, terminal, legacy) => {
    const state =
      phase === "error"
        ? ({
            phase,
            reason: "agent-error",
            message: "failed",
            timedOut: false,
          } as const)
        : phase === "resolving-target"
          ? ({ phase, target: "embedded-local" } as const)
          : phase === "polling-backend"
            ? ({ phase, target: "embedded-local", attempts: 0 } as const)
            : phase === "starting-runtime"
              ? ({
                  phase,
                  target: "embedded-local",
                  attempts: 0,
                } as const)
              : ({ phase } as StartupState);

    expect(isStartupLoading(state)).toBe(loading);
    expect(isStartupTerminal(state)).toBe(terminal);
    expect(toLegacyStartupPhase(state)).toBe(legacy);
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
