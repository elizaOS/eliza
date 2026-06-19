// @vitest-environment jsdom

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
  "plugins/plugin-2004scape/src/ui/TwoThousandFourScapeDetailExtension.tsx",
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
  setActionNotice: vi.fn(),
  setState: vi.fn(),
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

const { TwoThousandFourScapeDetailExtension } = await import(
  "../ui/TwoThousandFourScapeDetailExtension"
);

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

const appProp = { name: "@elizaos/plugin-2004scape" };

// Detail-extension telemetry: formatPlayer reads x/y/health/maxHealth (distinct
// from the operator-surface player.worldX/worldZ/hp shape).
function detailRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-oakbot42",
    appName: "@elizaos/plugin-2004scape",
    status: "running",
    updatedAt: "2026-05-19T00:00:00.000Z",
    health: { state: "online", message: "ok" },
    viewerAttachment: "attached",
    lastHeartbeatAt: "2026-05-19T00:00:01.000Z",
    recentEvents: [],
    viewer: {
      postMessageAuth: true,
      authMessage: { authToken: "oakbot42", sessionToken: "secretpw" },
    },
    session: {
      sessionId: "sess-oakbot42",
      canSendCommands: true,
      status: "running",
      goalLabel: "Finish tutorial and reach the mainland.",
      characterId: "oakbot42",
      activity: [],
      telemetry: {
        botName: "oakbot42",
        autoPlay: true,
        intent: "tutorial",
        player: {
          name: "oakbot42",
          x: 3222,
          y: 3218,
          health: 9,
          maxHealth: 10,
        },
        tutorial: { active: true, prompt: "Talk to the RuneScape Guide." },
        recentActivity: [
          {
            action: "woodcut",
            detail: "Started chopping Tree.",
            ts: 1_716_000_000_500,
          },
        ],
      },
    },
    ...overrides,
  };
}

function metricValue(container: HTMLElement, label: string): string {
  const labelEl = Array.from(
    container.querySelectorAll<HTMLElement>("div"),
  ).find((node) => node.textContent?.trim() === label);
  if (!labelEl) throw new Error(`No metric label "${label}"`);
  const value = labelEl.nextElementSibling;
  return value?.textContent?.trim() ?? "";
}

afterEach(() => {
  cleanupSurfaces();
  vi.clearAllMocks();
  appState.appRuns = [];
});

describe("TwoThousandFourScapeDetailExtension", () => {
  it("renders the empty state with no run", () => {
    appState.appRuns = [];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeDetailExtension, {
        app: appProp,
      }),
    );

    const empty = container.querySelector("[data-empty-state]");
    expect(empty).not.toBeNull();
    expect(empty?.querySelector("[data-empty-title]")?.textContent).toBe(
      "2004scape",
    );
    expect(empty?.querySelector("[data-empty-body]")?.textContent).toBe(
      "Launch the game to attach the viewer and bot loop.",
    );
  });

  it("renders the header and all 6 metric rows from telemetry", () => {
    appState.appRuns = [detailRun()];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeDetailExtension, {
        app: appProp,
      }),
    );

    expect(
      container.querySelector('[data-testid="2004scape-detail-dashboard"]'),
    ).not.toBeNull();

    const text = container.textContent ?? "";
    // Header: goalLabel + run count + status badge.
    expect(text).toContain("Finish tutorial and reach the mainland.");
    expect(text).toContain("1 run");
    expect(container.querySelector("[data-surface-badge]")?.textContent).toBe(
      "running",
    );

    expect(metricValue(container, "Login")).toBe("Ready");
    expect(metricValue(container, "Loop")).toBe("Autoplay");
    expect(metricValue(container, "Player")).toBe("9/10 hp · 3222, 3218");
    expect(metricValue(container, "Tutorial")).toBe("Active");
    expect(metricValue(container, "Viewer")).toBe("attached");
    expect(metricValue(container, "Bridge")).toBe("Ready");

    // Metric detail cells.
    expect(text).toContain("Talk to the RuneScape Guide.");
    expect(text).toContain("sess-oakbot42");
  });

  it("renders an activity row from collectActivity", () => {
    appState.appRuns = [detailRun()];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeDetailExtension, {
        app: appProp,
      }),
    );

    const text = container.textContent ?? "";
    expect(text).toContain("woodcut");
    expect(text).toContain("Started chopping Tree.");
    expect(text).not.toContain("No game activity yet.");
  });

  it("renders the empty activity state when there is no activity", () => {
    appState.appRuns = [
      detailRun({
        recentEvents: [],
        viewer: { postMessageAuth: true, authMessage: {} },
        session: {
          sessionId: "sess-oakbot42",
          canSendCommands: false,
          status: "connecting",
          activity: [],
          telemetry: {
            botName: "oakbot42",
            autoPlay: false,
            player: { name: "oakbot42", x: 3222, y: 3218, health: 9 },
            tutorial: { active: false },
            recentActivity: [],
          },
        },
      }),
    ];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeDetailExtension, {
        app: appProp,
      }),
    );

    const text = container.textContent ?? "";
    expect(text).toContain("No game activity yet.");
    // Manual login + paused loop reflect the degraded session.
    expect(metricValue(container, "Login")).toBe("Manual");
    expect(metricValue(container, "Loop")).toBe("Paused");
    expect(metricValue(container, "Bridge")).toBe("Waiting");
    expect(metricValue(container, "Tutorial")).toBe("Clear");
  });
});
