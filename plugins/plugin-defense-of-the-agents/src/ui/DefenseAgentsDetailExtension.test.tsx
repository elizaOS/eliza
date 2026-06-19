// @vitest-environment jsdom

import type { RegistryAppInfo } from "@elizaos/shared";
import type ReactTypes from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFENSE_APP_NAME,
  makeDefenseRun,
  makeDefenseSession,
  makeDefenseTelemetry,
} from "./test-support";

const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
}));

// Real-shaped selectLatestRunForApp so the extension's matchingRuns.length and
// latest-run selection logic run for real.
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

vi.mock("@elizaos/app-core/ui-compat", () => ({
  useApp: () => appState,
  selectLatestRunForApp: latestRunForApp,
  toneForStatusText: () => "neutral",
  SurfaceBadge: ({ children }: { children?: ReactTypes.ReactNode }) => {
    const React = require("react") as typeof ReactTypes;
    return React.createElement("span", { "data-fixture": "badge" }, children);
  },
  SurfaceEmptyState: ({ title, body }: { title: string; body: string }) => {
    const React = require("react") as typeof ReactTypes;
    return React.createElement(
      "div",
      { "data-fixture": "empty-state" },
      React.createElement("div", null, title),
      React.createElement("div", null, body),
    );
  },
}));

const { render, screen, cleanup } = await import("@testing-library/react");
const { DefenseAgentsDetailExtension } = await import(
  "./DefenseAgentsDetailExtension"
);

const app = { name: DEFENSE_APP_NAME } as RegistryAppInfo;

beforeEach(() => {
  appState.appRuns = [];
});

afterEach(() => {
  cleanup();
});

describe("DefenseAgentsDetailExtension", () => {
  it("renders the launch empty state when no run is attached", () => {
    render(<DefenseAgentsDetailExtension app={app} />);
    expect(screen.getByText("Defense")).toBeTruthy();
    expect(
      screen.getByText(
        "Launch the match to deploy a hero and stream lane telemetry.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("defense-detail-dashboard")).toBeNull();
  });

  it("renders header, run count, and the four metrics from populated telemetry", () => {
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsDetailExtension app={app} />);

    expect(screen.getByTestId("defense-detail-dashboard")).toBeTruthy();
    // Header goalLabel.
    expect(screen.getByText("Mage holding mid lane")).toBeTruthy();
    // matchingRuns.length === 1 → "1 run".
    expect(screen.getByText("1 run")).toBeTruthy();
    // Status badge.
    expect(screen.getByText("running")).toBeTruthy();
    // Hero metric: "Mage Lv3" + "80/100 hp" detail (success tone: 80/100 ≥ 0.35).
    expect(screen.getByText("Mage Lv3")).toBeTruthy();
    expect(screen.getByText("80/100 hp")).toBeTruthy();
    // Lane metric: "Mid" + gameId detail.
    expect(screen.getByText("Mid")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    // Mode metric: Autoplay + "Relay ready".
    expect(screen.getByText("Autoplay")).toBeTruthy();
    expect(screen.getByText("Relay ready")).toBeTruthy();
    // Viewer metric: attachment value.
    expect(screen.getByText("attached")).toBeTruthy();
  });

  it("shows Manual + Relay pending when commands are unavailable", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          canSendCommands: false,
          telemetry: makeDefenseTelemetry({ autoPlay: false }),
        }),
      }),
    ];
    render(<DefenseAgentsDetailExtension app={app} />);

    expect(screen.getByText("Manual")).toBeTruthy();
    expect(screen.getByText("Relay pending")).toBeTruthy();
  });

  it("renders the hero metric with a low-HP warn detail when hp/maxHp < 0.35", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          telemetry: makeDefenseTelemetry({ heroHp: 20, heroMaxHp: 100 }),
        }),
      }),
    ];
    render(<DefenseAgentsDetailExtension app={app} />);
    // 20/100 = 0.2 < 0.35 → warn rail; detail still shows the ratio.
    expect(screen.getByText("20/100 hp")).toBeTruthy();
  });

  it("renders ActivityList rows from telemetry recentActivity", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          telemetry: makeDefenseTelemetry({
            recentActivity: [
              {
                ts: 1_700_000_000_000,
                action: "command",
                detail: "Learned Fireball",
              },
              {
                ts: 1_700_000_001_000,
                action: "move",
                detail: "Moving to top lane to reinforce",
              },
            ],
          }),
        }),
      }),
    ];
    render(<DefenseAgentsDetailExtension app={app} />);

    expect(screen.queryByText("No match events yet.")).toBeNull();
    expect(screen.getByText("Learned Fireball")).toBeTruthy();
    expect(screen.getByText("Moving to top lane to reinforce")).toBeTruthy();
  });

  it("renders the empty activity placeholder when there are no events", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          telemetry: makeDefenseTelemetry({ recentActivity: [] }),
        }),
      }),
    ];
    render(<DefenseAgentsDetailExtension app={app} />);
    expect(screen.getByText("No match events yet.")).toBeTruthy();
  });
});
