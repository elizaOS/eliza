// @vitest-environment jsdom

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type ReactTypes from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePopulatedRun } from "./fixtures";

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

// Surface primitives that render label/value/subtitle/children into the DOM so
// populated data can actually be asserted (not just structure). Component bodies
// reference the module-scope `React` lazily (only invoked at render time, after
// the createRequire pin is assigned) — matching the sibling harness pattern.
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
vi.mock("../ui/TwoThousandFourScapeOperatorSurface.helpers", () => ({
  postAppRunCommand,
}));

const { TwoThousandFourScapeOperatorSurface } = await import(
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

beforeEach(() => {
  postAppRunCommand.mockResolvedValue({ success: true, message: "Queued." });
});

afterEach(() => {
  cleanupSurfaces();
  vi.clearAllMocks();
  appState.appRuns = [];
});

describe("TwoThousandFourScapeOperatorSurface (gui/xr)", () => {
  it("renders the no-run standby empty state", () => {
    appState.appRuns = [];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeOperatorSurface, {
        appName: "@elizaos/plugin-2004scape",
      }),
    );

    expect(
      container.querySelector('[data-testid="2004scape-operator-ready"]'),
    ).not.toBeNull();
    const text = container.textContent ?? "";
    // 4 standby StatChips render their labels.
    expect(text).toContain("Gateway");
    expect(text).toContain("Planner");
    expect(text).toContain("Telemetry");
    expect(text).toContain("Targets");
    // WaitingForSession copy.
    expect(text).toContain("Waiting for a 2004scape session");
    // Spawn bot CTA is present and disabled.
    const spawn = clickByText(container, "Spawn bot");
    expect(spawn.disabled).toBe(true);
  });

  it("renders populated live data regions with specific values", () => {
    appState.appRuns = [makePopulatedRun()];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeOperatorSurface, {
        appName: "@elizaos/plugin-2004scape",
        variant: "live",
      }),
    );

    expect(
      container.querySelector(
        '[data-testid="2004scape-live-operator-surface"]',
      ),
    ).not.toBeNull();

    const text = container.textContent ?? "";

    // Live StatChips: Player coords/HP and Targets count.
    expect(text).toContain("3222, 3218 · 9/10 HP");
    // Guide + Tree loc + Fishing spot, capped at top 3.
    expect(text).toContain("3 nearby");

    // Runtime section SurfaceCards.
    expect(cardValue(container, "Login")).toBe("Credentials stored");
    expect(cardSubtitle(container, "Login")).toBe("oakbot42");
    expect(cardValue(container, "Autoplay")).toBe("Autoplay active");
    expect(cardValue(container, "Tutorial")).toBe("Tutorial in progress");
    expect(cardSubtitle(container, "Tutorial")).toBe(
      "Talk to the RuneScape Guide to begin.",
    );
    expect(cardValue(container, "Steering")).toBe("Live steering ready");
    expect(cardSubtitle(container, "Steering")).toBe("Session sess-oakbot42");

    // Live State section SurfaceCards.
    expect(cardValue(container, "Goal")).toBe(
      "Finish tutorial and reach the mainland.",
    );
    expect(cardValue(container, "Current Intent")).toBe("tutorial");
    expect(cardValue(container, "Player")).toBe("3222, 3218 · 9/10 HP");
    expect(cardSubtitle(container, "Player")).toBe(
      "oakbot42 · Bronze axe · Accurate",
    );
    expect(cardValue(container, "Viewer")).toBe("Viewer attached");

    // Field Intel merges nearby targets + skills/inventory summary.
    expect(cardValue(container, "Field Intel")).toContain(
      "RuneScape Guide (Talk-to)",
    );
    expect(cardSubtitle(container, "Field Intel")).toContain("Woodcutting 5");
    expect(cardSubtitle(container, "Field Intel")).toContain("Bronze axe");

    // Nearby Targets list: name + formatDistance + action.
    expect(text).toContain("RuneScape Guide");
    expect(text).toContain("1.4 tiles");
    expect(text).toContain("Talk-to");
    expect(text).toContain("Tree");
    expect(text).toContain("2.0 tiles");
    expect(text).toContain("Chop down");

    // Game Feed: extractGameplayNotes merges dialogs+messages, reversed, top 2 —
    // the two most-recent game messages (empty sender -> "Game" label).
    expect(text).toContain("You get some logs.");
    expect(text).toContain("Welcome to 2004scape.");

    // Recent Activity list.
    expect(text).toContain("woodcut");
    expect(text).toContain("Started chopping Tree.");
  });

  it("fires a pause control POST when the Hero Pause CTA is clicked", async () => {
    appState.appRuns = [makePopulatedRun()]; // controls: ["pause"]
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeOperatorSurface, {
        appName: "@elizaos/plugin-2004scape",
        variant: "live",
      }),
    );

    await act(async () => {
      clickByText(container, "Pause").click();
    });

    expect(postAppRunCommand).toHaveBeenCalledWith("run-oakbot42", "control", {
      action: "pause",
    });
    // statusMessage banner renders the response message.
    expect(container.textContent).toContain("Queued.");
  });

  it("fires a resume control POST via the steering ControlButton", async () => {
    appState.appRuns = [
      makePopulatedRun({
        session: {
          sessionId: "sess-oakbot42",
          canSendCommands: true,
          controls: ["resume"],
          status: "paused",
          goalLabel: "Resume the loop.",
          suggestedPrompts: ["Resume autoplay"],
          telemetry: { paused: true },
        },
      }),
    ];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeOperatorSurface, {
        appName: "@elizaos/plugin-2004scape",
      }),
    );

    await act(async () => {
      clickByText(container, "Resume session").click();
    });

    expect(postAppRunCommand).toHaveBeenCalledWith("run-oakbot42", "control", {
      action: "resume",
    });
  });

  it("sends a suggested prompt as an operator message", async () => {
    appState.appRuns = [makePopulatedRun()];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeOperatorSurface, {
        appName: "@elizaos/plugin-2004scape",
      }),
    );

    await act(async () => {
      clickByText(container, "Finish tutorial").click();
    });

    expect(postAppRunCommand).toHaveBeenCalledWith("run-oakbot42", "message", {
      content: "Finish tutorial",
    });
  });

  it("renders the error path in the status banner", async () => {
    postAppRunCommand.mockRejectedValueOnce(new Error("Bridge offline"));
    appState.appRuns = [makePopulatedRun()];
    const container = renderSurface(
      React.createElement(TwoThousandFourScapeOperatorSurface, {
        appName: "@elizaos/plugin-2004scape",
        variant: "live",
      }),
    );

    await act(async () => {
      clickByText(container, "Pause").click();
    });

    expect(container.textContent).toContain("Bridge offline");
  });
});
