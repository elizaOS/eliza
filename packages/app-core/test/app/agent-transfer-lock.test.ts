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
    exportAgent: vi.fn(async () => ({
      blob: async () => new Blob(["x"]),
      headers: {
        get: () => null,
      },
    })),
    importAgent: vi.fn(async () => ({
      agentName: "Eliza",
      counts: {
        memories: 1,
        entities: 0,
        rooms: 0,
      },
    })),
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
  setState: (
    key: "exportPassword" | "importPassword" | "importFile",
    value: unknown,
  ) => void;
  handleAgentExport: () => Promise<void>;
  handleAgentImport: () => Promise<void>;
};

function Probe(props: { onReady: (api: ProbeApi) => void }) {
  const { onReady } = props;
  const app = useApp();

  useEffect(() => {
    onReady({
      setState: (key, value) =>
        app.setState(
          key,
          value as AppState["exportPassword" | "importPassword" | "importFile"],
        ),
      handleAgentExport: app.handleAgentExport,
      handleAgentImport: app.handleAgentImport,
    });
  }, [app, onReady]);

  return null;
}

describe("agent transfer locking", () => {
  beforeEach(() => {
    Object.assign(window.location, { protocol: "file:", pathname: "/chat" });
    Object.assign(window, {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
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
    mockClient.getCodingAgentStatus.mockResolvedValue(null);
    mockClient.getWorkbenchOverview.mockResolvedValue({
      tasks: [],
      triggers: [],
      todos: [],
    });
  });

  it("allows only one same-tick export call", async () => {
    const deferred = createDeferred<{
      blob: () => Promise<Blob>;
      headers: { get: (name: string) => string | null };
    }>();
    mockClient.exportAgent.mockReturnValue(deferred.promise);

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
      api?.setState("exportPassword", "abcd");
    });

    await act(async () => {
      void api?.handleAgentExport();
      void api?.handleAgentExport();
    });

    expect(mockClient.exportAgent).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree?.unmount();
    });
  });

  it("allows only one same-tick import call", async () => {
    const deferred = createDeferred<{
      agentName: string;
      counts: { memories: number; entities: number; rooms: number };
    }>();
    mockClient.importAgent.mockReturnValue(deferred.promise);

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

    const fakeFile = {
      name: "agent-export.eliza-agent",
      arrayBuffer: async () => new ArrayBuffer(8),
    } as File;

    await act(async () => {
      api?.setState("importPassword", "abcd");
      api?.setState("importFile", fakeFile);
    });

    await act(async () => {
      void api?.handleAgentImport();
      void api?.handleAgentImport();
    });

    expect(mockClient.importAgent).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree?.unmount();
    });
  });
});
