// @vitest-environment jsdom

import type { RegistryAppInfo } from "@elizaos/shared";
import type ReactTypes from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HYPERSCAPE_APP_NAME,
  makeHyperscapeRun,
  makeHyperscapeSession,
} from "./test-support";

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
  useApp: () => appState,
  selectLatestRunForApp: latestRunForApp,
  SurfaceBadge: ({ children }: { children?: ReactTypes.ReactNode }) => {
    const React = require("react") as typeof ReactTypes;
    return React.createElement(
      "span",
      { "data-stub": "SurfaceBadge" },
      children,
    );
  },
  SurfaceEmptyState: (props: { title: string; body: string }) => {
    const React = require("react") as typeof ReactTypes;
    return React.createElement(
      "div",
      { "data-stub": "SurfaceEmptyState" },
      React.createElement("div", null, props.title),
      React.createElement("div", null, props.body),
    );
  },
  formatDetailTimestamp: (value: unknown) =>
    value == null ? "" : `ts:${String(value)}`,
  toneForHealthState: () => "neutral",
  toneForStatusText: () => "neutral",
  toneForViewerAttachment: () => "neutral",
}));

const { render, screen, cleanup } = await import("@testing-library/react");
const { HyperscapeDetailExtension } = await import(
  "./HyperscapeDetailExtension"
);

const app = { name: HYPERSCAPE_APP_NAME } as RegistryAppInfo;

beforeEach(() => {
  appState.appRuns = [];
});

afterEach(() => {
  cleanup();
});

describe("HyperscapeDetailExtension", () => {
  it("renders the launch empty state when no run is attached", () => {
    render(<HyperscapeDetailExtension app={app} />);
    expect(
      screen.getByText(
        "Launch the app to attach the viewer and start telemetry.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("hyperscape-detail-dashboard")).toBeNull();
  });

  it("renders the header (goalLabel, run count, status badge) + Viewer/Follow/Relay/Health metrics", () => {
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeDetailExtension app={app} />);

    expect(screen.getByTestId("hyperscape-detail-dashboard")).toBeTruthy();
    // Header title = session.goalLabel.
    expect(screen.getByText("Explore the northern district")).toBeTruthy();
    // run count pluralization (1 run).
    expect(screen.getByText("1 run")).toBeTruthy();
    // status badge text.
    expect(screen.getByText("running")).toBeTruthy();
    // Viewer metric = run.viewerAttachment.
    expect(screen.getByText("attached")).toBeTruthy();
    // Follow metric = session.followEntity.
    expect(screen.getAllByText("milady-character").length).toBeGreaterThan(0);
    // Relay metric = canSendCommands → "Ready".
    expect(screen.getByText("Ready")).toBeTruthy();
    // Health metric = run.health.state.
    expect(screen.getByText("healthy")).toBeTruthy();
  });

  it("falls back to run.summary / 'Host ready' header and Waiting/Pending when session is sparse", () => {
    appState.appRuns = [
      makeHyperscapeRun({
        summary: null,
        session: makeHyperscapeSession({
          goalLabel: null,
          canSendCommands: false,
          followEntity: undefined,
          characterId: undefined,
        }),
      }),
    ];
    render(<HyperscapeDetailExtension app={app} />);

    // goalLabel null, run.summary null → "Host ready".
    expect(screen.getByText("Host ready")).toBeTruthy();
    // followEntity falls back to viewer.authMessage.followEntity.
    expect(screen.getAllByText("milady-character").length).toBeGreaterThan(0);
    // canSendCommands false → relay "Waiting".
    expect(screen.getByText("Waiting")).toBeTruthy();
  });

  it("renders the empty activity placeholder when there are no events", () => {
    appState.appRuns = [makeHyperscapeRun({ recentEvents: [] })];
    render(<HyperscapeDetailExtension app={app} />);
    expect(screen.getByText("No activity yet.")).toBeTruthy();
  });

  it("merges recentEvents + session.activity and slices to the first 3 rows", () => {
    appState.appRuns = [
      makeHyperscapeRun({
        recentEvents: [
          {
            eventId: "ev-1",
            kind: "status",
            severity: "info",
            message: "Arrived at the plaza",
            createdAt: "2026-05-19T00:00:00.000Z",
          },
        ],
        session: makeHyperscapeSession({
          activity: [
            {
              id: "act-1",
              type: "chat",
              message: "Spoke with the merchant",
              timestamp: 1_700_000_000_000,
              severity: "info",
            },
            {
              id: "act-2",
              type: "move",
              message: "Walking to the north gate",
              timestamp: 1_700_000_001_000,
              severity: "info",
            },
            {
              id: "act-3",
              type: "move",
              message: "fourth entry sliced off",
              timestamp: 1_700_000_002_000,
              severity: "info",
            },
          ],
        }),
      }),
    ];
    render(<HyperscapeDetailExtension app={app} />);

    expect(screen.queryByText("No activity yet.")).toBeNull();
    // First 3 of [server event, ...activity] are shown.
    expect(screen.getByText("Arrived at the plaza")).toBeTruthy();
    expect(screen.getByText("Spoke with the merchant")).toBeTruthy();
    expect(screen.getByText("Walking to the north gate")).toBeTruthy();
    // The 4th merged item is truncated by slice(0, 3).
    expect(screen.queryByText("fourth entry sliced off")).toBeNull();
  });
});
