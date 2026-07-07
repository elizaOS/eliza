// @vitest-environment jsdom

/**
 * The restoring-session phase over the desktop RPC bridge
 * (`startup-phase-restore.runRestoringSession`): backend-startup timeout
 * handling and the force-fresh-first-run gate under Electrobun. jsdom with the
 * desktop bridge and first-run bootstrap mocked — no real host process.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enableForceFreshFirstRun,
  isForceFreshFirstRunEnabled,
} from "../platform";
import {
  clearPersistedActiveServer,
  savePersistedFirstRunComplete,
  savePersistedActiveServer,
} from "./persistence";
import {
  type RestoringSessionDeps,
  runRestoringSession,
} from "./startup-phase-restore";

const bridgeMock = vi.hoisted(() => ({
  getBackendStartupTimeoutMs: vi.fn(() => 180_000),
  invokeDesktopBridgeRequestWithTimeout: vi.fn(async () => ({
    status: "timeout" as const,
  })),
  isElectrobunRuntime: vi.fn(() => true),
  scanProviderCredentials: vi.fn(async () => []),
}));

const firstRunBootstrapMock = vi.hoisted(() => ({
  detectExistingFirstRunConnection: vi.fn(async () => null),
}));

vi.mock("../bridge", () => bridgeMock);
vi.mock("./first-run-bootstrap", () => firstRunBootstrapMock);

function makeDeps(): RestoringSessionDeps {
  return {
    setStartupError: vi.fn(),
    setAuthRequired: vi.fn(),
    setConnected: vi.fn(),
    setFirstRunOptions: vi.fn(),
    setFirstRunComplete: vi.fn(),
    setFirstRunLoading: vi.fn(),
    firstRunCompletionCommittedRef: { current: false },
    uiLanguage: "en",
  };
}

describe("runRestoringSession desktop bridge startup calls", () => {
  beforeEach(() => {
    localStorage.clear();
    clearPersistedActiveServer();
    vi.clearAllMocks();
    bridgeMock.invokeDesktopBridgeRequestWithTimeout.mockResolvedValue({
      status: "timeout",
    });
  });

  it("routes a fresh desktop launch with no persisted server into onboarding", async () => {
    const deps = makeDeps();
    const dispatch = vi.fn();
    const ctxRef = { current: null };

    await runRestoringSession(deps, dispatch, ctxRef, { current: false });

    expect(dispatch).toHaveBeenCalledWith({
      type: "NO_SESSION",
      hadPriorFirstRun: false,
    });
  });

  it("continues into backend polling when restored local desktop runtime RPCs time out", async () => {
    savePersistedActiveServer({
      id: "local",
      kind: "local",
      label: "Local Agent",
    });
    const deps = makeDeps();
    const dispatch = vi.fn();
    const ctxRef = { current: null };

    await runRestoringSession(deps, dispatch, ctxRef, { current: false });

    expect(
      bridgeMock.invokeDesktopBridgeRequestWithTimeout,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopGetRuntimeMode",
        ipcChannel: "desktop:getRuntimeMode",
        timeoutMs: 5_000,
      }),
    );
    expect(
      bridgeMock.invokeDesktopBridgeRequestWithTimeout,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "agentStart",
        ipcChannel: "agent:start",
        timeoutMs: 5_000,
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "SESSION_RESTORED",
      target: "embedded-local",
    });
  });

  it("clears the one-shot force-fresh flag after consuming it so the next launch is not forced to onboard again", async () => {
    enableForceFreshFirstRun();
    savePersistedActiveServer({
      id: "local",
      kind: "local",
      label: "Local Agent",
    });
    expect(isForceFreshFirstRunEnabled()).toBe(true);

    const deps = makeDeps();
    const dispatch = vi.fn();
    const ctxRef = { current: null };

    await runRestoringSession(deps, dispatch, ctxRef, { current: false });

    // This launch still onboards (the one-shot directive is honored)...
    expect(dispatch).toHaveBeenCalledWith({
      type: "NO_SESSION",
      hadPriorFirstRun: false,
    });
    // ...but the flag is gone, so the next launch is back to normal behavior
    // even if onboarding completes via a path that never POSTs first-run.
    expect(isForceFreshFirstRunEnabled()).toBe(false);
  });

  it("does not preserve completed first-run during non-destructive onboarding replay", async () => {
    window.history.replaceState(null, "", "/chat?onboarding-replay=1");
    savePersistedFirstRunComplete(true);
    savePersistedActiveServer({
      id: "cloud:agent-123",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://agent-123.elizacloud.ai",
      accessToken: "agent-token",
    });
    const deps = makeDeps();
    const dispatch = vi.fn();
    const ctxRef = { current: null };

    await runRestoringSession(deps, dispatch, ctxRef, { current: false });

    expect(ctxRef.current).toMatchObject({
      shouldPreserveCompletedFirstRun: false,
      hadPriorFirstRun: true,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "SESSION_RESTORED",
      target: "cloud-managed",
    });
  });
});
