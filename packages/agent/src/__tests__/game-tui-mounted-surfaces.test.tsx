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

const clawvilleSurfacePath = findAncestor(
  process.cwd(),
  "plugins/plugin-clawville/src/ui/ClawvilleOperatorSurface.tsx",
);
const pluginRequire = createRequire(clawvilleSurfacePath);
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
const mountedRoots: Array<{
  container: HTMLElement;
  root: ReturnType<typeof createRoot>;
}> = [];

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const controlAppRun = vi.hoisted(() => vi.fn());
const setActionNotice = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn());

const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setActionNotice,
  setState,
}));

function latestRunForApp(
  appName: string,
  appRuns: Array<Record<string, unknown>>,
) {
  const matchingRuns = appRuns
    .filter((run) => run.appName === appName)
    .sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
    );
  return { run: matchingRuns[0] ?? null, matchingRuns };
}

function fixtureComponent(name: string) {
  return ({ children }: { children?: ReactTypes.ReactNode }) =>
    React.createElement("div", { "data-fixture": name }, children);
}

const uiMock = vi.hoisted(() => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  Button: (props: ReactTypes.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, props.children),
  Input: (props: ReactTypes.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
  client: { sendAppRunMessage, controlAppRun },
  GameOperatorShell: fixtureComponent("GameOperatorShell"),
  SurfaceBadge: fixtureComponent("SurfaceBadge"),
  SurfaceCard: fixtureComponent("SurfaceCard"),
  SurfaceEmptyState: fixtureComponent("SurfaceEmptyState"),
  SurfaceGrid: fixtureComponent("SurfaceGrid"),
  SurfaceSection: fixtureComponent("SurfaceSection"),
  formatDetailTimestamp: (value: unknown) => String(value ?? ""),
  selectLatestRunForApp: latestRunForApp,
  toneForHealthState: () => "neutral",
  toneForStatusText: () => "neutral",
  toneForViewerAttachment: () => "neutral",
  useApp: () => appState,
}));

vi.mock("@elizaos/ui", () => uiMock);
vi.mock("@elizaos/ui/agent-surface", () => uiMock);
vi.mock("@elizaos/app-core", () => uiMock);
vi.mock("@elizaos/app-core/ui-compat", () => uiMock);

import { ClawvilleTuiView } from "../../../../plugins/plugin-clawville/src/ui/ClawvilleOperatorSurface";
import { interact as interactClawville } from "../../../../plugins/plugin-clawville/src/ui/ClawvilleOperatorSurface.interact";
import { DefenseAgentsTuiView } from "../../../../plugins/plugin-defense-of-the-agents/src/ui/DefenseAgentsOperatorSurface";
import { interact as interactDefense } from "../../../../plugins/plugin-defense-of-the-agents/src/ui/DefenseAgentsOperatorSurface.interact";

const baseRun = {
  runId: "run-1",
  status: "running",
  updatedAt: "2026-05-19T00:00:00.000Z",
  health: { state: "healthy" },
  viewerAttachment: "attached",
  supportsBackground: true,
  viewer: { authMessage: {}, embedParams: {} },
  recentEvents: [],
};

function renderSurface(component: ReactTypes.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ container, root });
  flushSync(() => {
    root.render(component);
  });
  return { container, root };
}

function cleanupSurfaces() {
  for (const { container, root } of mountedRoots.splice(0)) {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
  }
}

function renderState(component: ReactTypes.ReactElement) {
  const { container } = renderSurface(component);
  const element = container.querySelector("[data-view-state]");
  return JSON.parse(element?.getAttribute("data-view-state") ?? "{}");
}

function getElementByText(container: HTMLElement, text: string) {
  const elements = Array.from(container.querySelectorAll<HTMLElement>("*"));
  const match = elements.find(
    (element) => element.textContent?.trim() === text,
  );
  if (!match) {
    throw new Error(`Unable to find element with text: ${text}`);
  }
  return match;
}

afterEach(() => {
  cleanupSurfaces();
  vi.clearAllMocks();
  appState.appRuns = [];
  vi.unstubAllGlobals();
});

describe("game TUI mounted surfaces", () => {
  it("mounts app-run-aware TUI state for the remaining game operators", () => {
    appState.appRuns = [
      {
        ...baseRun,
        appName: "@elizaos/plugin-clawville",
        session: {
          canSendCommands: true,
          suggestedPrompts: ["Visit nearest"],
          telemetry: { nearestBuildingLabel: "Tools", knowledgeCount: 7 },
        },
      },
      {
        ...baseRun,
        appName: "@elizaos/plugin-defense-of-the-agents",
        session: {
          canSendCommands: true,
          suggestedPrompts: ["review strategy"],
          telemetry: { heroClass: "mage", heroLane: "mid", heroLevel: 2 },
        },
      },
    ];

    expect(renderState(React.createElement(ClawvilleTuiView))).toMatchObject({
      viewType: "tui",
      viewId: "clawville",
      nearestBuilding: "Tools",
      knowledgeCount: 7,
      canSend: true,
    });
    cleanupSurfaces();

    expect(
      renderState(React.createElement(DefenseAgentsTuiView)),
    ).toMatchObject({
      viewId: "defense-of-the-agents",
      heroLane: "mid",
      canSend: true,
    });
  });

  it("sends commands through the same app-run client used by GUI surfaces", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "queued",
      run: null,
    });
    appState.appRuns = [
      {
        ...baseRun,
        appName: "@elizaos/plugin-clawville",
        session: { canSendCommands: true, suggestedPrompts: ["Visit nearest"] },
      },
    ];

    const { container } = renderSurface(React.createElement(ClawvilleTuiView));
    await act(async () => {
      getElementByText(container, "Visit nearest").click();
    });
    await vi.waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith("run-1", "Visit nearest"),
    );
  });

  it("exposes terminal command capabilities for game operators", async () => {
    sendAppRunMessage.mockResolvedValue({ success: true, message: "queued" });
    controlAppRun.mockResolvedValue({ success: true, message: "paused" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 202,
        json: async () => ({ success: true, message: "queued" }),
      })),
    );

    await expect(
      interactClawville("terminal-clawville-state"),
    ).resolves.toMatchObject({
      viewType: "tui",
      appName: "@elizaos/plugin-clawville",
    });
    await expect(
      interactDefense("terminal-defense-command", {
        runId: "run-1",
        content: "review strategy",
      }),
    ).resolves.toMatchObject({ viewType: "tui" });
  });
});
