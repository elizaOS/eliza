// @vitest-environment jsdom

import type { RegistryAppInfo } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAWVILLE_APP_NAME,
  makeClawvilleRun,
  makeClawvilleSession,
} from "./test-support";

const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
}));

vi.mock("@elizaos/ui", () => ({
  useApp: () => appState,
}));

const { render, screen, cleanup } = await import("@testing-library/react");
const { ClawvilleDetailExtension } = await import("./ClawvilleDetailExtension");

const app = { name: CLAWVILLE_APP_NAME } as RegistryAppInfo;

beforeEach(() => {
  appState.appRuns = [];
});

afterEach(() => {
  cleanup();
});

describe("ClawvilleDetailExtension", () => {
  it("renders the launch prompt when no run is attached", () => {
    render(<ClawvilleDetailExtension app={app} />);
    expect(
      screen.getByText("Launch ClawVille to attach the reef dashboard."),
    ).toBeTruthy();
    expect(screen.queryByTestId("clawville-detail-dashboard")).toBeNull();
  });

  it("renders Location, Wallet, and Viewer metrics from populated telemetry", () => {
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleDetailExtension app={app} />);

    expect(screen.getByTestId("clawville-detail-dashboard")).toBeTruthy();
    // goalLabel header
    expect(
      screen.getByText("Near Krusty Krab. Visit or ask the local NPC."),
    ).toBeTruthy();
    // Relay pill — canSendCommands true.
    expect(screen.getByText("Relay")).toBeTruthy();
    // Location metric formats the nearest building label.
    expect(screen.getByText("Krusty Krab")).toBeTruthy();
    // Wallet metric reads the telemetry wallet address verbatim.
    expect(screen.getByText("9x9x9x9x9x9x9x9x9x9xtest")).toBeTruthy();
    // Viewer metric reads run.viewerAttachment.
    expect(screen.getByText("attached")).toBeTruthy();
  });

  it("shows Pending wallet + Sync pill when wallet/commands are unavailable", () => {
    appState.appRuns = [
      makeClawvilleRun({
        session: makeClawvilleSession({
          canSendCommands: false,
          telemetry: { nearestBuildingLabel: "Chum Bucket" },
        }),
      }),
    ];
    render(<ClawvilleDetailExtension app={app} />);

    expect(screen.getByText("Sync")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Chum Bucket")).toBeTruthy();
  });

  it("renders the empty activity placeholder when there are no events", () => {
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleDetailExtension app={app} />);
    expect(screen.getByText("No reef events yet.")).toBeTruthy();
  });

  it("renders activity rows merged from recentEvents and session.activity (max 3)", () => {
    appState.appRuns = [
      makeClawvilleRun({
        recentEvents: [
          {
            eventId: "ev-1",
            kind: "status",
            severity: "info",
            message: "Arrived at Krusty Krab",
            createdAt: "2026-04-24T00:00:00.000Z",
          },
        ],
        session: makeClawvilleSession({
          activity: [
            {
              id: "act-1",
              type: "chat",
              message: "Asked the fry cook about MCP tools",
              timestamp: 1_700_000_000_000,
              severity: "info",
            },
            {
              id: "act-2",
              type: "move",
              message: "Walking to the Chum Bucket",
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
    render(<ClawvilleDetailExtension app={app} />);

    expect(screen.queryByText("No reef events yet.")).toBeNull();
    // First 3 of [server event, ...activity] are shown.
    expect(screen.getByText("Arrived at Krusty Krab")).toBeTruthy();
    expect(screen.getByText("Asked the fry cook about MCP tools")).toBeTruthy();
    expect(screen.getByText("Walking to the Chum Bucket")).toBeTruthy();
    // The 4th merged item is truncated by slice(0, 3).
    expect(screen.queryByText("fourth entry sliced off")).toBeNull();
  });
});
