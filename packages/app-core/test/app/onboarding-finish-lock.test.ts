// @vitest-environment jsdom
import React, { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    hasToken: vi.fn(() => false),
    getAuthStatus: vi.fn(async () => ({
      required: false,
      pairingEnabled: false,
      expiresAt: null,
    })),
    getOnboardingStatus: vi.fn(async () => ({ complete: false })),
    getOnboardingOptions: vi.fn(async () => ({
      names: ["Milady"],
      styles: [],
      providers: [],
      cloudProviders: [],
      models: { small: [], large: [] },
      sharedStyleRules: "",
    })),
    listConversations: vi.fn(async () => ({ conversations: [] })),
    createConversation: vi.fn(async () => ({
      conversation: {
        id: "conv-created",
        title: "New Chat",
        roomId: "room-created",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
      greeting: {
        text: "Welcome to the conversation.",
        agentName: "Milady",
        generated: true,
      },
    })),
    getConversationMessages: vi.fn(async () => ({ messages: [] })),
    requestGreeting: vi.fn(async () => ({
      text: "Welcome to the conversation.",
      agentName: "Milady",
      generated: true,
    })),
    sendWsMessage: vi.fn(),
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    onWsEvent: vi.fn(() => () => {}),
    getAgentEvents: vi.fn(async () => ({ events: [], latestEventId: null })),
    getStatus: vi.fn(async () => ({
      state: "running",
      agentName: "Milady",
      model: undefined,
      startedAt: undefined,
      uptime: undefined,
    })),
    getWalletAddresses: vi.fn(async () => null),
    getConfig: vi.fn(async () => ({})),
    getCloudStatus: vi.fn(async () => ({ enabled: false, connected: false })),
    getCodingAgentStatus: vi.fn(async () => null),
    getWorkbenchOverview: vi.fn(async () => ({
      tasks: [],
      triggers: [],
      todos: [],
    })),
    getPermissions: vi.fn(async () => ({
      accessibility: {
        id: "accessibility",
        status: "granted",
        lastChecked: Date.now(),
        canRequest: false,
      },
      "screen-recording": {
        id: "screen-recording",
        status: "granted",
        lastChecked: Date.now(),
        canRequest: false,
      },
      microphone: {
        id: "microphone",
        status: "granted",
        lastChecked: Date.now(),
        canRequest: false,
      },
      camera: {
        id: "camera",
        status: "granted",
        lastChecked: Date.now(),
        canRequest: false,
      },
      shell: {
        id: "shell",
        status: "granted",
        lastChecked: Date.now(),
        canRequest: false,
      },
    })),
    submitOnboarding: vi.fn(async () => ({ ok: true })),
    restartAgent: vi.fn(async () => ({
      state: "running",
      agentName: "Milady",
      model: undefined,
      startedAt: undefined,
      uptime: undefined,
    })),
    saveStreamSettings: vi.fn(async () => ({ ok: true })),
  },
}));

vi.mock("@miladyai/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

import { AppProvider, useApp } from "@miladyai/app-core/state";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type ProbeApi = {
  handleOnboardingNext: (options?: {
    allowPermissionBypass?: boolean;
  }) => Promise<void>;
  hasOnboardingOptions: () => boolean;
  getOnboardingStep: () => string;
  setState: (key: string, value: unknown) => void;
  snapshot: () => {
    onboardingComplete: boolean;
    tab: string;
    uiShellMode: string;
    activeConversationId: string | null;
    conversationMessages: Array<{
      role: "user" | "assistant";
      text: string;
      source?: string;
    }>;
  };
};

function Probe(props: { onReady: (api: ProbeApi) => void }) {
  const { onReady } = props;
  const app = useApp();

  useEffect(() => {
    onReady({
      handleOnboardingNext: app.handleOnboardingNext,
      hasOnboardingOptions: () => Boolean(app.onboardingOptions),
      getOnboardingStep: () => app.onboardingStep,
      setState: app.setState,
      snapshot: () => ({
        onboardingComplete: app.onboardingComplete,
        tab: app.tab,
        uiShellMode: app.uiShellMode,
        activeConversationId: app.activeConversationId,
        conversationMessages: app.conversationMessages.map((message) => ({
          role: message.role,
          text: message.text,
          source: message.source,
        })),
      }),
    });
  }, [app, onReady]);

  return null;
}

function permissionState(
  status:
    | "granted"
    | "denied"
    | "not-determined"
    | "restricted"
    | "not-applicable",
  canRequest = false,
) {
  return { status, canRequest, lastChecked: Date.now() };
}

async function advanceToActivate(getApi: () => ProbeApi) {
  for (let i = 0; i < 20; i += 1) {
    if (getApi().getOnboardingStep() === "activate") return;
    await act(async () => {
      await getApi().handleOnboardingNext();
    });
  }
  throw new Error("Failed to reach activate onboarding step");
}

async function advanceToSenses(getApi: () => ProbeApi) {
  for (let i = 0; i < 20; i += 1) {
    if (getApi().getOnboardingStep() === "senses") return;
    await act(async () => {
      await getApi().handleOnboardingNext();
    });
  }
  throw new Error("Failed to reach senses onboarding step");
}

async function waitForOnboardingOptions(getApi: () => ProbeApi) {
  for (let i = 0; i < 20; i += 1) {
    if (getApi().hasOnboardingOptions()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error("Onboarding options did not load");
}

async function waitForOnboardingCompletion(getApi: () => ProbeApi) {
  for (let i = 0; i < 20; i += 1) {
    if (getApi().snapshot().onboardingComplete) {
      return;
    }
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error("Onboarding did not complete");
}

function configureOnboardingConnection(api: ProbeApi) {
  api.setState("onboardingRunMode", "local");
  api.setState("onboardingProvider", "openai");
  api.setState("onboardingApiKey", "sk-test-onboarding-key");
}

describe("onboarding finish locking", () => {
  beforeEach(() => {
    Object.assign(window.location, { protocol: "http:", pathname: "/chat" });
    Object.assign(window, {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      alert: vi.fn(),
    });
    Object.assign(document.documentElement, { setAttribute: vi.fn() });
    localStorage.clear();

    for (const fn of Object.values(mockClient)) {
      if (typeof fn === "function" && "mockReset" in fn) {
        (fn as { mockReset: () => void }).mockReset();
      }
    }

    mockClient.hasToken.mockReturnValue(false);
    mockClient.getAuthStatus.mockResolvedValue({
      required: false,
      pairingEnabled: false,
      expiresAt: null,
    });
    mockClient.getOnboardingStatus.mockResolvedValue({ complete: false });
    mockClient.getOnboardingOptions.mockResolvedValue({
      names: ["Milady"],
      styles: [],
      providers: [],
      cloudProviders: [],
      models: { small: [], large: [] },
      sharedStyleRules: "",
    });
    mockClient.listConversations.mockResolvedValue({ conversations: [] });
    mockClient.createConversation.mockResolvedValue({
      conversation: {
        id: "conv-created",
        title: "New Chat",
        roomId: "room-created",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
      greeting: {
        text: "Welcome to the conversation.",
        agentName: "Milady",
        generated: true,
      },
    });
    mockClient.getConversationMessages.mockResolvedValue({ messages: [] });
    mockClient.requestGreeting.mockResolvedValue({
      text: "Welcome to the conversation.",
      agentName: "Milady",
      generated: true,
    });
    mockClient.sendWsMessage.mockImplementation(() => {});
    mockClient.connectWs.mockImplementation(() => {});
    mockClient.disconnectWs.mockImplementation(() => {});
    mockClient.onWsEvent.mockReturnValue(() => {});
    mockClient.getAgentEvents.mockResolvedValue({
      events: [],
      latestEventId: null,
    });
    mockClient.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Milady",
      model: undefined,
      startedAt: undefined,
      uptime: undefined,
    });
    mockClient.getWalletAddresses.mockResolvedValue(null);
    mockClient.getConfig.mockResolvedValue({});
    mockClient.getCloudStatus.mockResolvedValue({
      enabled: false,
      connected: false,
    });
    mockClient.getCodingAgentStatus.mockResolvedValue(null);
    mockClient.getWorkbenchOverview.mockResolvedValue({
      tasks: [],
      triggers: [],
      todos: [],
    });
    mockClient.getPermissions.mockResolvedValue({
      accessibility: { id: "accessibility", ...permissionState("granted") },
      "screen-recording": {
        id: "screen-recording",
        ...permissionState("granted"),
      },
      microphone: { id: "microphone", ...permissionState("granted") },
      camera: { id: "camera", ...permissionState("granted") },
      shell: { id: "shell", ...permissionState("granted") },
    });
    mockClient.submitOnboarding.mockResolvedValue({ ok: true });
    mockClient.restartAgent.mockResolvedValue({
      state: "running",
      agentName: "Milady",
      model: undefined,
      startedAt: undefined,
      uptime: undefined,
    });
  });

  it("allows only one same-tick onboarding finish submit", async () => {
    const deferred = createDeferred<{ ok: true }>();
    mockClient.submitOnboarding.mockReturnValue(deferred.promise);

    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();
    const requireApi = () => {
      if (!api) throw new Error("onboarding probe API was not initialized");
      return api;
    };

    await waitForOnboardingOptions(requireApi);
    configureOnboardingConnection(requireApi());
    await advanceToActivate(requireApi);

    await act(async () => {
      void api?.handleOnboardingNext();
      void api?.handleOnboardingNext();
    });

    expect(mockClient.submitOnboarding).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({ ok: true });
      await deferred.promise;
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it("releases lock after failed onboarding finish so retry can run", async () => {
    mockClient.submitOnboarding
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom-2"));

    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();
    const requireApi = () => {
      if (!api) throw new Error("onboarding probe API was not initialized");
      return api;
    };

    await waitForOnboardingOptions(requireApi);
    configureOnboardingConnection(requireApi());
    await advanceToActivate(requireApi);

    await act(async () => {
      await api?.handleOnboardingNext();
    });
    await act(async () => {
      await api?.handleOnboardingNext();
    });

    expect(mockClient.submitOnboarding).toHaveBeenCalledTimes(2);

    await act(async () => {
      tree?.unmount();
    });
  });

  it("requires permissions check before finishing unless user explicitly skips", async () => {
    mockClient.getPermissions.mockResolvedValue({
      accessibility: { id: "accessibility", ...permissionState("granted") },
      "screen-recording": {
        id: "screen-recording",
        ...permissionState("denied", true),
      },
      microphone: { id: "microphone", ...permissionState("granted") },
      camera: { id: "camera", ...permissionState("granted") },
      shell: { id: "shell", ...permissionState("granted") },
    });

    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();
    const requireApi = () => {
      if (!api) throw new Error("onboarding probe API was not initialized");
      return api;
    };

    await waitForOnboardingOptions(requireApi);
    configureOnboardingConnection(requireApi());
    await advanceToSenses(requireApi);

    await act(async () => {
      await api?.handleOnboardingNext();
    });
    expect(mockClient.submitOnboarding).not.toHaveBeenCalled();

    await act(async () => {
      await api?.handleOnboardingNext({ allowPermissionBypass: true });
    });
    expect(mockClient.submitOnboarding).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree?.unmount();
    });
  });

  it("does not create an empty conversation after onboarding completes", async () => {
    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();
    const requireApi = () => {
      if (!api) throw new Error("onboarding probe API was not initialized");
      return api;
    };

    await waitForOnboardingOptions(requireApi);
    configureOnboardingConnection(requireApi());
    await advanceToActivate(requireApi);

    await act(async () => {
      await api?.handleOnboardingNext();
    });

    await waitForOnboardingCompletion(requireApi);

    const snapshot = requireApi().snapshot();
    expect(snapshot.onboardingComplete).toBe(true);
    expect(snapshot.tab).toBe("character-select");
    expect(snapshot.uiShellMode).toBe("native");
    expect(snapshot.activeConversationId).toBeNull();
    expect(snapshot.conversationMessages).toEqual([]);
    expect(mockClient.restartAgent).toHaveBeenCalledTimes(1);
    expect(mockClient.createConversation).not.toHaveBeenCalled();
    expect(mockClient.requestGreeting).not.toHaveBeenCalled();
    expect(mockClient.listConversations).toHaveBeenCalled();
    expect(mockClient.getConversationMessages).not.toHaveBeenCalled();

    await act(async () => {
      tree?.unmount();
    });
  });

  it("waits for the restarted agent before restoring an empty conversation greeting", async () => {
    let runtimeReady = false;
    mockClient.restartAgent.mockResolvedValue({
      state: "restarting",
      agentName: "Milady",
      model: undefined,
      startedAt: undefined,
      uptime: undefined,
    });
    mockClient.getStatus.mockImplementation(async () => {
      runtimeReady = true;
      return {
        state: "running",
        agentName: "Milady",
        model: undefined,
        startedAt: undefined,
        uptime: undefined,
      };
    });
    mockClient.listConversations.mockResolvedValue({
      conversations: [
        {
          id: "conv-restored",
          title: "Starter Chat",
          roomId: "room-restored",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    });
    mockClient.getConversationMessages.mockResolvedValue({ messages: [] });
    mockClient.requestGreeting.mockImplementation(async () => ({
      text: runtimeReady ? "Welcome to the conversation." : "",
      agentName: "Milady",
      generated: true,
    }));

    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();
    const requireApi = () => {
      if (!api) throw new Error("onboarding probe API was not initialized");
      return api;
    };

    await waitForOnboardingOptions(requireApi);
    configureOnboardingConnection(requireApi());
    await advanceToActivate(requireApi);

    await act(async () => {
      await api?.handleOnboardingNext();
    });

    await waitForOnboardingCompletion(requireApi);

    for (let i = 0; i < 20; i += 1) {
      if (requireApi().snapshot().conversationMessages.length > 0) {
        break;
      }
      await act(async () => {
        await Promise.resolve();
      });
    }

    const snapshot = requireApi().snapshot();
    expect(snapshot.onboardingComplete).toBe(true);
    expect(snapshot.tab).toBe("character-select");
    expect(snapshot.uiShellMode).toBe("native");
    expect(snapshot.activeConversationId).toBe("conv-restored");
    expect(snapshot.conversationMessages).toEqual([
      {
        role: "assistant",
        text: "Welcome to the conversation.",
        source: "agent_greeting",
      },
    ]);
    expect(mockClient.getStatus).toHaveBeenCalled();
    expect(mockClient.getStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mockClient.requestGreeting.mock.invocationCallOrder[0],
    );
    expect(
      mockClient.listConversations.mock.invocationCallOrder.at(-1),
    ).toBeGreaterThan(mockClient.getStatus.mock.invocationCallOrder[0]);
    expect(mockClient.createConversation).not.toHaveBeenCalled();
    expect(mockClient.sendWsMessage).toHaveBeenCalledWith({
      type: "active-conversation",
      conversationId: "conv-restored",
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it("starts completed onboarding sessions at character select from the root route", async () => {
    Object.assign(window.location, { protocol: "http:", pathname: "/" });
    mockClient.getOnboardingStatus.mockResolvedValue({ complete: true });
    mockClient.listConversations.mockResolvedValue({ conversations: [] });

    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();

    await vi.waitFor(() => {
      expect(api?.snapshot()).toEqual(
        expect.objectContaining({
          onboardingComplete: true,
          tab: "character-select",
        }),
      );
    });

    await act(async () => {
      tree?.unmount();
    });
  });
});
