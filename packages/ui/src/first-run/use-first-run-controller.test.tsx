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
  // Phase-1 shared-tier flag (boot-config). Default off → byte-identical to
  // pre-Phase-1; the create-both test flips it on to exercise the handoff arm.
  preferSharedCloudTier: false,
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
  // PR3 invisible re-point: the handoff's onSwitch delegates to this silent
  // path instead of switchAgentProfile (which would clear drafts + dispatch
  // SWITCH_AGENT → StartupScreen flash). Mock it to assert the WIRING; the
  // helper's internals (repointBaseUrl, no draft clear) are covered by
  // cloud/handoff/silent-repoint.test.ts.
  silentlyRepointToDedicated: vi.fn(),
  switchAgentProfile: vi.fn(),
  // Phase-1 create-both: when the shared-tier flag is on, the controller
  // provisions a SEPARATE dedicated agent (a plain create, no preferSharedTier)
  // as the handoff target.
  createCloudCompatAgent: vi.fn(async () => ({
    success: true as const,
    data: {
      agentId: "dedicated-1",
      agentName: "Demo Agent",
      jobId: "",
      status: "provisioning",
      nodeId: null,
      message: "Agent created",
    },
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
    createCloudCompatAgent: mocks.createCloudCompatAgent,
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
  isDirectCloudSharedAgentBase: (url: string | null | undefined) =>
    /\/api\/v1\/eliza\/agents\/[^/]+(?:\/bridge)?\/?$/.test(
      String(url ?? "").trim(),
    ),
}));

vi.mock("../bridge", () => ({
  getDesktopRuntimeMode: mocks.getDesktopRuntimeMode,
  invokeDesktopBridgeRequest: mocks.invokeDesktopBridgeRequest,
}));

vi.mock("../cloud/handoff/silent-repoint", () => ({
  silentlyRepointToDedicated: mocks.silentlyRepointToDedicated,
}));

vi.mock("../config/boot-config", () => ({
  getBootConfig: () => ({
    branding: { cloudOnly: true },
    cloudApiBase: "https://www.elizacloud.ai",
    preferSharedCloudTier: mocks.preferSharedCloudTier,
  }),
}));

vi.mock("../platform/init", () => ({
  canSelectLocalRuntime: () => false,
  isAndroid: false,
  isDesktopPlatform: () => false,
  isIOS: true,
}));

vi.mock("../state", () => {
  const getAppValue = () => ({
    completeFirstRun: mocks.completeFirstRun,
    elizaCloudConnected: false,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: null,
    firstRunName: "Demo Agent",
    handleCloudLogin: mocks.handleCloudLogin,
    showActionBanner: mocks.showActionBanner,
    setTab: mocks.setTab,
    setState: mocks.setState,
    switchAgentProfile: mocks.switchAgentProfile,
    uiLanguage: "en",
  });
  return {
    addAgentProfile: mocks.addAgentProfile,
    createPersistedActiveServer: mocks.createPersistedActiveServer,
    loadPersistedActiveServer: mocks.loadPersistedActiveServer,
    savePersistedActiveServer: mocks.savePersistedActiveServer,
    useApp: () => getAppValue(),
    useAppSelector: <T,>(
      selector: (s: ReturnType<typeof getAppValue>) => T,
    ): T => selector(getAppValue()),
    useAppSelectorShallow: <T,>(
      selector: (s: ReturnType<typeof getAppValue>) => T,
    ): T => selector(getAppValue()),
  };
});

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
    mocks.preferSharedCloudTier = false;
    mocks.createCloudCompatAgent.mockClear();
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
    mocks.silentlyRepointToDedicated.mockClear();
    mocks.switchAgentProfile.mockClear();
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
    // Phase-1 create-both: the shared-tier flag is on, so the user lands on a
    // shared agent AND a separate dedicated agent is provisioned as the handoff
    // target.
    mocks.preferSharedCloudTier = true;
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
    // Create-both: a SEPARATE dedicated agent is provisioned as the migration
    // target — a PLAIN create (no preferSharedTier, so the backend derives a
    // dedicated always-on container, not another shared agent).
    expect(mocks.createCloudCompatAgent).toHaveBeenCalledWith(
      expect.not.objectContaining({ preferSharedTier: expect.anything() }),
    );
    expect(mocks.createCloudCompatAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "Demo Agent" }),
    );
    // A freshly created SHARED agent is served by the shared adapter; the
    // background handoff is armed to poll the dedicated agent, copy the
    // conversation, and switch once the dedicated container is ready.
    expect(mocks.startCloudAgentHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sharedApiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
        conversationId: "agent-1",
        dedicatedAgentId: "dedicated-1",
        authToken: "cloud-token",
        onSwitch: expect.any(Function),
      }),
    );
  });

  it("PR3: the handoff onSwitch re-points SILENTLY (no switchAgentProfile, no draft wipe, no shell flash)", async () => {
    mocks.preferSharedCloudTier = true;
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    // Grab the onSwitch the controller armed the supervisor with, and fire it
    // the way a ready dedicated container would. The mock is untyped (no params
    // on the vi.fn), so go through `unknown` to read the handoff arg object.
    const handoffArgs = (
      mocks.startCloudAgentHandoff.mock.calls as unknown as Array<
        [{ onSwitch: (containerBase: string) => void }]
      >
    )[0]?.[0];
    expect(handoffArgs?.onSwitch).toBeTypeOf("function");

    act(() => handoffArgs?.onSwitch("https://dedicated-1.elizacloud.ai"));

    // The switch goes through the SILENT in-place re-point, carrying the
    // dedicated id + token so a reboot restores the dedicated agent.
    expect(mocks.silentlyRepointToDedicated).toHaveBeenCalledTimes(1);
    expect(mocks.silentlyRepointToDedicated).toHaveBeenCalledWith({
      containerBase: "https://dedicated-1.elizacloud.ai",
      authToken: "cloud-token",
      dedicatedAgentId: "dedicated-1",
    });
    // It must NOT take the global profile-switch path, which clears chat drafts
    // and dispatches SWITCH_AGENT → coordinator re-entry → full-screen
    // <StartupScreen/> flash + dropped WS.
    expect(mocks.switchAgentProfile).not.toHaveBeenCalled();
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

  it("routes a 0-agent auto-create failure to the picker error phase (no stuck spinner)", async () => {
    mocks.getCloudCompatAgents.mockResolvedValue({ success: true, data: [] });
    mocks.selectOrProvisionCloudAgent.mockRejectedValue(
      new Error("Out of credits."),
    );
    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    // The auto-create rejected — land on the picker error phase (Back + Try
    // again), not hang forever on the "Finding your agents…" loading spinner.
    expect(result.current.step).toBe("pick-agent");
    expect(result.current.pickerPhase).toBe("error");
    expect(result.current.pickerError).toBeTruthy();
  });

  it("does not arm shared-runtime handoff when a new cloud agent is already on a dedicated base", async () => {
    mocks.selectOrProvisionCloudAgent.mockResolvedValue({
      agentId: "agent-1",
      agentName: "Demo Agent",
      apiBase: "https://agent-1.elizacloud.ai",
      bridgeUrl: null,
      created: true,
    });

    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    expect(mocks.startCloudAgentHandoff).not.toHaveBeenCalled();
  });

  it("flag OFF: a created shared agent neither provisions a dedicated agent nor arms the handoff", async () => {
    // Phase-1 is gated on the boot-config flag. With it OFF (the default), even
    // a shared-base create stays byte-identical to pre-Phase-1: no second
    // (dedicated) create, no handoff. The demo turns the flag on.
    mocks.preferSharedCloudTier = false;
    mocks.selectOrProvisionCloudAgent.mockResolvedValue({
      agentId: "agent-1",
      agentName: "Demo Agent",
      apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
      bridgeUrl: null,
      created: true,
    });

    const { result } = renderHook(() => useFirstRunController());

    await act(async () => {
      await result.current.finishRuntime();
    });

    expect(mocks.createCloudCompatAgent).not.toHaveBeenCalled();
    expect(mocks.startCloudAgentHandoff).not.toHaveBeenCalled();
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
