// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// finishRemote / finishCloud (login-abort) + persisted-state resume for
// `useFirstRunController`. Web platform (no local runtime), cloudOnly off.

type AuthStatus = {
  required: boolean;
  pairingEnabled: boolean;
  expiresAt: number | null;
};

const mocks = vi.hoisted(() => ({
  cloudOnly: false,
  cloudConnected: false,
  addAgentProfile: vi.fn(),
  completeFirstRun: vi.fn(),
  createPersistedActiveServer: vi.fn(),
  getAuthStatus: vi.fn(),
  getCloudStatus: vi.fn(),
  getDesktopRuntimeMode: vi.fn(async () => null),
  getFirstRunStatus: vi.fn(async () => ({ complete: false })),
  handleCloudLogin: vi.fn(async () => {}),
  invokeDesktopBridgeRequest: vi.fn(async () => null),
  microphoneOpenSettings: vi.fn(async () => {}),
  microphoneRequest: vi.fn(async () => {}),
  persistMobileRuntimeModeForServerTarget: vi.fn(),
  preOpenWindow: vi.fn(() => null),
  prepareFirstRunVoiceAndTranscription: vi.fn(async () => null),
  selectOrProvisionCloudAgent: vi.fn(),
  savePersistedActiveServer: vi.fn(),
  showActionBanner: vi.fn(),
  setTab: vi.fn(),
  setBaseUrl: vi.fn(),
  setState: vi.fn(),
  setToken: vi.fn(),
  submitFirstRun: vi.fn(async () => null),
  synthesizeFirstRunSpeech: vi.fn(async () => new ArrayBuffer(0)),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    registerPlugin: vi.fn(() => ({})),
  },
}));

vi.mock("../api", () => ({
  client: {
    getAuthStatus: mocks.getAuthStatus,
    getCloudStatus: mocks.getCloudStatus,
    getFirstRunStatus: mocks.getFirstRunStatus,
    selectOrProvisionCloudAgent: mocks.selectOrProvisionCloudAgent,
    setBaseUrl: mocks.setBaseUrl,
    setToken: mocks.setToken,
    submitFirstRun: mocks.submitFirstRun,
    synthesizeFirstRunSpeech: mocks.synthesizeFirstRunSpeech,
  },
}));

vi.mock("../bridge", () => ({
  getDesktopRuntimeMode: mocks.getDesktopRuntimeMode,
  invokeDesktopBridgeRequest: mocks.invokeDesktopBridgeRequest,
}));

vi.mock("../config/boot-config", () => ({
  getBootConfig: () => ({
    branding: { cloudOnly: mocks.cloudOnly },
    cloudApiBase: "https://www.elizacloud.ai",
  }),
}));

vi.mock("../platform/init", () => ({
  canSelectLocalRuntime: () => false,
  isAndroid: false,
  isDesktopPlatform: () => false,
  isIOS: false,
}));

vi.mock("../state", () => ({
  addAgentProfile: mocks.addAgentProfile,
  createPersistedActiveServer: mocks.createPersistedActiveServer,
  savePersistedActiveServer: mocks.savePersistedActiveServer,
  useApp: () => ({
    completeFirstRun: mocks.completeFirstRun,
    elizaCloudConnected: mocks.cloudConnected,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: null,
    firstRunName: "Demo Agent",
    handleCloudLogin: mocks.handleCloudLogin,
    showActionBanner: mocks.showActionBanner,
    setTab: mocks.setTab,
    setState: mocks.setState,
    uiLanguage: "en",
  }),
}));

vi.mock("../utils", () => ({
  isCloudStatusAuthenticated: (connected: boolean) => connected,
  preOpenWindow: mocks.preOpenWindow,
}));

vi.mock("../voice", () => ({
  createVoiceCapture: vi.fn(),
}));

vi.mock("../voice/local-asr-capture", () => ({
  isLocalAsrCaptureSupported: () => false,
}));

vi.mock("./auto-download-recommended", () => ({
  autoDownloadRecommendedLocalModelInBackground: vi.fn(),
}));

vi.mock("./mobile-runtime-mode", () => ({
  ANDROID_LOCAL_AGENT_LABEL: "On-device agent",
  ANDROID_LOCAL_AGENT_SERVER_ID: "local:android",
  MOBILE_LOCAL_AGENT_LABEL: "On-device agent",
  MOBILE_LOCAL_AGENT_SERVER_ID: "local:mobile",
  persistMobileRuntimeModeForServerTarget:
    mocks.persistMobileRuntimeModeForServerTarget,
}));

vi.mock("./reload-into-first-run-runtime", () => ({
  readFirstRunRuntimeTarget: () => null,
}));

vi.mock("./use-microphone-permission", () => ({
  useMicrophonePermission: () => ({
    status: "granted",
    canRequest: false,
    requesting: false,
    request: mocks.microphoneRequest,
    openSettings: mocks.microphoneOpenSettings,
  }),
}));

vi.mock("./voice-readiness", () => ({
  FIRST_RUN_VOICE_PREPARING_MESSAGE: "Preparing voice",
  prepareFirstRunVoiceAndTranscription:
    mocks.prepareFirstRunVoiceAndTranscription,
  resolveFirstRunLocalAgentApiBase: () => "http://127.0.0.1:31337",
}));

import { useFirstRunController } from "./use-first-run-controller";

const okAuth: AuthStatus = {
  required: false,
  pairingEnabled: false,
  expiresAt: null,
};

// This jsdom env exposes `window.localStorage` as an object without methods;
// install a real in-memory Storage (mirrors `first-run.test.ts`) so the file
// is self-contained instead of relying on another suite's side effect.
function ensureLocalStorage(): Storage {
  if (typeof window.localStorage?.clear === "function") {
    return window.localStorage;
  }
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  } satisfies Storage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

function resetMocks(): void {
  ensureLocalStorage().clear();
  mocks.cloudOnly = false;
  mocks.cloudConnected = false;
  for (const fn of [
    mocks.addAgentProfile,
    mocks.completeFirstRun,
    mocks.createPersistedActiveServer,
    mocks.getAuthStatus,
    mocks.getCloudStatus,
    mocks.getFirstRunStatus,
    mocks.handleCloudLogin,
    mocks.invokeDesktopBridgeRequest,
    mocks.persistMobileRuntimeModeForServerTarget,
    mocks.preOpenWindow,
    mocks.selectOrProvisionCloudAgent,
    mocks.savePersistedActiveServer,
    mocks.setBaseUrl,
    mocks.setState,
    mocks.setToken,
    mocks.submitFirstRun,
  ]) {
    fn.mockClear();
  }
  mocks.getAuthStatus.mockResolvedValue(okAuth);
  mocks.getFirstRunStatus.mockResolvedValue({ complete: false });
}

describe("useFirstRunController remote first-run", () => {
  beforeEach(resetMocks);
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(globalThis, "__ELIZA_CLOUD_AUTH_TOKEN__");
  });

  it("connects to a valid remote agent with a token and finishes", async () => {
    const { result } = renderHook(() => useFirstRunController());

    act(() => {
      result.current.updateDraft("runtime", "remote");
      result.current.updateDraft("remoteApiBase", "https://agent.example.com");
      result.current.updateDraft("remoteToken", "secret-token");
    });

    await act(async () => {
      await result.current.finishRuntime();
    });

    expect(mocks.getAuthStatus).toHaveBeenCalledTimes(1);
    expect(mocks.getFirstRunStatus).toHaveBeenCalledTimes(1);
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith({
      id: "remote:https://agent.example.com",
      kind: "remote",
      label: "https://agent.example.com",
      apiBase: "https://agent.example.com",
      accessToken: "secret-token",
    });
    expect(mocks.setState).toHaveBeenCalledWith(
      "firstRunRuntimeTarget",
      "remote",
    );
    expect(mocks.setState).toHaveBeenCalledWith(
      "firstRunRemoteConnected",
      true,
    );
    expect(mocks.submitFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Demo Agent",
        deploymentTarget: expect.objectContaining({ runtime: "remote" }),
      }),
    );
    expect(localStorage.getItem("eliza:first-run")).toBeNull();
    expect(mocks.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });
    expect(result.current.error).toBeNull();
  });

  it("surfaces the access-token error when the remote agent requires auth", async () => {
    mocks.getAuthStatus.mockResolvedValue({
      required: true,
      pairingEnabled: false,
      expiresAt: null,
    });
    const { result } = renderHook(() => useFirstRunController());

    act(() => {
      result.current.updateDraft("runtime", "remote");
      result.current.updateDraft("remoteApiBase", "https://agent.example.com");
      result.current.updateDraft("remoteToken", "");
    });

    await act(async () => {
      await result.current.finishRuntime();
    });

    expect(result.current.error).toBe(
      "This remote agent requires an access token.",
    );
    // Auth gate aborts before persistence + submit + complete.
    expect(mocks.getFirstRunStatus).not.toHaveBeenCalled();
    expect(mocks.savePersistedActiveServer).not.toHaveBeenCalled();
    expect(mocks.submitFirstRun).not.toHaveBeenCalled();
    expect(mocks.completeFirstRun).not.toHaveBeenCalled();
  });

  it("returns without provisioning when cloud login is aborted", async () => {
    // Cloud runtime, not connected → finishCloud opens login. The login
    // resolves but cloud stays disconnected (user closed the window), so the
    // flow must return before provisioning.
    mocks.getCloudStatus.mockResolvedValue({
      connected: false,
      reason: "missing-token",
    });
    mocks.handleCloudLogin.mockResolvedValue(undefined);

    const { result } = renderHook(() => useFirstRunController());

    act(() => {
      result.current.updateDraft("runtime", "cloud");
    });

    await act(async () => {
      await result.current.finishRuntime();
    });

    expect(mocks.handleCloudLogin).toHaveBeenCalledTimes(1);
    expect(mocks.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
    expect(mocks.submitFirstRun).not.toHaveBeenCalled();
    expect(mocks.completeFirstRun).not.toHaveBeenCalled();
  });

  it("hydrates the persisted remote step on mount", () => {
    localStorage.setItem(
      "eliza:first-run",
      JSON.stringify({
        step: "remote",
        draft: {
          agentName: "Resumed Agent",
          runtime: "remote",
          localInference: "all-local",
          remoteApiBase: "https://resumed.example.com",
          remoteToken: "resumed-token",
        },
      }),
    );

    const { result } = renderHook(() => useFirstRunController());

    expect(result.current.step).toBe("remote");
    expect(result.current.draft).toMatchObject({
      agentName: "Resumed Agent",
      runtime: "remote",
      remoteApiBase: "https://resumed.example.com",
      remoteToken: "resumed-token",
    });
  });

  it("normalizes a persisted remote state back to cloud/runtime under cloudOnly", () => {
    mocks.cloudOnly = true;
    localStorage.setItem(
      "eliza:first-run",
      JSON.stringify({
        step: "remote",
        draft: {
          agentName: "Resumed Agent",
          runtime: "remote",
          localInference: "all-local",
          remoteApiBase: "https://resumed.example.com",
          remoteToken: "resumed-token",
        },
      }),
    );

    const { result } = renderHook(() => useFirstRunController());

    expect(result.current.cloudOnly).toBe(true);
    expect(result.current.step).toBe("runtime");
    expect(result.current.draft).toMatchObject({
      runtime: "cloud",
      remoteApiBase: "",
      remoteToken: "",
    });
  });
});
