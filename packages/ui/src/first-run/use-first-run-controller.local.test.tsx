// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Desktop all-local finish path for `useFirstRunController.finishLocal`.
// Mirrors the cloud test harness in `use-first-run-controller.test.tsx` but
// pins the platform to Electrobun desktop with the local runtime selectable.

const mocks = vi.hoisted(() => ({
  elizaCloudConnected: false,
  addAgentProfile: vi.fn(),
  autoDownloadRecommendedLocalModelInBackground: vi.fn(),
  completeFirstRun: vi.fn(),
  createPersistedActiveServer: vi.fn(),
  getAuthStatus: vi.fn(async () => ({
    required: false,
    pairingEnabled: false,
    expiresAt: null,
  })),
  getDesktopRuntimeMode: vi.fn(async () => null),
  handleCloudLogin: vi.fn(async () => {}),
  invokeDesktopBridgeRequest: vi.fn(async () => null),
  microphoneOpenSettings: vi.fn(async () => {}),
  microphoneRequest: vi.fn(async () => {}),
  persistMobileRuntimeModeForServerTarget: vi.fn(),
  preOpenWindow: vi.fn(() => null),
  prepareFirstRunVoiceAndTranscription: vi.fn(async () => null),
  savePersistedActiveServer: vi.fn(),
  setActionNotice: vi.fn(),
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
    branding: { cloudOnly: false },
    cloudApiBase: "https://www.elizacloud.ai",
  }),
}));

vi.mock("../platform/init", () => ({
  canSelectLocalRuntime: () => true,
  isAndroid: false,
  isDesktopPlatform: () => true,
  isIOS: false,
}));

vi.mock("../state", () => ({
  addAgentProfile: mocks.addAgentProfile,
  createPersistedActiveServer: mocks.createPersistedActiveServer,
  savePersistedActiveServer: mocks.savePersistedActiveServer,
  useApp: () => ({
    completeFirstRun: mocks.completeFirstRun,
    elizaCloudConnected: mocks.elizaCloudConnected,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: null,
    firstRunName: "Demo Agent",
    handleCloudLogin: mocks.handleCloudLogin,
    setActionNotice: mocks.setActionNotice,
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
  autoDownloadRecommendedLocalModelInBackground:
    mocks.autoDownloadRecommendedLocalModelInBackground,
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
  mocks.elizaCloudConnected = false;
  mocks.addAgentProfile.mockClear();
  mocks.autoDownloadRecommendedLocalModelInBackground.mockClear();
  mocks.completeFirstRun.mockClear();
  mocks.getAuthStatus.mockClear();
  mocks.getDesktopRuntimeMode.mockClear();
  mocks.getDesktopRuntimeMode.mockResolvedValue(null);
  mocks.handleCloudLogin.mockClear();
  mocks.invokeDesktopBridgeRequest.mockClear();
  mocks.persistMobileRuntimeModeForServerTarget.mockClear();
  mocks.preOpenWindow.mockClear();
  mocks.savePersistedActiveServer.mockClear();
  mocks.setBaseUrl.mockClear();
  mocks.setState.mockClear();
  mocks.setToken.mockClear();
  mocks.submitFirstRun.mockClear();
}

describe("useFirstRunController local first-run", () => {
  beforeEach(resetMocks);

  afterEach(() => {
    cleanup();
  });

  it("provisions the on-device agent for the all-local desktop happy path", async () => {
    const { result } = renderHook(() => useFirstRunController());

    act(() => {
      result.current.updateDraft("runtime", "local");
    });

    await act(async () => {
      await result.current.finishRuntime();
    });

    // Desktop startLocalRuntime invokes the agentStart bridge request.
    expect(mocks.getDesktopRuntimeMode).toHaveBeenCalledTimes(1);
    expect(mocks.invokeDesktopBridgeRequest).toHaveBeenCalledWith({
      rpcMethod: "agentStart",
      ipcChannel: "agent:start",
    });

    // Client repoints at the local agent api base and clears the token
    // (desktop is neither Android nor iOS, so no on-device bearer).
    expect(mocks.setBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:31337");
    expect(mocks.setToken).toHaveBeenCalledWith(null);

    // waitForAgentApi probes getAuthStatus until ready.
    expect(mocks.getAuthStatus).toHaveBeenCalled();

    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith({
      id: "local:desktop",
      kind: "remote",
      label: "Local agent",
      apiBase: "http://127.0.0.1:31337",
    });
    expect(mocks.addAgentProfile).toHaveBeenCalledWith({
      kind: "remote",
      label: "Local agent",
      apiBase: "http://127.0.0.1:31337",
    });
    expect(mocks.persistMobileRuntimeModeForServerTarget).toHaveBeenCalledWith(
      "local",
    );
    expect(mocks.setState).toHaveBeenCalledWith(
      "firstRunRuntimeTarget",
      "local",
    );

    // Local + all-local submits with sandbox disabled and runs the model
    // auto-download in the background.
    expect(mocks.submitFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Demo Agent", sandboxMode: "off" }),
    );
    expect(
      mocks.autoDownloadRecommendedLocalModelInBackground,
    ).toHaveBeenCalledWith("http://127.0.0.1:31337");

    // First-run persistence is cleared and the flow lands in chat.
    expect(localStorage.getItem("eliza:first-run")).toBeNull();
    expect(mocks.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });

    // The cloud connect gate must never fire on the all-local path.
    expect(mocks.handleCloudLogin).not.toHaveBeenCalled();
  });

  it("redirects to cloud connect for hybrid (cloud-inference) and returns before submitting", async () => {
    const { result } = renderHook(() => useFirstRunController());

    act(() => {
      result.current.updateDraft("runtime", "local");
      result.current.updateDraft("localInference", "cloud-inference");
    });

    await act(async () => {
      await result.current.finishRuntime();
    });

    // Hybrid needs the Eliza Cloud account first: it flags the hybrid target +
    // provider, opens login, and returns without finishing setup.
    expect(mocks.setState).toHaveBeenCalledWith(
      "firstRunRuntimeTarget",
      "elizacloud-hybrid",
    );
    expect(mocks.setState).toHaveBeenCalledWith(
      "firstRunProvider",
      "elizacloud",
    );
    expect(mocks.handleCloudLogin).toHaveBeenCalledTimes(1);

    expect(mocks.submitFirstRun).not.toHaveBeenCalled();
    expect(mocks.completeFirstRun).not.toHaveBeenCalled();
    expect(mocks.invokeDesktopBridgeRequest).not.toHaveBeenCalled();
    expect(
      mocks.autoDownloadRecommendedLocalModelInBackground,
    ).not.toHaveBeenCalled();
  });

  it("finishes hybrid without a model download once the cloud account is connected", async () => {
    mocks.elizaCloudConnected = true;
    const { result } = renderHook(() => useFirstRunController());

    act(() => {
      result.current.updateDraft("runtime", "local");
      result.current.updateDraft("localInference", "cloud-inference");
    });

    await act(async () => {
      await result.current.finishRuntime();
    });

    // Already connected: no login gate, the hybrid agent provisions locally.
    expect(mocks.handleCloudLogin).not.toHaveBeenCalled();
    expect(mocks.invokeDesktopBridgeRequest).toHaveBeenCalledWith({
      rpcMethod: "agentStart",
      ipcChannel: "agent:start",
    });
    expect(mocks.submitFirstRun).toHaveBeenCalledTimes(1);
    expect(mocks.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });

    // cloud-inference must NOT download an on-device model.
    expect(
      mocks.autoDownloadRecommendedLocalModelInBackground,
    ).not.toHaveBeenCalled();
  });
});
