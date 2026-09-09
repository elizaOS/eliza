/** Verifies runRestoringSession desktop bridge startup calls through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * The restoring-session phase over the desktop RPC bridge
 * (`startup-phase-restore.runRestoringSession`): backend-startup timeout
 * handling and the force-fresh-first-run gate under Electrobun. jsdom with the
 * desktop bridge and first-run bootstrap mocked — no real host process.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyForceFreshFirstRunReset,
  enableForceFreshFirstRun,
  isForceFreshFirstRunEnabled,
} from "../platform";
import {
  clearPersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "./persistence";
import {
  type RestoringSessionDeps,
  runRestoringSession,
} from "./startup-phase-restore";

const bridgeMock = vi.hoisted(() => ({
  getBackendStartupTimeoutMs: vi.fn(() => 180_000),
  invokeDesktopBridgeRequestWithTimeout: vi.fn(
    async (): Promise<
      { status: "timeout" } | { status: "ok"; value: { mode: "local" } }
    > => ({ status: "timeout" }),
  ),
  isElectrobunRuntime: vi.fn(() => true),
  scanProviderCredentials: vi.fn(async () => []),
}));

const firstRunBootstrapMock = vi.hoisted(() => ({
  detectExistingFirstRunConnection: vi.fn(async () => null),
}));

vi.mock("../bridge", () => bridgeMock);
vi.mock("./first-run-bootstrap", () => firstRunBootstrapMock);

const CLOUD_AGENT_ID = "11111111-1111-4111-8111-111111111111";

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
    firstRunBootstrapMock.detectExistingFirstRunConnection.mockResolvedValue(
      null,
    );
    bridgeMock.invokeDesktopBridgeRequestWithTimeout.mockResolvedValue({
      status: "timeout",
    });
  });

  it.each([
    ["pagehide", "timeout"],
    ["unmount", "timeout"],
    ["pagehide", "local"],
    ["unmount", "local"],
  ])(
    "handles %s while a runtime RPC returning %s is pending",
    async (departure, runtimeMode) => {
      savePersistedActiveServer({
        id: "local",
        kind: "local",
        label: "Local Agent",
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      bridgeMock.invokeDesktopBridgeRequestWithTimeout.mockImplementation(
        async () => {
          await held;
          if (runtimeMode === "local")
            return { status: "ok", value: { mode: "local" } };
          return { status: "timeout" as const };
        },
      );
      const cancelled = { current: false };
      const controller = new AbortController();
      const dispatch = vi.fn();
      const result = runRestoringSession(
        makeDeps(),
        dispatch,
        { current: null },
        cancelled,
        controller.signal,
      ).then(
        () => "completed",
        (error: Error) => error.name,
      );
      await vi.waitFor(() =>
        expect(
          bridgeMock.invokeDesktopBridgeRequestWithTimeout,
        ).toHaveBeenCalled(),
      );
      if (departure === "unmount") cancelled.current = true;
      controller.abort();
      release();
      expect(await result).toBe(
        departure === "unmount" ? "completed" : "StewardSessionAuthorityError",
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(
        bridgeMock.invokeDesktopBridgeRequestWithTimeout,
      ).not.toHaveBeenCalledWith(
        expect.objectContaining({ rpcMethod: "agentStart" }),
      );
    },
  );

  it("does not enter onboarding from an old detection result after a new connection was selected", async () => {
    let release!: () => void;
    firstRunBootstrapMock.detectExistingFirstRunConnection.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
    );
    const dispatch = vi.fn();
    const result = runRestoringSession(
      makeDeps(),
      dispatch,
      { current: null },
      { current: false },
    ).then(
      () => "completed",
      (error: Error) => error.name,
    );
    await vi.waitFor(() =>
      expect(
        firstRunBootstrapMock.detectExistingFirstRunConnection,
      ).toHaveBeenCalled(),
    );
    savePersistedActiveServer({
      id: "new-connection",
      kind: "remote",
      label: "New connection",
      apiBase: "http://localhost:43123",
    });
    release();
    expect(await result).toBe("StewardSessionAuthorityError");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("observes pagehide before the initial hydration continuation can dispatch onboarding", async () => {
    const controller = new AbortController();
    const dispatch = vi.fn();
    const result = runRestoringSession(
      makeDeps(),
      dispatch,
      { current: null },
      { current: false },
      controller.signal,
    ).then(
      () => "completed",
      (error: Error) => error.name,
    );
    controller.abort();
    expect(await result).toBe("StewardSessionAuthorityError");
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      firstRunBootstrapMock.detectExistingFirstRunConnection,
    ).not.toHaveBeenCalled();
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

  it("preserves a remote connection established after the query reset cleared the prior target", async () => {
    window.history.replaceState(null, "", "/?reset");
    savePersistedActiveServer({
      id: "local",
      kind: "local",
      label: "Old Local Agent",
    });
    expect(applyForceFreshFirstRunReset()).toBe(true);

    // Android can replay this connect intent after module evaluation but before
    // the restoring-session effect consumes the force-fresh directive.
    savePersistedActiveServer({
      id: "remote:android-smoke",
      kind: "remote",
      label: "Android Smoke Host",
      apiBase: "http://127.0.0.1:31338",
    });
    const deps = makeDeps();
    const dispatch = vi.fn();
    const ctxRef = { current: null };

    await runRestoringSession(deps, dispatch, ctxRef, { current: false });

    expect(isForceFreshFirstRunEnabled()).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({
      type: "SESSION_RESTORED",
      target: "remote-backend",
    });
    expect(ctxRef.current).toMatchObject({
      restoredActiveServer: {
        id: "remote:android-smoke",
        apiBase: "http://127.0.0.1:31338",
      },
    });
  });

  it("does not preserve completed first-run during non-destructive onboarding replay", async () => {
    window.history.replaceState(null, "", "/chat?onboarding-replay=1");
    savePersistedFirstRunComplete(true);
    savePersistedActiveServer({
      id: `cloud:${CLOUD_AGENT_ID}`,
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: `https://${CLOUD_AGENT_ID}.elizacloud.ai`,
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
