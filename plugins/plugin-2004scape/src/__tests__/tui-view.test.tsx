// @vitest-environment jsdom

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type ReactTypes from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeNormalizedTelemetry, makePopulatedRun } from "./fixtures";

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
  "plugins/plugin-2004scape/src/ui/TwoThousandFourScapeOperatorSurface.tsx",
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

const setActionNotice = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setActionNotice,
  setState: vi.fn(),
}));
const postAppRunCommand = vi.hoisted(() => vi.fn());

function latestRunForApp(
  appName: string,
  appRuns: Array<Record<string, unknown>>,
) {
  const matchingRuns = appRuns.filter((run) => run.appName === appName);
  return { run: matchingRuns[0] ?? null, matchingRuns };
}

const uiMock = vi.hoisted(() => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  formatDetailTimestamp: (value: unknown) =>
    value == null ? "" : String(value),
  selectLatestRunForApp: latestRunForApp,
  toneForHealthState: () => "neutral",
  toneForStatusText: () => "neutral",
  toneForViewerAttachment: () => "neutral",
  SurfaceCard: () => null,
  SurfaceBadge: () => null,
  SurfaceSection: () => null,
  SurfaceEmptyState: () => null,
  SurfaceGrid: () => null,
  registerOperatorSurface: () => {},
  registerDetailExtension: () => {},
  useApp: () => appState,
}));

vi.mock("@elizaos/app-core/ui-compat", () => uiMock);
vi.mock("@elizaos/ui/agent-surface", () => uiMock);
vi.mock("../ui/TwoThousandFourScapeOperatorSurface.helpers", () => ({
  postAppRunCommand,
}));

const { TwoThousandFourScapeTuiView } = await import(
  "../ui/TwoThousandFourScapeOperatorSurface"
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

function viewState(container: HTMLElement) {
  const el = container.querySelector("[data-view-state]");
  return JSON.parse(el?.getAttribute("data-view-state") ?? "{}");
}

function buttonByText(container: HTMLElement, text: string) {
  const el = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((node) => node.textContent?.trim() === text);
  if (!el) throw new Error(`No button with text "${text}"`);
  return el;
}

function commandInput(container: HTMLElement) {
  const el = container.querySelector<HTMLInputElement>(
    'input[aria-label="2004scape command"]',
  );
  if (!el) throw new Error("No command input");
  return el;
}

// React 19 tracks input value via its own descriptor; setting `.value` directly
// is masked. Use the native prototype setter so the dispatched `input` event
// carries the new value through to the controlled onChange handler.
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  postAppRunCommand.mockResolvedValue({ success: true, message: "Queued." });
});

afterEach(() => {
  cleanupSurfaces();
  vi.clearAllMocks();
  appState.appRuns = [];
});

describe("TwoThousandFourScapeTuiView", () => {
  it("exposes populated view-state and header/state-panel data", () => {
    appState.appRuns = [makePopulatedRun()];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeTuiView),
    );

    expect(viewState(container)).toMatchObject({
      viewType: "tui",
      viewId: "2004scape",
      runId: "run-oakbot42",
      status: "running",
      sessionStatus: "running",
      canSend: true,
      activeRunCount: 1,
      autoPlayEnabled: true,
      player: {
        name: "oakbot42",
        worldX: 3222,
        worldZ: 3218,
        hp: 9,
        maxHp: 10,
      },
      tutorialActive: true,
      nearbyTargetCount: 3,
      recentActivityCount: 2,
      suggestedPromptCount: 3,
    });

    const text = container.textContent ?? "";
    expect(text).toContain("elizaos://2004scape --type=tui");
    expect(text).toContain("3222, 3218 · 9/10 HP");
    expect(text).toContain("autoplay on");
    expect(text).toContain("run run-oakbot42");
    expect(text).toContain("session sess-oakbot42");
    expect(text).toContain("commands available");
    expect(text).toContain("nearby targets 3");
  });

  it("sends a suggested-prompt button as a message", async () => {
    appState.appRuns = [makePopulatedRun()];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeTuiView),
    );

    await act(async () => {
      buttonByText(container, "Finish tutorial").click();
    });

    expect(postAppRunCommand).toHaveBeenCalledWith("run-oakbot42", "message", {
      content: "Finish tutorial",
    });
    expect(setActionNotice).toHaveBeenCalledWith("Queued.", "success", 2600);
  });

  it("submits the command input on Enter and clears the draft", async () => {
    appState.appRuns = [makePopulatedRun()];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeTuiView),
    );
    const input = commandInput(container);

    await act(async () => {
      typeInto(input, "chop the oak");
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(postAppRunCommand).toHaveBeenCalledWith("run-oakbot42", "message", {
      content: "chop the oak",
    });
    expect(commandInput(container).value).toBe("");
  });

  it("sends via the send-command button and gates it on a non-empty draft", async () => {
    appState.appRuns = [makePopulatedRun()];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeTuiView),
    );

    // Disabled with an empty draft.
    expect(buttonByText(container, "send command").disabled).toBe(true);

    const input = commandInput(container);
    await act(async () => {
      typeInto(input, "go fishing");
    });

    const send = buttonByText(container, "send command");
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.click();
    });

    expect(postAppRunCommand).toHaveBeenCalledWith("run-oakbot42", "message", {
      content: "go fishing",
    });
  });

  it("disables steering controls when commands are unavailable", () => {
    appState.appRuns = [
      makePopulatedRun({
        session: {
          sessionId: "sess-oakbot42",
          canSendCommands: false,
          status: "connecting",
          suggestedPrompts: ["Finish tutorial"],
          telemetry: bridgeNormalizedTelemetry,
        },
      }),
    ];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeTuiView),
    );

    expect(viewState(container).canSend).toBe(false);
    expect(buttonByText(container, "Finish tutorial").disabled).toBe(true);
    expect(commandInput(container).disabled).toBe(true);
    expect(buttonByText(container, "send command").disabled).toBe(true);
    expect(container.textContent ?? "").toContain("commands unavailable");
  });

  it("falls back to default suggested prompts when none are provided", () => {
    appState.appRuns = [
      makePopulatedRun({
        session: {
          sessionId: "sess-oakbot42",
          canSendCommands: true,
          status: "running",
          suggestedPrompts: [],
          telemetry: bridgeNormalizedTelemetry,
        },
      }),
    ];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeTuiView),
    );

    expect(buttonByText(container, "check status")).toBeTruthy();
    expect(buttonByText(container, "continue tutorial")).toBeTruthy();
    expect(buttonByText(container, "pause")).toBeTruthy();
  });
});
