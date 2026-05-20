// @vitest-environment jsdom

import { createRequire } from "node:module";
import { fireEvent, screen } from "@testing-library/dom";
import type ReactTypes from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pluginRequire = createRequire(
  `${process.cwd()}/plugins/plugin-clawville/src/ui/ClawvilleOperatorSurface.tsx`,
);
const React = pluginRequire("react") as typeof ReactTypes;
const { flushSync } = pluginRequire("react-dom") as typeof import("react-dom");
const { createRoot } = pluginRequire(
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

function stubComponent(name: string) {
  return ({ children }: { children?: ReactTypes.ReactNode }) =>
    React.createElement("div", { "data-stub": name }, children);
}

const uiMock = vi.hoisted(() => ({
  Button: (props: ReactTypes.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, props.children),
  Input: (props: ReactTypes.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
  client: { sendAppRunMessage, controlAppRun },
  GameOperatorShell: stubComponent("GameOperatorShell"),
  SurfaceBadge: stubComponent("SurfaceBadge"),
  SurfaceCard: stubComponent("SurfaceCard"),
  SurfaceEmptyState: stubComponent("SurfaceEmptyState"),
  SurfaceGrid: stubComponent("SurfaceGrid"),
  SurfaceSection: stubComponent("SurfaceSection"),
  formatDetailTimestamp: (value: unknown) => String(value ?? ""),
  selectLatestRunForApp: latestRunForApp,
  toneForHealthState: () => "neutral",
  toneForStatusText: () => "neutral",
  toneForViewerAttachment: () => "neutral",
  useApp: () => appState,
}));

vi.mock("@elizaos/ui", () => uiMock);
vi.mock("@elizaos/app-core", () => uiMock);

import {
  interact as interact2004scape,
  TwoThousandFourScapeTuiView,
} from "../../../../plugins/plugin-2004scape/src/ui/TwoThousandFourScapeOperatorSurface";
import {
  ClawvilleTuiView,
  interact as interactClawville,
} from "../../../../plugins/plugin-clawville/src/ui/ClawvilleOperatorSurface";
import {
  DefenseAgentsTuiView,
  interact as interactDefense,
} from "../../../../plugins/plugin-defense-of-the-agents/src/ui/DefenseAgentsOperatorSurface";
import {
  HyperscapeTuiView,
  interact as interactHyperscape,
} from "../../../../plugins/plugin-hyperscape/src/ui/HyperscapeOperatorSurface";
import {
  interact as interactScape,
  ScapeTuiView,
} from "../../../../plugins/plugin-scape/src/ui/ScapeOperatorSurface";

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
      {
        ...baseRun,
        appName: "@elizaos/plugin-hyperscape",
        session: {
          canSendCommands: true,
          sessionId: "hyper-session",
          suggestedPrompts: ["look around"],
          followEntity: "agent-1",
        },
      },
      {
        ...baseRun,
        appName: "@elizaos/plugin-scape",
        session: {
          canSendCommands: true,
          status: "running",
          suggestedPrompts: ["check status"],
          telemetry: {
            connectionStatus: "connected",
            agent: { name: "scape-agent", position: { x: 1, z: 2 } },
            activeGoal: {
              id: "goal-1",
              title: "Train",
              status: "active",
              source: "operator",
            },
          },
        },
      },
      {
        ...baseRun,
        appName: "@elizaos/plugin-2004scape",
        session: {
          canSendCommands: true,
          status: "running",
          suggestedPrompts: ["continue tutorial"],
          telemetry: {
            player: {
              name: "bot",
              worldX: 3200,
              worldZ: 3201,
              hp: 9,
              maxHp: 10,
            },
            tutorial: { active: true },
          },
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
    cleanupSurfaces();

    expect(renderState(React.createElement(HyperscapeTuiView))).toMatchObject({
      viewId: "hyperscape",
      sessionId: "hyper-session",
      followEntity: "agent-1",
      canSend: true,
    });
    cleanupSurfaces();

    expect(renderState(React.createElement(ScapeTuiView))).toMatchObject({
      viewId: "scape",
      connectionStatus: "connected",
      canSend: true,
      agent: { name: "scape-agent", position: { x: 1, z: 2 } },
    });
    cleanupSurfaces();

    expect(
      renderState(React.createElement(TwoThousandFourScapeTuiView)),
    ).toMatchObject({
      viewId: "2004scape",
      canSend: true,
      player: { name: "bot", worldX: 3200, worldZ: 3201 },
      tutorialActive: true,
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

    renderSurface(React.createElement(ClawvilleTuiView));
    await act(async () => {
      fireEvent.click(screen.getByText("Visit nearest"));
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
    await expect(
      interactHyperscape("terminal-hyperscape-control", {
        runId: "run-1",
        action: "pause",
      }),
    ).resolves.toMatchObject({ viewType: "tui" });
    await expect(interactScape("terminal-scape-state")).resolves.toMatchObject({
      viewType: "tui",
      appName: "@elizaos/plugin-scape",
    });
    await expect(
      interact2004scape("terminal-2004scape-command", {
        runId: "run-1",
        content: "continue tutorial",
      }),
    ).resolves.toMatchObject({ viewType: "tui" });
  });
});
