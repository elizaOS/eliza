// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import {
  runRestoringSession,
  type RestoringSessionDeps,
} from "./startup-phase-restore";

const bridgeMock = vi.hoisted(() => ({
  getBackendStartupTimeoutMs: vi.fn(() => 180_000),
  invokeDesktopBridgeRequestWithTimeout: vi.fn(async () => ({
    status: "timeout" as const,
  })),
  isElectrobunRuntime: vi.fn(() => true),
  scanProviderCredentials: vi.fn(async () => []),
}));

const onboardingBootstrapMock = vi.hoisted(() => ({
  detectExistingOnboardingConnection: vi.fn(async () => null),
}));

vi.mock("../bridge", () => bridgeMock);
vi.mock("./onboarding-bootstrap", () => onboardingBootstrapMock);

function makeDeps(): RestoringSessionDeps {
  return {
    setStartupError: vi.fn(),
    setAuthRequired: vi.fn(),
    setConnected: vi.fn(),
    setOnboardingExistingInstallDetected: vi.fn(),
    setOnboardingOptions: vi.fn(),
    setOnboardingComplete: vi.fn(),
    setOnboardingLoading: vi.fn(),
    applyDetectedProviders: vi.fn(),
    forceLocalBootstrapRef: { current: false },
    onboardingCompletionCommittedRef: { current: false },
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
      hadPriorOnboarding: false,
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
