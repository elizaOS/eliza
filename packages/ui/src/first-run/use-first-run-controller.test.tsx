// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ActiveServerArgs = {
  kind: "cloud";
  apiBase?: string;
  accessToken?: string;
};

type ActiveServerRecord = {
  id: string;
  kind: "cloud";
  label: string;
  apiBase?: string;
  accessToken?: string;
};

const mocks = vi.hoisted(() => ({
  cloudAuthenticated: false,
  addAgentProfile: vi.fn(),
  completeFirstRun: vi.fn(),
  createPersistedActiveServer: vi.fn(
    (args: ActiveServerArgs): ActiveServerRecord => ({
      id: "cloud:agent-1",
      kind: "cloud",
      label: "Demo Agent",
      ...(args.apiBase ? { apiBase: args.apiBase } : {}),
      ...(args.accessToken ? { accessToken: args.accessToken } : {}),
    }),
  ),
  getDesktopRuntimeMode: vi.fn(async () => null),
  handleCloudLogin: vi.fn(async () => {}),
  invokeDesktopBridgeRequest: vi.fn(async () => null),
  microphoneOpenSettings: vi.fn(async () => {}),
  microphoneRequest: vi.fn(async () => {}),
  persistMobileRuntimeModeForServerTarget: vi.fn(),
  preOpenWindow: vi.fn(() => null),
  requestProactiveIosPermissions: vi.fn(async () => ({
    running: false,
    message: null,
    completed: 0,
    total: 8,
    granted: 0,
    blocked: 0,
    states: [],
  })),
  prepareFirstRunVoiceAndTranscription: vi.fn(async () => null),
  savePersistedActiveServer: vi.fn(),
  setActionNotice: vi.fn(),
  setBaseUrl: vi.fn(),
  setState: vi.fn(),
  setToken: vi.fn(),
  submitFirstRun: vi.fn(async () => null),
  synthesizeFirstRunSpeech: vi.fn(async () => new ArrayBuffer(0)),
  getCloudStatus: vi.fn(),
  provisionCloudSandbox: vi.fn(async () => ({
    agentId: "agent-1",
    bridgeUrl: "https://agent-1.runtime.elizacloud.ai",
    webUiUrl: null,
  })),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    registerPlugin: vi.fn(() => ({})),
  },
}));

vi.mock("../api", () => ({
  client: {
    getCloudStatus: mocks.getCloudStatus,
    provisionCloudSandbox: mocks.provisionCloudSandbox,
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
    branding: { cloudOnly: true },
    cloudApiBase: "https://www.elizacloud.ai",
  }),
}));

vi.mock("../platform/init", () => ({
  canSelectLocalRuntime: () => false,
  isAndroid: false,
  isDesktopPlatform: () => false,
  isIOS: true,
}));

vi.mock("../state", () => ({
  addAgentProfile: mocks.addAgentProfile,
  createPersistedActiveServer: mocks.createPersistedActiveServer,
  savePersistedActiveServer: mocks.savePersistedActiveServer,
  useApp: () => ({
    completeFirstRun: mocks.completeFirstRun,
    elizaCloudConnected: false,
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
  autoDownloadRecommendedLocalModelInBackground: vi.fn(),
}));

vi.mock("./mobile-runtime-mode", () => ({
  ANDROID_LOCAL_AGENT_LABEL: "On-device agent",
  ANDROID_LOCAL_AGENT_SERVER_ID: "local:mobile",
  MOBILE_LOCAL_AGENT_LABEL: "On-device agent",
  MOBILE_LOCAL_AGENT_SERVER_ID: "local:mobile",
  persistMobileRuntimeModeForServerTarget:
    mocks.persistMobileRuntimeModeForServerTarget,
}));

vi.mock("./proactive-ios-permissions", () => ({
  EMPTY_PROACTIVE_IOS_PERMISSIONS_PROGRESS: {
    running: false,
    message: null,
    completed: 0,
    total: 8,
    granted: 0,
    blocked: 0,
    states: [],
  },
  requestProactiveIosPermissions: mocks.requestProactiveIosPermissions,
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

describe("useFirstRunController cloud first-run", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.cloudAuthenticated = false;
    mocks.addAgentProfile.mockClear();
    mocks.completeFirstRun.mockClear();
    mocks.createPersistedActiveServer.mockClear();
    mocks.getCloudStatus.mockReset();
    mocks.getCloudStatus.mockImplementation(async () => ({
      connected: mocks.cloudAuthenticated,
      reason: mocks.cloudAuthenticated ? "native-token" : "missing-token",
    }));
    mocks.handleCloudLogin.mockReset();
    mocks.handleCloudLogin.mockImplementation(async () => {
      mocks.cloudAuthenticated = true;
      Object.assign(globalThis, { __ELIZA_CLOUD_AUTH_TOKEN__: "cloud-token" });
    });
    mocks.persistMobileRuntimeModeForServerTarget.mockClear();
    mocks.preOpenWindow.mockClear();
    mocks.requestProactiveIosPermissions.mockClear();
    mocks.provisionCloudSandbox.mockClear();
    mocks.savePersistedActiveServer.mockClear();
    mocks.setBaseUrl.mockClear();
    mocks.setState.mockClear();
    mocks.setToken.mockClear();
    mocks.submitFirstRun.mockClear();
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(globalThis, "__ELIZA_CLOUD_AUTH_TOKEN__");
  });

  it("continues into cloud agent provisioning after native login authenticates", async () => {
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    expect(mocks.handleCloudLogin).toHaveBeenCalledTimes(1);
    expect(mocks.provisionCloudSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudApiBase: "https://www.elizacloud.ai",
        authToken: "cloud-token",
        name: "Demo Agent",
        bio: expect.any(Array),
        onProgress: expect.any(Function),
      }),
    );
    expect(mocks.setBaseUrl).toHaveBeenCalledWith(
      "https://agent-1.runtime.elizacloud.ai",
    );
    expect(mocks.setToken).toHaveBeenCalledWith("cloud-token");
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cloud",
        label: "Demo Agent",
        apiBase: "https://agent-1.runtime.elizacloud.ai",
        accessToken: "cloud-token",
      }),
    );
    expect(mocks.addAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cloud",
        label: "Demo Agent",
        apiBase: "https://agent-1.runtime.elizacloud.ai",
        accessToken: "cloud-token",
      }),
    );
    expect(mocks.persistMobileRuntimeModeForServerTarget).toHaveBeenCalledWith(
      "elizacloud",
    );
    expect(mocks.submitFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Demo Agent",
        sandboxMode: "standard",
      }),
    );
    expect(mocks.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });
  });
});
