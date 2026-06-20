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
  prepareFirstRunVoiceAndTranscription: vi.fn(async () => null),
  savePersistedActiveServer: vi.fn(),
  showActionBanner: vi.fn(),
  setTab: vi.fn(),
  setBaseUrl: vi.fn(),
  setState: vi.fn(),
  setToken: vi.fn(),
  submitFirstRun: vi.fn(async () => null),
  synthesizeFirstRunSpeech: vi.fn(async () => new ArrayBuffer(0)),
  getCloudStatus: vi.fn(),
  getCloudCompatAgents: vi.fn(),
  loadPersistedActiveServer: vi.fn<() => ActiveServerRecord | null>(() => null),
  selectOrProvisionCloudAgent: vi.fn<
    (opts: {
      preferAgentId?: string | null;
      forceCreate?: boolean;
      [key: string]: unknown;
    }) => Promise<{
      agentId: string;
      agentName: string;
      apiBase: string;
      bridgeUrl: string | null;
      created: boolean;
    }>
  >(async () => ({
    agentId: "agent-1",
    agentName: "Demo Agent",
    apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
    bridgeUrl: null,
    created: true,
  })),
  startCloudAgentHandoff: vi.fn(async () => ({
    status: "switched-empty" as const,
    imported: 0,
  })),
}));

type CompatAgent = {
  agent_id: string;
  agent_name: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
};

function compatAgent(overrides: Partial<CompatAgent> = {}): CompatAgent {
  return {
    agent_id: "agent-1",
    agent_name: "Agent One",
    status: "running",
    created_at: "2026-06-18T00:00:00.000Z",
    updated_at: "2026-06-18T00:00:00.000Z",
    last_heartbeat_at: null,
    ...overrides,
  };
}

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    registerPlugin: vi.fn(() => ({})),
  },
}));

vi.mock("../api", () => ({
  client: {
    getCloudStatus: mocks.getCloudStatus,
    getCloudCompatAgents: mocks.getCloudCompatAgents,
    selectOrProvisionCloudAgent: mocks.selectOrProvisionCloudAgent,
    startCloudAgentHandoff: mocks.startCloudAgentHandoff,
    setBaseUrl: mocks.setBaseUrl,
    setToken: mocks.setToken,
    getBaseUrl: () => "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
    submitFirstRun: mocks.submitFirstRun,
    synthesizeFirstRunSpeech: mocks.synthesizeFirstRunSpeech,
  },
}));

vi.mock("../api/client-cloud", () => ({
  getCloudAuthToken: () =>
    (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ ?? null,
  isDirectCloudSharedAgentBase: () => false,
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
  loadPersistedActiveServer: mocks.loadPersistedActiveServer,
  savePersistedActiveServer: mocks.savePersistedActiveServer,
  useApp: () => ({
    completeFirstRun: mocks.completeFirstRun,
    elizaCloudConnected: false,
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
  ANDROID_LOCAL_AGENT_SERVER_ID: "local:mobile",
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

describe("useFirstRunController cloud first-run", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.cloudAuthenticated = false;
    mocks.addAgentProfile.mockClear();
    mocks.completeFirstRun.mockClear();
    // mockReset (not mockClear): individual tests install custom
    // implementations (e.g. a never-resolving provisioning promise, or an
    // agent-x record). mockClear keeps those implementations, so they leak into
    // the next test — a never-resolving selectOrProvisionCloudAgent then hangs
    // the following test for the full 5s timeout and cascades. Reset + restore
    // the hoisted default so every test starts clean.
    mocks.createPersistedActiveServer.mockReset();
    mocks.createPersistedActiveServer.mockImplementation(
      (args: ActiveServerArgs): ActiveServerRecord => ({
        id: "cloud:agent-1",
        kind: "cloud",
        label: "Demo Agent",
        ...(args.apiBase ? { apiBase: args.apiBase } : {}),
        ...(args.accessToken ? { accessToken: args.accessToken } : {}),
      }),
    );
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
    // Default: the signed-in user has no cloud agents → the picker is skipped
    // and finishCloud auto-creates (current behavior). Tests that exercise the
    // picker override this to return >=1 agents.
    mocks.getCloudCompatAgents.mockReset();
    mocks.getCloudCompatAgents.mockImplementation(async () => ({
      success: true,
      data: [],
    }));
    mocks.loadPersistedActiveServer.mockReset();
    mocks.loadPersistedActiveServer.mockReturnValue(null);
    mocks.persistMobileRuntimeModeForServerTarget.mockClear();
    mocks.preOpenWindow.mockClear();
    mocks.selectOrProvisionCloudAgent.mockReset();
    mocks.selectOrProvisionCloudAgent.mockImplementation(async () => ({
      agentId: "agent-1",
      agentName: "Demo Agent",
      apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
      bridgeUrl: null,
      created: true,
    }));
    mocks.startCloudAgentHandoff.mockClear();
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
    expect(mocks.selectOrProvisionCloudAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudApiBase: "https://www.elizacloud.ai",
        authToken: "cloud-token",
        name: "Demo Agent",
        bio: expect.any(Array),
        onProgress: expect.any(Function),
      }),
    );
    expect(mocks.setBaseUrl).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
    );
    expect(mocks.setToken).toHaveBeenCalledWith("cloud-token");
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cloud",
        label: "Demo Agent",
        apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
        accessToken: "cloud-token",
      }),
    );
    expect(mocks.addAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cloud",
        label: "Demo Agent",
        apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
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
    // A freshly created agent (created, no bridge URL yet) is served by the
    // shared adapter while its container boots — so the background shared→
    // personal handoff is armed to migrate + switch once the container is ready.
    expect(mocks.startCloudAgentHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sharedApiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
        conversationId: "agent-1",
        authToken: "cloud-token",
        onSwitch: expect.any(Function),
      }),
    );
  });

  it("auto-creates (no forceCreate) and skips the picker when the user has 0 agents", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    // 0 agents → the picker is skipped and we auto-create (no forceCreate),
    // preserving the brand-new-user behavior with no extra click.
    expect(mocks.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(
      mocks.selectOrProvisionCloudAgent.mock.calls[0][0].forceCreate,
    ).toBeUndefined();
    expect(mocks.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });
  });

  it("shows the picker (ready, sorted newest-first) without provisioning when the user has agents", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        compatAgent({
          agent_id: "older",
          status: "stopped",
          created_at: "2026-06-10T00:00:00.000Z",
        }),
        compatAgent({
          agent_id: "newer",
          status: "stopped",
          created_at: "2026-06-18T00:00:00.000Z",
        }),
      ],
    });
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    expect(result.current.step).toBe("pick-agent");
    expect(result.current.pickerPhase).toBe("ready");
    expect(result.current.pickerAgents.map((a) => a.agent_id)).toEqual([
      "newer",
      "older",
    ]);
    // No provisioning happens until the user makes a choice.
    expect(mocks.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
  });

  it("onPickAgent provisions with preferAgentId, persists cloud:<id>, and completes", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [compatAgent({ agent_id: "agent-x", agent_name: "Pick Me" })],
    });
    mocks.selectOrProvisionCloudAgent.mockResolvedValue({
      agentId: "agent-x",
      agentName: "Pick Me",
      apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-x",
      bridgeUrl: null,
      created: false,
    });
    mocks.createPersistedActiveServer.mockImplementation(
      (args: ActiveServerArgs): ActiveServerRecord => ({
        id: "cloud:agent-x",
        kind: "cloud",
        label: "Pick Me",
        ...(args.apiBase ? { apiBase: args.apiBase } : {}),
        ...(args.accessToken ? { accessToken: args.accessToken } : {}),
      }),
    );
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });
    await act(async () => {
      await result.current.onPickAgent("agent-x");
    });

    expect(mocks.selectOrProvisionCloudAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preferAgentId: "agent-x" }),
    );
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cloud:agent-x" }),
    );
    expect(mocks.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });
  });

  it("onCreateNewAgent provisions with forceCreate:true", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [compatAgent({ agent_id: "agent-1" })],
    });
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });
    await act(async () => {
      await result.current.onCreateNewAgent();
    });

    expect(mocks.selectOrProvisionCloudAgent).toHaveBeenCalledWith(
      expect.objectContaining({ forceCreate: true }),
    );
    expect(mocks.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });
  });

  it("holds on an error state and does NOT auto-create when the agent fetch fails", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: false,
      data: [],
      error: "Could not load your agents.",
    });
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    expect(result.current.step).toBe("pick-agent");
    expect(result.current.pickerPhase).toBe("error");
    expect(result.current.pickerError).toBe("Could not load your agents.");
    expect(mocks.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
    expect(mocks.completeFirstRun).not.toHaveBeenCalled();
  });

  it("onPickAgent no-ops for the already-active agent", async () => {
    mocks.loadPersistedActiveServer.mockReturnValue({
      id: "cloud:active-1",
      kind: "cloud",
      label: "Active",
    });
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [compatAgent({ agent_id: "active-1" })],
    });
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });
    expect(result.current.pickerActiveAgentId).toBe("active-1");

    await act(async () => {
      await result.current.onPickAgent("active-1");
    });

    expect(mocks.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
  });

  it("provisions once when onCreateNewAgent is invoked twice during binding", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [compatAgent({ agent_id: "agent-1" })],
    });
    // Hold the provisioning call open so the second invocation lands while the
    // first is still binding.
    let release: (() => void) | null = null;
    mocks.selectOrProvisionCloudAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              agentId: "agent-1",
              agentName: "Agent One",
              apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
              bridgeUrl: null,
              created: true,
            });
        }),
    );
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    await act(async () => {
      void result.current.onCreateNewAgent();
      void result.current.onCreateNewAgent();
      await Promise.resolve();
      release?.();
    });

    expect(mocks.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
  });

  it("auto-creates (no forceCreate) and skips the picker when the user has 0 agents", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    // 0 agents → the picker is skipped and we auto-create (no forceCreate),
    // preserving the brand-new-user behavior with no extra click.
    expect(mocks.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(
      mocks.selectOrProvisionCloudAgent.mock.calls[0][0].forceCreate,
    ).toBeUndefined();
    expect(mocks.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });
  });

  it("shows the picker (ready, sorted newest-first) without provisioning when the user has agents", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        compatAgent({
          agent_id: "older",
          status: "stopped",
          created_at: "2026-06-10T00:00:00.000Z",
        }),
        compatAgent({
          agent_id: "newer",
          status: "stopped",
          created_at: "2026-06-18T00:00:00.000Z",
        }),
      ],
    });
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    expect(result.current.step).toBe("pick-agent");
    expect(result.current.pickerPhase).toBe("ready");
    expect(result.current.pickerAgents.map((a) => a.agent_id)).toEqual([
      "newer",
      "older",
    ]);
    // No provisioning happens until the user makes a choice.
    expect(mocks.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
  });

  it("onPickAgent provisions with preferAgentId, persists cloud:<id>, and completes", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [compatAgent({ agent_id: "agent-x", agent_name: "Pick Me" })],
    });
    mocks.selectOrProvisionCloudAgent.mockResolvedValue({
      agentId: "agent-x",
      agentName: "Pick Me",
      apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-x",
      bridgeUrl: null,
      created: false,
    });
    mocks.createPersistedActiveServer.mockImplementation(
      (args: ActiveServerArgs): ActiveServerRecord => ({
        id: "cloud:agent-x",
        kind: "cloud",
        label: "Pick Me",
        ...(args.apiBase ? { apiBase: args.apiBase } : {}),
        ...(args.accessToken ? { accessToken: args.accessToken } : {}),
      }),
    );
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });
    await act(async () => {
      await result.current.onPickAgent("agent-x");
    });

    expect(mocks.selectOrProvisionCloudAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preferAgentId: "agent-x" }),
    );
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cloud:agent-x" }),
    );
    expect(mocks.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });
  });

  it("onCreateNewAgent provisions with forceCreate:true", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [compatAgent({ agent_id: "agent-1" })],
    });
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });
    await act(async () => {
      await result.current.onCreateNewAgent();
    });

    expect(mocks.selectOrProvisionCloudAgent).toHaveBeenCalledWith(
      expect.objectContaining({ forceCreate: true }),
    );
    expect(mocks.completeFirstRun).toHaveBeenCalledWith("chat", {
      launchCompanionOverlay: true,
    });
  });

  it("holds on an error state and does NOT auto-create when the agent fetch fails", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: false,
      data: [],
      error: "Could not load your agents.",
    });
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    expect(result.current.step).toBe("pick-agent");
    expect(result.current.pickerPhase).toBe("error");
    expect(result.current.pickerError).toBe("Could not load your agents.");
    expect(mocks.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
    expect(mocks.completeFirstRun).not.toHaveBeenCalled();
  });

  it("onPickAgent no-ops for the already-active agent", async () => {
    mocks.loadPersistedActiveServer.mockReturnValue({
      id: "cloud:active-1",
      kind: "cloud",
      label: "Active",
    });
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [compatAgent({ agent_id: "active-1" })],
    });
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });
    expect(result.current.pickerActiveAgentId).toBe("active-1");

    await act(async () => {
      await result.current.onPickAgent("active-1");
    });

    expect(mocks.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
  });

  it("provisions once when onCreateNewAgent is invoked twice during binding", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [compatAgent({ agent_id: "agent-1" })],
    });
    // Hold the provisioning call open so the second invocation lands while the
    // first is still binding.
    let release: (() => void) | null = null;
    mocks.selectOrProvisionCloudAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              agentId: "agent-1",
              agentName: "Agent One",
              apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
              bridgeUrl: null,
              created: true,
            });
        }),
    );
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    await act(async () => {
      void result.current.onCreateNewAgent();
      void result.current.onCreateNewAgent();
      await Promise.resolve();
      release?.();
    });

    expect(mocks.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
  });
});
