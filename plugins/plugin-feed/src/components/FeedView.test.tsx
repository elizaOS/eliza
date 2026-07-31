// @vitest-environment jsdom

// Drives the FeedView GUI data wrapper through the
// rendered DOM: the same component the bundle exports for both the "gui" and
// non-embedded state. The Feed data layer (the ten `getFeed*` loaders + the
// pause/resume control + the suggested-prompt send) is mocked at the
// `@elizaos/app-core/ui-compat` `client`, and the run list is injected via the
// mocked `useAppSelector`. Asserts the populated dashboard, the autonomy toggle
// + refresh + suggested-prompt controls reach the client with the exact args,
// the loader-failure banner, and the no-session waiting state.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controlAppRun = vi.hoisted(() => vi.fn());
const sendAppRunMessage = vi.hoisted(() => vi.fn());
const feedClient = vi.hoisted(() => ({
  getFeedAgentStatus: vi.fn(),
  getFeedAgentSummary: vi.fn(),
  getFeedAgentGoals: vi.fn(),
  getFeedAgentRecentTrades: vi.fn(),
  getFeedPredictionMarkets: vi.fn(),
  getFeedTeamDashboard: vi.fn(),
  getFeedTeamConversations: vi.fn(),
  getFeedAgentChat: vi.fn(),
  getFeedAgentWallet: vi.fn(),
  getFeedAgentTradingBalance: vi.fn(),
  controlAppRun,
  sendAppRunMessage,
}));

const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
}));

function latestRunForApp(
  appName: string,
  appRuns: Array<Record<string, unknown>>,
) {
  const matchingRuns = appRuns.filter((run) => run.appName === appName);
  return { run: matchingRuns[0] ?? null, matchingRuns };
}

vi.mock("@elizaos/app-core/ui-compat", () => ({
  client: feedClient,
  selectLatestRunForApp: latestRunForApp,
}));
// FeedView imports the real `@elizaos/ui` barrel (for `EmbeddedAppViewer`),
// which loads the whole App chain — including the first-run conductor that
// reads `ACCENT_PRESETS` (and other constants/hooks) from `../state` at module
// load. Spread the real `@elizaos/ui/state` so every such export is present,
// and override only `useAppSelector` to inject this test's run list.
vi.mock("@elizaos/ui/state", async () => {
  const actual =
    await vi.importActual<typeof import("@elizaos/ui/state")>(
      "@elizaos/ui/state",
    );
  return {
    ...actual,
    useAppSelector: <T,>(selector: (value: typeof appState) => T) =>
      selector(appState),
  };
});

import { FeedView } from "./FeedView";

const APP_NAME = "@elizaos/plugin-feed";

function button(agentId: string): HTMLButtonElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLButtonElement;
}

const statusPayload = {
  id: "feed-agent-alice",
  name: "alice",
  displayName: "Alice Trader",
  balance: 1240.5,
  lifetimePnL: 312.75,
  winRate: 0.62,
  reputationScore: 88,
  totalTrades: 145,
  autonomous: true,
  autonomousTrading: true,
  autonomousPosting: false,
  agentStatus: "running",
};
const summaryEnvelope = {
  agent: statusPayload,
  portfolio: {
    totalPnL: 312.75,
    positions: 4,
    totalAssets: 1553.25,
    available: 200,
    wallet: 1240.5,
    agents: 1,
    totalPoints: 980,
  },
};
const goalsPayload = [
  {
    id: "goal-1",
    description: "Grow portfolio to $2k",
    status: "active",
    progress: 65,
    createdAt: "2026-06-01T00:00:00.000Z",
  },
];
const tradesPayload = {
  items: [
    {
      id: "act-1",
      type: "trade",
      timestamp: "2026-06-10T12:00:00.000Z",
      side: "buy",
      ticker: "BTC-100K",
      amount: 50,
      pnl: 12.5,
    },
  ],
  total: 1,
};
const marketsPayload = {
  markets: [
    {
      id: "mkt-1",
      title: "BTC above 100k",
      status: "open",
      yesPrice: 0.62,
      noPrice: 0.38,
      volume: 1,
      liquidity: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  total: 1,
};
const teamDashboardPayload = {
  agents: [{ id: "feed-agent-alice", name: "Alice", balance: 1240.5 }],
  summary: {
    ownerName: "Studio Ops",
    totals: {
      walletBalance: 5000,
      lifetimePnL: 800,
      unrealizedPnL: 50,
      currentPnL: 120,
      openPositions: 7,
    },
  },
};
const conversationsPayload = {
  conversations: [
    {
      id: "c-1",
      name: "Strategy Room",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z",
      isActive: true,
    },
  ],
  activeChatId: "c-1",
};
const chatPayload = {
  messages: [
    {
      id: "m-1",
      senderId: "u-1",
      senderName: "Operator",
      content: "Trim BTC exposure.",
      createdAt: "2026-06-10T11:00:00.000Z",
    },
  ],
};
const walletPayload = {
  balance: 1240.5,
  transactions: [
    { id: "t-1", type: "deposit", amount: 1000, timestamp: "2026-06-01" },
  ],
};
const tradingBalancePayload = { balance: 200 };

function primeClient() {
  feedClient.getFeedAgentStatus.mockResolvedValue(statusPayload);
  feedClient.getFeedAgentSummary.mockResolvedValue(summaryEnvelope);
  feedClient.getFeedAgentGoals.mockResolvedValue(goalsPayload);
  feedClient.getFeedAgentRecentTrades.mockResolvedValue(tradesPayload);
  feedClient.getFeedPredictionMarkets.mockResolvedValue(marketsPayload);
  feedClient.getFeedTeamDashboard.mockResolvedValue(teamDashboardPayload);
  feedClient.getFeedTeamConversations.mockResolvedValue(conversationsPayload);
  feedClient.getFeedAgentChat.mockResolvedValue(chatPayload);
  feedClient.getFeedAgentWallet.mockResolvedValue(walletPayload);
  feedClient.getFeedAgentTradingBalance.mockResolvedValue(
    tradingBalancePayload,
  );
  controlAppRun.mockResolvedValue({
    success: true,
    message: "Feed autonomy paused.",
    status: 200,
  });
  sendAppRunMessage.mockResolvedValue({
    success: true,
    message: "Suggestion delivered.",
    status: 202,
  });
}

function makeRun(overrides: Record<string, unknown> = {}) {
  const session = {
    sessionId: "sess-alice",
    appName: APP_NAME,
    status: "running",
    canSendCommands: true,
    controls: ["pause"],
    suggestedPrompts: ["What markets are trending?", "Show my positions"],
    ...(overrides.session as Record<string, unknown> | undefined),
  };
  const { session: _ignored, ...rest } = overrides;
  return {
    runId: "run-alice",
    appName: APP_NAME,
    status: "running",
    updatedAt: "2026-06-10T00:00:00.000Z",
    health: { state: "healthy", message: "Loop responding." },
    viewerAttachment: "attached",
    lastHeartbeatAt: "2026-06-10T00:00:00.000Z",
    session,
    ...rest,
  };
}

beforeEach(() => {
  primeClient();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  appState.appRuns = [];
});

describe("FeedView — GUI operator surface", () => {
  it("loads the dashboard on mount and renders populated operator data", async () => {
    appState.appRuns = [makeRun()];
    render(React.createElement(FeedView));

    await screen.findByText("Alice Trader");

    // All ten loaders fired once.
    expect(feedClient.getFeedAgentStatus).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentSummary).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentGoals).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentRecentTrades).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedPredictionMarkets).toHaveBeenCalledWith({
      pageSize: 3,
    });
    expect(feedClient.getFeedTeamDashboard).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedTeamConversations).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentChat).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentWallet).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentTradingBalance).toHaveBeenCalledTimes(1);

    // Populated dashboard values land in the DOM.
    expect(screen.getByText("BTC above 100k")).toBeTruthy();
    expect(screen.getByText("Studio Ops")).toBeTruthy();
    expect(screen.getByText("Trim BTC exposure.")).toBeTruthy();
  });

  it("embeds the full Feed app authenticated as the agent when the run has a viewer (GUI)", async () => {
    appState.appRuns = [
      makeRun({
        viewer: {
          url: "https://feed.example/app",
          postMessageAuth: true,
          sandbox: "allow-scripts allow-same-origin",
          authMessage: {
            type: "FEED_AUTH",
            authToken: "tok-alice",
            sessionToken: "tok-alice",
            agentId: "agent-alice",
            characterId: "agent-alice",
          },
        },
      }),
    ];
    render(React.createElement(FeedView));

    // The full Feed web app is embedded (authenticated via the viewer handshake),
    // not the operator dashboard.
    const iframe = await screen.findByTestId("embedded-app-viewer-iframe");
    expect(iframe.getAttribute("src")).toBe("https://feed.example/app");
    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin",
    );
    expect(iframe.getAttribute("title")).toBe("Feed");

    // None of the operator-dashboard loaders fire on the GUI embed path.
    expect(feedClient.getFeedAgentStatus).not.toHaveBeenCalled();
    expect(feedClient.getFeedTeamDashboard).not.toHaveBeenCalled();
    expect(screen.queryByText("BTC above 100k")).toBeNull();
  });

  it("pauses autonomy via the toggle-autonomy control and refreshes", async () => {
    appState.appRuns = [makeRun()]; // controls: ["pause"] -> action "pause"
    render(React.createElement(FeedView));
    await screen.findByText("Alice Trader");

    fireEvent.click(button("toggle-autonomy"));
    await waitFor(() =>
      expect(controlAppRun).toHaveBeenCalledWith("run-alice", "pause"),
    );
    // loadDashboard re-runs after the control resolves.
    await waitFor(() =>
      expect(feedClient.getFeedAgentStatus).toHaveBeenCalledTimes(2),
    );
  });

  it("re-runs the loaders when the refresh control is clicked", async () => {
    appState.appRuns = [makeRun()];
    render(React.createElement(FeedView));
    await screen.findByText("Alice Trader");

    expect(feedClient.getFeedAgentStatus).toHaveBeenCalledTimes(1);
    fireEvent.click(button("refresh"));
    await waitFor(() =>
      expect(feedClient.getFeedAgentStatus).toHaveBeenCalledTimes(2),
    );
  });

  it("sends a suggested prompt (trimmed) via client.sendAppRunMessage", async () => {
    appState.appRuns = [
      makeRun({
        session: {
          sessionId: "sess-alice",
          appName: APP_NAME,
          status: "running",
          canSendCommands: true,
          controls: ["pause"],
          suggestedPrompts: ["  Rebalance now  "],
        },
      }),
    ];
    render(React.createElement(FeedView));
    await screen.findByText("Alice Trader");

    fireEvent.click(button("prompt-0"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "run-alice",
        "Rebalance now",
      ),
    );
  });

  it("surfaces a loader failure in the status banner", async () => {
    feedClient.getFeedAgentStatus.mockRejectedValueOnce(
      new Error("Feed backend offline"),
    );
    appState.appRuns = [makeRun()];
    render(React.createElement(FeedView));

    await screen.findByText("Feed backend offline");
    expect(controlAppRun).not.toHaveBeenCalled();
  });
});

describe("FeedView — no-session waiting state", () => {
  it("renders the readiness empty state with an enabled Spawn agent CTA and fires no loaders", async () => {
    appState.appRuns = [];
    render(React.createElement(FeedView));

    await screen.findByText("Ready to trade?");
    const spawn = button("spawn-agent");
    expect(spawn.disabled).toBe(false);

    // With no run, no loaders fire and no controls are wired.
    expect(feedClient.getFeedAgentStatus).not.toHaveBeenCalled();
    expect(controlAppRun).not.toHaveBeenCalled();
  });
});
