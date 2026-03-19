// @vitest-environment jsdom
import React, { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    hasToken: vi.fn(() => false),
    getAuthStatus: vi.fn(async () => ({
      required: false,
      pairingEnabled: false,
      expiresAt: null,
    })),
    getOnboardingStatus: vi.fn(async () => ({ complete: true })),
    listConversations: vi.fn(async () => ({
      conversations: [
        {
          id: "conv-1",
          title: "Chat",
          roomId: "room-1",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    })),
    getConversationMessages: vi.fn(async () => ({
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          text: "hello",
          timestamp: Date.now(),
        },
      ],
    })),
    sendWsMessage: vi.fn(),
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    onWsEvent: vi.fn(() => () => {}),
    getAgentEvents: vi.fn(async () => ({ events: [], latestEventId: null })),
    getStatus: vi.fn(async () => ({
      state: "running",
      agentName: "Eliza",
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
    getBaseUrl: vi.fn(() => "http://localhost:2138"),
    cloudLogin: vi.fn(async () => ({
      ok: false,
      browserUrl: "",
      sessionId: "",
    })),
    cloudLoginPoll: vi.fn(async () => ({ status: "pending" as const })),
    getCloudCredits: vi.fn(async () => ({
      balance: 0,
      low: false,
      critical: false,
    })),
    saveStreamSettings: vi.fn(async () => ({ ok: true })),
  },
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

import type { AppState } from "@elizaos/app-core/state";
import { AppProvider, useApp } from "@elizaos/app-core/state";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type ProbeApi = {
  setState: (key: string, value: unknown) => void;
  handleOnboardingNext: () => Promise<void>;
  handleOnboardingBack: () => void;
  handleCloudLogin: () => Promise<void>;
  getCloudLoginBusy: () => boolean;
  getCloudLoginError: () => string | null;
};

function Probe(props: { onReady: (api: ProbeApi) => void }) {
  const { onReady } = props;
  const app = useApp();

  useEffect(() => {
    onReady({
      setState: (key, value) =>
        app.setState(key as keyof AppState, value as AppState[keyof AppState]),
      handleOnboardingNext: app.handleOnboardingNext,
      handleOnboardingBack: app.handleOnboardingBack,
      handleCloudLogin: app.handleCloudLogin,
      getCloudLoginBusy: () => app.elizaCloudLoginBusy,
      getCloudLoginError: () => app.elizaCloudLoginError,
    });
  }, [app, onReady]);

  return null;
}

describe("cloud login locking", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    Object.assign(window.location, { protocol: "file:", pathname: "/chat" });
    Object.assign(window, {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      open: vi.fn(() => null),
      // Simulate an available backend so the startup flow doesn't skip to
      // fresh-install onboarding immediately.
      __MILADY_API_BASE__: "http://localhost:2138",
    });
    Object.assign(document.documentElement, { setAttribute: vi.fn() });

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
    mockClient.getOnboardingStatus.mockResolvedValue({ complete: true });
    mockClient.listConversations.mockResolvedValue({
      conversations: [
        {
          id: "conv-1",
          title: "Chat",
          roomId: "room-1",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    });
    mockClient.getConversationMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          text: "hello",
          timestamp: Date.now(),
        },
      ],
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
      agentName: "Eliza",
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
    mockClient.getWorkbenchOverview.mockResolvedValue({
      tasks: [],
      triggers: [],
      todos: [],
    });
    mockClient.cloudLogin.mockResolvedValue({
      ok: false,
      browserUrl: "",
      sessionId: "",
    });
    mockClient.cloudLoginPoll.mockResolvedValue({ status: "pending" });
    mockClient.getCloudCredits.mockResolvedValue({
      balance: 0,
      low: false,
      critical: false,
    });
    mockClient.getCodingAgentStatus.mockResolvedValue(null);
  });

  it("allows only one same-tick cloud login start", async () => {
    const deferred = createDeferred<{
      ok: boolean;
      browserUrl: string;
      sessionId: string;
    }>();
    mockClient.cloudLogin.mockReturnValue(deferred.promise);

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

    await act(async () => {
      void api?.handleCloudLogin();
      void api?.handleCloudLogin();
    });

    expect(mockClient.cloudLogin).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({ ok: false, browserUrl: "", sessionId: "" });
      await deferred.promise;
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it("releases lock after failed cloud login so retry can run", async () => {
    mockClient.cloudLogin
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

    await act(async () => {
      await api?.handleCloudLogin();
    });
    await act(async () => {
      await api?.handleCloudLogin();
    });

    expect(mockClient.cloudLogin).toHaveBeenCalledTimes(2);

    await act(async () => {
      tree?.unmount();
    });
  });

  it("stops polling after repeated Eliza Cloud status errors and allows retry", async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      open: vi.fn(() => ({})),
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    mockClient.cloudLogin.mockResolvedValue({
      ok: true,
      browserUrl: "https://www.elizacloud.ai/auth/cli-login?session=session-1",
      sessionId: "session-1",
    });
    mockClient.cloudLoginPoll.mockImplementation(async () => {
      throw new Error("HTTP 502");
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

    await act(async () => {
      await api?.handleCloudLogin();
    });
    expect(api?.getCloudLoginBusy()).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    expect(mockClient.cloudLoginPoll).toHaveBeenCalledTimes(3);
    expect(api?.getCloudLoginBusy()).toBe(false);
    expect(api?.getCloudLoginError()).toContain(
      "Eliza Cloud login check failed after repeated errors.",
    );
    expect(api?.getCloudLoginError()).toContain("HTTP 502");

    await act(async () => {
      await api?.handleCloudLogin();
    });

    expect(mockClient.cloudLogin).toHaveBeenCalledTimes(2);

    consoleErrorSpy.mockRestore();
    await act(async () => {
      tree?.unmount();
    });
  });

  it("does not overlap Eliza Cloud status polls while a request is in flight", async () => {
    vi.useFakeTimers();
    Object.assign(window, {
      open: vi.fn(() => ({})),
    });

    const firstPoll = createDeferred<{ status: "pending" }>();
    mockClient.cloudLogin.mockResolvedValue({
      ok: true,
      browserUrl: "https://www.elizacloud.ai/auth/cli-login?session=session-1",
      sessionId: "session-1",
    });
    mockClient.cloudLoginPoll
      .mockReturnValueOnce(firstPoll.promise)
      .mockResolvedValue({ status: "pending" });

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

    await act(async () => {
      await api?.handleCloudLogin();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    expect(mockClient.cloudLoginPoll).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstPoll.resolve({ status: "pending" });
      await firstPoll.promise;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockClient.cloudLoginPoll).toHaveBeenCalledTimes(2);

    await act(async () => {
      tree?.unmount();
    });
  });

  // Skipped: cloudLogin onboarding step was removed in the 6-step redesign.
  // The lock/unlock mechanism is still covered by the two tests above.
});
