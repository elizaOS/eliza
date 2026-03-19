/** @vitest-environment jsdom */

import type { StreamEventEnvelope } from "@elizaos/app-core/api";
import React, { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, mockClient, wsHandlers, invokeDesktopBridgeRequestMock } =
  vi.hoisted(() => {
  const handlers = new Map<string, (data: Record<string, unknown>) => void>();

  return {
    fetchMock: vi.fn(),
    wsHandlers: handlers,
    invokeDesktopBridgeRequestMock: vi.fn(async () => ({ id: "notif-1" })),
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
      createConversation: vi.fn(async () => ({
        conversation: {
          id: "conv-created",
          title: "Chat",
          roomId: "room-created",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      })),
      getConversationMessages: vi.fn(async () => ({ messages: [] })),
      sendConversationMessage: vi.fn(async () => ({
        text: "ok",
        agentName: "Eliza",
      })),
      sendConversationMessageStream: vi.fn(async () => ({
        text: "ok",
        agentName: "Eliza",
      })),
      requestGreeting: vi.fn(async () => ({
        text: "hi",
        agentName: "Eliza",
        generated: true,
      })),
      listCustomActions: vi.fn(async () => []),
      testCustomAction: vi.fn(async () => ({
        ok: true,
        output: "ok",
        durationMs: 5,
      })),
      rememberMemory: vi.fn(async () => ({
        ok: true,
        id: "mem-1",
        text: "saved",
        createdAt: Date.now(),
      })),
      searchMemory: vi.fn(async () => ({
        query: "q",
        results: [],
        count: 0,
        limit: 6,
      })),
      searchKnowledge: vi.fn(async () => ({
        query: "q",
        threshold: 0.2,
        results: [],
        count: 0,
      })),
      quickContext: vi.fn(async () => ({
        query: "q",
        answer: "quick answer",
        memories: [],
        knowledge: [],
      })),
      sendWsMessage: vi.fn(),
      connectWs: vi.fn(),
      disconnectWs: vi.fn(),
      saveStreamSettings: vi.fn(async () => undefined),
      onWsEvent: vi.fn(
        (type: string, handler: (data: Record<string, unknown>) => void) => {
          handlers.set(type, handler);
          return () => {
            handlers.delete(type);
          };
        },
      ),
      getAgentEvents: vi.fn(async () => ({
        events: [],
        latestEventId: null,
        totalBuffered: 0,
        replayed: true,
      })),
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
      hasCustomVrm: vi.fn(async () => false),
      hasCustomBackground: vi.fn(async () => false),
    },
  };
});

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

vi.mock("../../src/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/bridge")>();
  return {
    ...actual,
    getBackendStartupTimeoutMs: () => 1000,
    invokeDesktopBridgeRequest: invokeDesktopBridgeRequestMock,
    scanProviderCredentials: vi.fn(async () => []),
  };
});

import { AppProvider, useApp } from "@elizaos/app-core/state";

type ProbeApi = {
  snapshot: () => {
    autonomousEvents: StreamEventEnvelope[];
    autonomousRunHealthByRunId: Record<
      string,
      { status: string; missingSeqs: number[] }
    >;
    startupPhase: ReturnType<typeof useApp>["startupPhase"];
    startupError: ReturnType<typeof useApp>["startupError"];
  };
};

function Probe(props: { onReady: (api: ProbeApi) => void }) {
  const app = useApp();

  useEffect(() => {
    props.onReady({
      snapshot: () => ({
        autonomousEvents: app.autonomousEvents,
        autonomousRunHealthByRunId: Object.fromEntries(
          Object.entries(app.autonomousRunHealthByRunId).map(
            ([runId, health]) => [
              runId,
              {
                status: health.status,
                missingSeqs: [...health.missingSeqs],
              },
            ],
          ),
        ),
        startupPhase: app.startupPhase,
        startupError: app.startupError,
      }),
    });
  }, [app, props]);

  return null;
}

function makeWsEvent(eventId: string, runId: string, seq: number) {
  return {
    type: "agent_event",
    eventId,
    ts: Date.now(),
    runId,
    seq,
    stream: "action",
    payload: { text: `${runId}:${seq}` },
  };
}

function emitWs(type: string, payload: Record<string, unknown>): void {
  const handler = wsHandlers.get(type);
  if (handler) {
    handler(payload);
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  for (let idx = 0; idx < 30; idx += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      if (idx === 29) throw err;
      await flush();
    }
  }
}

describe("AppContext autonomy replay", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    window.history.replaceState({}, "", "/chat");
    Object.assign(window, {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    Object.assign(document.documentElement, { setAttribute: vi.fn() });
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });
    invokeDesktopBridgeRequestMock.mockReset();
    invokeDesktopBridgeRequestMock.mockResolvedValue({ id: "notif-1" });

    wsHandlers.clear();

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
    mockClient.createConversation.mockResolvedValue({
      conversation: {
        id: "conv-created",
        title: "Chat",
        roomId: "room-created",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    });
    mockClient.getConversationMessages.mockResolvedValue({ messages: [] });
    mockClient.sendConversationMessage.mockResolvedValue({
      text: "ok",
      agentName: "Eliza",
    });
    mockClient.sendConversationMessageStream.mockResolvedValue({
      text: "ok",
      agentName: "Eliza",
    });
    mockClient.requestGreeting.mockResolvedValue({
      text: "hi",
      agentName: "Eliza",
      generated: true,
    });
    mockClient.listCustomActions.mockResolvedValue([]);
    mockClient.testCustomAction.mockResolvedValue({
      ok: true,
      output: "ok",
      durationMs: 5,
    });
    mockClient.rememberMemory.mockResolvedValue({
      ok: true,
      id: "mem-1",
      text: "saved",
      createdAt: Date.now(),
    });
    mockClient.searchMemory.mockResolvedValue({
      query: "q",
      results: [],
      count: 0,
      limit: 6,
    });
    mockClient.searchKnowledge.mockResolvedValue({
      query: "q",
      threshold: 0.2,
      results: [],
      count: 0,
    });
    mockClient.quickContext.mockResolvedValue({
      query: "q",
      answer: "quick answer",
      memories: [],
      knowledge: [],
    });
    mockClient.sendWsMessage.mockImplementation(() => {});
    mockClient.connectWs.mockImplementation(() => {});
    mockClient.disconnectWs.mockImplementation(() => {});
    mockClient.saveStreamSettings.mockResolvedValue(undefined);
    mockClient.onWsEvent.mockImplementation(
      (type: string, handler: (data: Record<string, unknown>) => void) => {
        wsHandlers.set(type, handler);
        return () => {
          wsHandlers.delete(type);
        };
      },
    );
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
    mockClient.hasCustomVrm.mockResolvedValue(false);
    mockClient.hasCustomBackground.mockResolvedValue(false);
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "fetch", {
      value: originalFetch,
      writable: true,
      configurable: true,
    });
  });

  it("recovers dropped run events via per-run replay", async () => {
    mockClient.getAgentEvents.mockImplementation(
      async (opts?: { runId?: string; fromSeq?: number }) => {
        if (opts?.runId === "run-1" && opts.fromSeq === 2) {
          return {
            events: [makeWsEvent("evt-2", "run-1", 2)],
            latestEventId: "evt-2",
            totalBuffered: 3,
            replayed: true,
          };
        }
        return {
          events: [],
          latestEventId: null,
          totalBuffered: 0,
          replayed: true,
        };
      },
    );

    let probe: ProbeApi | null = null;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (api) => {
              probe = api;
            },
          }),
        ),
      );
    });

    await flush();
    await flush();
    await waitFor(() => {
      const snapshot = probe?.snapshot();
      expect(snapshot?.startupPhase).toBe("ready");
      expect(snapshot?.startupError).toBeNull();
      expect(wsHandlers.has("agent_event")).toBe(true);
    });

    await act(async () => {
      emitWs("agent_event", makeWsEvent("evt-1", "run-1", 1));
      emitWs("agent_event", makeWsEvent("evt-3", "run-1", 3));
    });

    await waitFor(() => {
      expect(mockClient.getAgentEvents).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1", fromSeq: 2 }),
      );
      const snapshot = probe?.snapshot();
      expect(snapshot?.autonomousRunHealthByRunId["run-1"]?.status).toBe(
        "recovered",
      );
      expect(
        snapshot?.autonomousRunHealthByRunId["run-1"]?.missingSeqs,
      ).toEqual([]);
      expect(snapshot?.autonomousEvents.map((event) => event.eventId)).toEqual(
        expect.arrayContaining(["evt-1", "evt-2", "evt-3"]),
      );
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("marks unresolved replay gaps as partial", async () => {
    mockClient.getAgentEvents.mockResolvedValue({
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    });

    let probe: ProbeApi | null = null;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (api) => {
              probe = api;
            },
          }),
        ),
      );
    });

    await flush();
    await flush();
    await waitFor(() => {
      const snapshot = probe?.snapshot();
      expect(snapshot?.startupPhase).toBe("ready");
      expect(snapshot?.startupError).toBeNull();
      expect(wsHandlers.has("agent_event")).toBe(true);
    });

    await act(async () => {
      emitWs("agent_event", makeWsEvent("evt-1", "run-2", 1));
      emitWs("agent_event", makeWsEvent("evt-3", "run-2", 3));
    });

    await waitFor(() => {
      const snapshot = probe?.snapshot();
      expect(snapshot?.autonomousRunHealthByRunId["run-2"]?.status).toBe(
        "partial",
      );
      expect(
        snapshot?.autonomousRunHealthByRunId["run-2"]?.missingSeqs,
      ).toEqual([2]);
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("pushes native notifications for heartbeat failures and restart-required events", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: () => undefined,
          }),
        ),
      );
    });

    await flush();
    await flush();
    await waitFor(() => {
      expect(wsHandlers.has("heartbeat_event")).toBe(true);
      expect(wsHandlers.has("restart-required")).toBe(true);
    });

    await act(async () => {
      emitWs("heartbeat_event", {
        type: "heartbeat_event",
        eventId: "hb-1",
        ts: Date.now(),
        runId: "run-hb",
        seq: 1,
        stream: "action",
        payload: {
          status: "failed",
          channel: "discord",
          preview: "connector down",
          durationMs: 12,
        },
      });
      emitWs("restart-required", {
        reasons: ["Plugin toggled"],
      });
    });

    await waitFor(() => {
      expect(invokeDesktopBridgeRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          rpcMethod: "desktopShowNotification",
          ipcChannel: "desktop:showNotification",
          params: expect.objectContaining({
            title: "Heartbeat failed",
          }),
        }),
      );
      expect(invokeDesktopBridgeRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          rpcMethod: "desktopShowNotification",
          ipcChannel: "desktop:showNotification",
          params: expect.objectContaining({
            title: "Restart required",
          }),
        }),
      );
    });

    await act(async () => {
      renderer.unmount();
    });
  });
});
