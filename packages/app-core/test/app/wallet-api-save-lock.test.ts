// @vitest-environment jsdom

import type { WalletConfigUpdateRequest } from "@elizaos/autonomous/contracts/wallet";
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
    updateWalletConfig: vi.fn(async () => ({ ok: true })),
    restartAgent: vi.fn(async () => ({
      state: "running",
      agentName: "Eliza",
      model: undefined,
      startedAt: undefined,
      uptime: undefined,
    })),
    getWalletConfig: vi.fn(async () => ({
      evmAddress: "0x0000000000000000000000000000000000000001",
      solanaAddress: "So11111111111111111111111111111111111111112",
    })),
    getWalletBalances: vi.fn(async () => ({
      totalUsdValue: 0,
      chains: [],
      tokens: [],
    })),
  },
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

import { AppProvider, useApp } from "@elizaos/app-core/state";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type ProbeApi = {
  handleWalletApiKeySave: (config: WalletConfigUpdateRequest) => Promise<void>;
};

function Probe(props: { onReady: (api: ProbeApi) => void }) {
  const { onReady } = props;
  const app = useApp();

  useEffect(() => {
    onReady({ handleWalletApiKeySave: app.handleWalletApiKeySave });
  }, [app, onReady]);

  return null;
}

describe("wallet api key save locking", () => {
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
    mockClient.updateWalletConfig.mockResolvedValue({ ok: true });
    mockClient.restartAgent.mockResolvedValue({
      state: "running",
      agentName: "Eliza",
      model: undefined,
      startedAt: undefined,
      uptime: undefined,
    });
    mockClient.getWalletConfig.mockResolvedValue({
      evmAddress: "0x0000000000000000000000000000000000000001",
      solanaAddress: "So11111111111111111111111111111111111111112",
    });
    mockClient.getWalletBalances.mockResolvedValue({
      totalUsdValue: 0,
      chains: [],
      tokens: [],
    });
  });

  it("allows only one same-tick wallet API key save call", async () => {
    const deferred = createDeferred<{ ok: true }>();
    mockClient.updateWalletConfig.mockReturnValue(deferred.promise);

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

    const config: WalletConfigUpdateRequest = {
      selections: {
        evm: "eliza-cloud",
        bsc: "eliza-cloud",
        solana: "helius-birdeye",
      },
      credentials: {
        HELIUS_API_KEY: "k_123",
        BIRDEYE_API_KEY: "bird_123",
      },
    };

    await act(async () => {
      void api?.handleWalletApiKeySave(config);
      void api?.handleWalletApiKeySave(config);
    });

    expect(mockClient.updateWalletConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({ ok: true });
      await deferred.promise;
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it("releases lock after failed save so retry can run", async () => {
    mockClient.updateWalletConfig
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

    const config: WalletConfigUpdateRequest = {
      selections: {
        evm: "eliza-cloud",
        bsc: "eliza-cloud",
        solana: "helius-birdeye",
      },
      credentials: {
        HELIUS_API_KEY: "k_123",
        BIRDEYE_API_KEY: "bird_123",
      },
    };

    await act(async () => {
      await api?.handleWalletApiKeySave(config);
    });
    await act(async () => {
      await api?.handleWalletApiKeySave(config);
    });

    expect(mockClient.updateWalletConfig).toHaveBeenCalledTimes(2);

    await act(async () => {
      tree?.unmount();
    });
  });
});
