// @vitest-environment jsdom
//
// Render tests for the real FeedDetailExtension panel (registered via
// registerDetailExtension("feed-operator-dashboard", ...)). Drives the real
// component against a fake useApp/selectLatestRunForApp and passthrough Surface
// primitives, asserting the header, the four telemetry-derived Metric rows, the
// ActivityList rows (from recentEvents + session.activity), the no-run empty
// state, and the empty-activity fallback. Harness mirrors the sibling
// plugin-2004scape detail-extension test.

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type ReactTypes from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  "plugins/plugin-feed/src/ui/FeedDetailExtension.tsx",
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

const uiMock = vi.hoisted(() => ({
  formatDetailTimestamp: (value: unknown) =>
    value == null ? "" : `ts:${String(value)}`,
  selectLatestRunForApp: latestRunForApp,
  toneForHealthState: () => "neutral",
  toneForStatusText: () => "neutral",
  toneForViewerAttachment: () => "neutral",
  SurfaceBadge: ({ children }: { children?: ReactTypes.ReactNode }) =>
    React.createElement("span", { "data-surface-badge": true }, children),
  SurfaceEmptyState: ({ title, body }: { title?: string; body?: string }) =>
    React.createElement(
      "div",
      { "data-empty-state": true },
      React.createElement("span", { "data-empty-title": true }, title),
      React.createElement("span", { "data-empty-body": true }, body),
    ),
  registerOperatorSurface: () => {},
  registerDetailExtension: () => {},
  useApp: () => appState,
}));

vi.mock("@elizaos/app-core/ui-compat", () => uiMock);

const { FeedDetailExtension } = await import("./FeedDetailExtension");

const mountedRoots: Array<{
  container: HTMLElement;
  root: ReturnType<typeof createRoot>;
}> = [];

function renderSurface(component: ReactTypes.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ container, root });
  flushSync(() => {
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

const APP_NAME = "@elizaos/plugin-feed";
const appProp = { name: APP_NAME };

// Metric renders label/value in sibling divs inside a grid cell — find the label
// div then read its following-sibling value div.
function metricValue(container: HTMLElement, label: string): string {
  const labelEl = Array.from(
    container.querySelectorAll<HTMLElement>("div"),
  ).find((node) => node.textContent?.trim() === label);
  if (!labelEl) throw new Error(`No metric label "${label}"`);
  const value = labelEl.nextElementSibling;
  return value?.textContent?.trim() ?? "";
}

function detailRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-alice",
    appName: APP_NAME,
    status: "running",
    summary: "Market agent loop.",
    updatedAt: "2026-06-10T00:00:00.000Z",
    health: { state: "online", message: "Loop healthy." },
    viewerAttachment: "attached",
    lastHeartbeatAt: "2026-06-10T00:00:01.000Z",
    recentEvents: [
      {
        eventId: "evt-1",
        kind: "trade",
        severity: "info",
        message: "Bought BTC-100K shares.",
        createdAt: "2026-06-10T11:55:00.000Z",
      },
    ],
    session: {
      sessionId: "sess-alice",
      appName: APP_NAME,
      status: "running",
      canSendCommands: true,
      goalLabel: "Grow portfolio to $2k",
      telemetry: {
        autonomous: false,
        walletBalance: 1240.5,
        totalPnL: 312.75,
      },
      activity: [
        {
          id: "sa-1",
          type: "post",
          message: "Published a market update.",
          timestamp: 1_716_000_000_000,
        },
      ],
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanupSurfaces();
  vi.clearAllMocks();
  appState.appRuns = [];
});

describe("FeedDetailExtension", () => {
  it("renders the no-run empty state", () => {
    appState.appRuns = [];
    const container = renderSurface(
      React.createElement(FeedDetailExtension, { app: appProp }),
    );

    const empty = container.querySelector("[data-empty-state]");
    expect(empty).not.toBeNull();
    expect(empty?.querySelector("[data-empty-title]")?.textContent).toBe(
      "Feed",
    );
    expect(empty?.querySelector("[data-empty-body]")?.textContent).toBe(
      "Launch Feed to attach the market dashboard.",
    );
  });

  it("renders the header and all 4 telemetry-derived metric rows", () => {
    appState.appRuns = [detailRun()];
    const container = renderSurface(
      React.createElement(FeedDetailExtension, { app: appProp }),
    );

    expect(
      container.querySelector('[data-testid="feed-detail-dashboard"]'),
    ).not.toBeNull();

    const text = container.textContent ?? "";
    // Header: goalLabel + run count + status badge.
    expect(text).toContain("Grow portfolio to $2k");
    expect(text).toContain("1 run");
    expect(container.querySelector("[data-surface-badge]")?.textContent).toBe(
      "running",
    );

    // Metric rows derived from run + session.telemetry.
    expect(metricValue(container, "Viewer")).toBe("attached");
    expect(metricValue(container, "Autonomy")).toBe("Paused"); // autonomous:false
    expect(metricValue(container, "Wallet")).toBe("$1240.50");
    expect(metricValue(container, "Health")).toBe("online");

    // Wallet PnL detail: formatCurrency(pnl, signed).
    expect(text).toContain("PnL +$312.75");
    // Relay-ready detail (canSendCommands true).
    expect(text).toContain("Relay ready");
  });

  it("renders ActivityList rows from recentEvents + session.activity", () => {
    appState.appRuns = [detailRun()];
    const container = renderSurface(
      React.createElement(FeedDetailExtension, { app: appProp }),
    );

    const text = container.textContent ?? "";
    // recentEvents row (kind + message).
    expect(text).toContain("trade");
    expect(text).toContain("Bought BTC-100K shares.");
    // session.activity row (type + message).
    expect(text).toContain("post");
    expect(text).toContain("Published a market update.");
    expect(text).not.toContain("No market activity yet.");
  });

  it("renders the empty-activity fallback and a degraded session", () => {
    appState.appRuns = [
      detailRun({
        recentEvents: [],
        session: {
          sessionId: "sess-alice",
          appName: APP_NAME,
          status: "connecting",
          canSendCommands: false,
          goalLabel: null,
          telemetry: { autonomous: true },
          activity: [],
        },
      }),
    ];
    const container = renderSurface(
      React.createElement(FeedDetailExtension, { app: appProp }),
    );

    const text = container.textContent ?? "";
    expect(text).toContain("No market activity yet.");
    // No walletBalance telemetry -> "Waiting".
    expect(metricValue(container, "Wallet")).toBe("Waiting");
    // autonomous:true -> Active; canSendCommands:false -> Relay pending.
    expect(metricValue(container, "Autonomy")).toBe("Active");
    expect(text).toContain("Relay pending");
    // Falls back to run.summary when goalLabel is null.
    expect(text).toContain("Market agent loop.");
  });
});
