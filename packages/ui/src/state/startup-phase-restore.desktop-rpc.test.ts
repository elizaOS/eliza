// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPersistedActiveServer,
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
    setFirstRunExistingInstallDetected: vi.fn(),
    setFirstRunOptions: vi.fn(),
    setFirstRunComplete: vi.fn(),
    setFirstRunLoading: vi.fn(),
    applyDetectedProviders: vi.fn(),
    forceLocalBootstrapRef: { current: false },
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

  it("does not leave restoring-session stuck when desktop install inspection times out", async () => {
    const deps = makeDeps();
    const dispatch = vi.fn();
    const ctxRef = { current: null };

    await runRestoringSession(deps, dispatch, ctxRef, { current: false });

    expect(
      bridgeMock.invokeDesktopBridgeRequestWithTimeout,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "agentInspectExistingInstall",
        ipcChannel: "agent:inspectExistingInstall",
        timeoutMs: 5_000,
      }),
    );
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
});
