// @vitest-environment jsdom
//
// Render tests for the real FeedOperatorSurface React component (gui + xr — the
// XR view reuses this exact export, see src/index.ts views[1]). The component is
// driven against:
//   - a mocked `@elizaos/app-core/ui-compat` whose `client` exposes vi.fn()
//     versions of all 10 getFeed* loaders plus controlAppRun + sendAppRunMessage,
//   - a fake `useApp` / `selectLatestRunForApp` returning a realistic run,
//   - passthrough Surface* primitives + Button so populated card data lands in
//     the DOM and controls are clickable.
//
// Asserts populated DATA across every section (Live Status / Market Watch /
// Team / Steering + live chips), and drives every control (Hero + Steering
// Pause/Resume -> client.controlAppRun, suggested-prompt -> sendAppRunMessage),
// plus the no-run waiting state. The React-instance pinning mirrors the sibling
// plugin-2004scape operator-surface harness.

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type ReactTypes from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function findAncestor(start: string, relativePath: string) {
  let current = start;
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate ${relativePath}`);
    }
    current = parent;
  }
}

const surfacePath = findAncestor(
  process.cwd(),
  "plugins/plugin-feed/src/ui/FeedOperatorSurface.tsx",
);
const pluginRequire = createRequire(surfacePath);
const React = pluginRequire("react") as typeof ReactTypes;
const bunModulesDir = findAncestor(process.cwd(), "node_modules/.bun");
const reactDomPackageDir = readdirSync(bunModulesDir).find((entry) =>
  entry.startsWith(`react-dom@${React.version}+`),
);
if (!reactDomPackageDir) {
  throw new Error(`Unable to locate react-dom ${React.version} package`);
}
const reactDomRequire = createRequire(
  join(
    bunModulesDir,
    reactDomPackageDir,
    "node_modules",
    "react-dom",
    "package.json",
  ),
);
const { flushSync } = reactDomRequire(
  "react-dom",
) as typeof import("react-dom");
const { createRoot } = reactDomRequire(
  "react-dom/client",
) as typeof import("react-dom/client");
const { act } = React;

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

// Surface primitives render label/value/subtitle so populated data is assertable.
const uiMock = vi.hoisted(() => {
  const card = ({
    label,
    value,
    subtitle,
  }: {
    label?: string;
    value?: string;
    subtitle?: string;
  }) =>
    React.createElement(
      "div",
      { "data-surface-card": label },
      React.createElement("span", { "data-card-label": true }, label),
      React.createElement("span", { "data-card-value": true }, value),
      subtitle
        ? React.createElement("span", { "data-card-subtitle": true }, subtitle)
        : null,
    );
  const passthrough =
    (name: string) =>
    ({ children }: { children?: ReactTypes.ReactNode }) =>
      React.createElement("div", { "data-region": name }, children);
  return {
    client: feedClient,
    useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
    SurfaceCard: card,
    SurfaceBadge: ({ children }: { children?: ReactTypes.ReactNode }) =>
      React.createElement("span", { "data-surface-badge": true }, children),
    SurfaceSection: ({
      title,
      children,
    }: {
      title?: string;
      children?: ReactTypes.ReactNode;
    }) => React.createElement("section", { "data-section": title }, children),
    SurfaceEmptyState: passthrough("empty-state"),
    SurfaceGrid: passthrough("grid"),
    formatDetailTimestamp: (value: unknown) =>
      value == null ? "" : `ts:${String(value)}`,
    selectLatestRunForApp: latestRunForApp,
    toneForHealthState: () => "neutral",
    toneForStatusText: () => "neutral",
    toneForViewerAttachment: () => "neutral",
    registerOperatorSurface: () => {},
    registerDetailExtension: () => {},
    useApp: () => appState,
  };
});

vi.mock("@elizaos/app-core/ui-compat", () => uiMock);
vi.mock("@elizaos/ui/agent-surface", () => uiMock);
vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactTypes.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    ref?: unknown;
  }) =>
    React.createElement(
      "button",
      { onClick, disabled, type: "button" },
      children,
    ),
  TerminalPluginView: ({ commands }: { commands?: string[] }) =>
    React.createElement(
      "div",
      { "data-terminal-view": true },
      (commands ?? []).join(","),
    ),
}));

const { FeedOperatorSurface } = await import("./FeedOperatorSurface");

const APP_NAME = "@elizaos/plugin-feed";

const mountedRoots: Array<{
  container: HTMLElement;
  root: ReturnType<typeof createRoot>;
}> = [];

async function renderSurface(component: ReactTypes.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ container, root });
  // loadDashboard() runs in an effect after mount and resolves async; flush both
  // the initial render and the resolved-promise state updates.
  await act(async () => {
    root.render(component);
  });
  return container;
}

function cleanupSurfaces() {
  for (const { container, root } of mountedRoots.splice(0)) {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
  }
}

function cardValue(container: HTMLElement, label: string): string {
  const card = container.querySelector(`[data-surface-card="${label}"]`);
  if (!card) throw new Error(`No SurfaceCard with label "${label}"`);
  return card.querySelector("[data-card-value]")?.textContent?.trim() ?? "";
}

function cardSubtitle(container: HTMLElement, label: string): string {
  const card = container.querySelector(`[data-surface-card="${label}"]`);
  if (!card) throw new Error(`No SurfaceCard with label "${label}"`);
  return card.querySelector("[data-card-subtitle]")?.textContent?.trim() ?? "";
}

function clickByText(container: HTMLElement, text: string) {
  const el = Array.from(container.querySelectorAll<HTMLElement>("button")).find(
    (node) => node.textContent?.trim() === text,
  );
  if (!el) throw new Error(`No clickable element with text "${text}"`);
  return el;
}

// --- Realistic loader payloads (shapes verified vs canonical @elizaos/ui Feed
// types + the extract* envelopes the component consumes). ---
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
  positions: { predictions: { positions: [] }, perpetuals: { positions: [] } },
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
      action: "buy",
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
    {
      id: "mkt-2",
      title: "ETH above 5k",
      status: "open",
      yesPrice: 0.41,
      noPrice: 0.59,
      volume: 1,
      liquidity: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  total: 2,
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
    {
      id: "c-2",
      name: "Risk Desk",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      isActive: false,
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
    { id: "t-2", type: "trade", amount: -50, timestamp: "2026-06-10" },
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
    disposition: "applied",
    status: 200,
  });
  sendAppRunMessage.mockResolvedValue({
    success: true,
    message: "Suggestion delivered.",
    disposition: "queued",
    status: 202,
  });
}

function makeRun(overrides: Record<string, unknown> = {}) {
  const session = {
    sessionId: "sess-alice",
    appName: APP_NAME,
    mode: "spectate-and-steer",
    status: "running",
    canSendCommands: true,
    controls: ["pause"],
    suggestedPrompts: ["What markets are trending?", "Show my positions"],
    telemetry: null,
    activity: [],
    ...(overrides.session as Record<string, unknown> | undefined),
  };
  const { session: _ignored, ...rest } = overrides;
  return {
    runId: "run-alice",
    appName: APP_NAME,
    status: "running",
    updatedAt: "2026-06-10T00:00:00.000Z",
    summary: "Live trading loop.",
    supportsBackground: true,
    health: { state: "healthy", message: "Loop responding." },
    viewerAttachment: "attached",
    lastHeartbeatAt: "2026-06-10T00:00:00.000Z",
    recentEvents: [],
    session,
    ...rest,
  };
}

beforeEach(() => {
  primeClient();
});

afterEach(() => {
  cleanupSurfaces();
  vi.clearAllMocks();
  appState.appRuns = [];
});

describe("FeedOperatorSurface (gui/xr) — populated data", () => {
  it("renders every section with specific values after loadDashboard resolves", async () => {
    appState.appRuns = [makeRun()];
    const container = await renderSurface(
      React.createElement(FeedOperatorSurface, {
        appName: APP_NAME,
        variant: "live",
      }),
    );

    // All 10 loaders were invoked.
    expect(feedClient.getFeedAgentStatus).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentSummary).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentGoals).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentRecentTrades).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedPredictionMarkets).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedTeamDashboard).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedTeamConversations).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentChat).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentWallet).toHaveBeenCalledTimes(1);
    expect(feedClient.getFeedAgentTradingBalance).toHaveBeenCalledTimes(1);

    expect(
      container.querySelector('[data-testid="feed-live-operator-surface"]'),
    ).not.toBeNull();

    const text = container.textContent ?? "";

    // Hero title (live variant) + status label "<status> · <health.state>".
    expect(text).toContain("Feed Live Dashboard");
    expect(text).toContain("running · healthy");

    // Live StatChip strip.
    expect(text).toContain("Autonomous"); // Agent chip
    expect(text).toContain("$1553.25"); // Portfolio chip (totalAssets)
    expect(text).toContain("2 live"); // Markets chip (predictionMarkets.length)

    // Status badges row + active-run count.
    expect(text).toContain("attached");
    expect(text).toContain("1 active run");

    // --- Live Status section ---
    expect(cardValue(container, "Agent")).toBe("Alice Trader");
    expect(cardSubtitle(container, "Agent")).toBe("running · autonomous");
    expect(cardValue(container, "Current Focus")).toBe("Grow portfolio to $2k");
    expect(cardSubtitle(container, "Current Focus")).toBe("active · 65%");
    expect(cardValue(container, "Portfolio")).toBe("$1553.25 total assets");
    expect(cardSubtitle(container, "Portfolio")).toBe(
      "4 positions · +$312.75 total PnL",
    );
    expect(cardValue(container, "Team Coordination")).toBe("Studio Ops");
    expect(cardSubtitle(container, "Team Coordination")).toBe(
      "$5000.00 wallet · 7 open positions",
    );

    // --- Market Watch section ---
    // listPreview: first markets formatted "title (yes/no)".
    expect(cardValue(container, "Markets")).toBe(
      "BTC above 100k (0.62/0.38) · ETH above 5k (0.41/0.59)",
    );
    // Recent-trade card: summarizeFeedActivity + ts + PnL.
    expect(text).toContain("buy BTC-100K $50.00");
    expect(text).toContain("PnL +$12.50");

    // --- Team section ---
    expect(cardValue(container, "Team Conversations")).toBe(
      "Strategy Room · Risk Desk",
    );
    expect(cardSubtitle(container, "Team Conversations")).toBe("1 active");
    expect(cardValue(container, "Operator Channel")).toBe("Ready");
    // Last chat message body renders.
    expect(text).toContain("Trim BTC exposure.");
    expect(text).toContain("Operator");

    // --- Steering section ---
    expect(cardValue(container, "Autonomy")).toBe("Active");
    expect(cardSubtitle(container, "Autonomy")).toBe(
      "Trading · Posting paused",
    );
    expect(cardValue(container, "Wallet")).toBe("$1240.50");
    expect(cardSubtitle(container, "Wallet")).toBe(
      "2 transactions · trading $200.00",
    );

    // Suggested-prompt buttons render their labels.
    expect(clickByText(container, "What markets are trending?")).toBeTruthy();
    expect(clickByText(container, "Show my positions")).toBeTruthy();
  });

  it("fires client.controlAppRun('pause') from the Steering Pause button and refreshes", async () => {
    appState.appRuns = [makeRun()]; // controls: ["pause"] -> action "pause"
    const container = await renderSurface(
      React.createElement(FeedOperatorSurface, { appName: APP_NAME }),
    );

    expect(feedClient.getFeedAgentStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      clickByText(container, "Pause").click();
    });

    expect(controlAppRun).toHaveBeenCalledWith("run-alice", "pause");
    // loadDashboard re-runs after the control resolves (second status fetch).
    expect(feedClient.getFeedAgentStatus).toHaveBeenCalledTimes(2);
    // statusMessage banner reflects the response message.
    expect(container.textContent).toContain("Feed autonomy paused.");
  });

  it("derives the 'resume' control action and fires it via the Hero CTA", async () => {
    controlAppRun.mockResolvedValue({
      success: true,
      message: "Feed autonomy resumed.",
      disposition: "applied",
      status: 200,
    });
    appState.appRuns = [
      makeRun({
        session: {
          sessionId: "sess-alice",
          appName: APP_NAME,
          status: "paused",
          canSendCommands: true,
          controls: ["resume"],
          suggestedPrompts: [],
          telemetry: null,
          activity: [],
        },
      }),
    ];
    const container = await renderSurface(
      React.createElement(FeedOperatorSurface, {
        appName: APP_NAME,
        variant: "live",
      }),
    );

    // Hero CTA label flips to "Resume agent" when action is resume.
    await act(async () => {
      clickByText(container, "Resume agent").click();
    });

    expect(controlAppRun).toHaveBeenCalledWith("run-alice", "resume");
    expect(container.textContent).toContain("Feed autonomy resumed.");
  });

  it("sends a suggested prompt via client.sendAppRunMessage (trimmed)", async () => {
    appState.appRuns = [
      makeRun({
        session: {
          sessionId: "sess-alice",
          appName: APP_NAME,
          status: "running",
          canSendCommands: true,
          controls: ["pause"],
          suggestedPrompts: ["  Rebalance now  "],
          telemetry: null,
          activity: [],
        },
      }),
    ];
    const container = await renderSurface(
      React.createElement(FeedOperatorSurface, { appName: APP_NAME }),
    );

    expect(feedClient.getFeedAgentStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      clickByText(container, "Rebalance now").click();
    });

    // Sent with the trimmed prompt, then the dashboard reloads (handler awaits
    // loadDashboard after sending, so the banner ends on the reload message).
    expect(sendAppRunMessage).toHaveBeenCalledWith(
      "run-alice",
      "Rebalance now",
    );
    expect(feedClient.getFeedAgentStatus).toHaveBeenCalledTimes(2);
  });

  it("surfaces a loader failure in the status banner", async () => {
    feedClient.getFeedAgentStatus.mockRejectedValueOnce(
      new Error("Feed backend offline"),
    );
    appState.appRuns = [makeRun()];
    const container = await renderSurface(
      React.createElement(FeedOperatorSurface, {
        appName: APP_NAME,
        variant: "live",
      }),
    );

    expect(container.textContent).toContain("Feed backend offline");
  });
});

describe("FeedOperatorSurface (gui/xr) — no-run waiting state", () => {
  it("renders the waiting surface with idle chips and a disabled Spawn agent CTA", async () => {
    appState.appRuns = [];
    const container = await renderSurface(
      React.createElement(FeedOperatorSurface, { appName: APP_NAME }),
    );

    expect(
      container.querySelector('[data-testid="feed-operator-ready"]'),
    ).not.toBeNull();

    const text = container.textContent ?? "";
    // 4 idle/pending StatChip labels.
    expect(text).toContain("Agent");
    expect(text).toContain("Portfolio");
    expect(text).toContain("Markets");
    expect(text).toContain("Wallet");
    // WaitingForSession copy.
    expect(text).toContain("Waiting for a Feed session");

    // Spawn agent CTA present and disabled.
    const spawn = clickByText(container, "Spawn agent") as HTMLButtonElement;
    expect(spawn.disabled).toBe(true);

    // With no run, no loaders fire and no controls are wired.
    expect(feedClient.getFeedAgentStatus).not.toHaveBeenCalled();
    expect(controlAppRun).not.toHaveBeenCalled();
  });
});
