// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getLifeOpsScreenTimeBreakdown: vi.fn(),
    getLifeOpsSocialHabitSummary: vi.fn(),
    getWebsiteBlockerStatus: vi.fn(),
    getAppBlockerStatus: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core", () => ({
  client: clientMock,
}));

import { LifeOpsScreenTimeSection } from "./LifeOpsScreenTimeSection.js";

const breakdown = {
  byBrowser: [{ key: "Arc", label: "Arc", totalSeconds: 900 }],
  byCategory: [{ key: "dev", label: "Development", totalSeconds: 3600 }],
  byDevice: [{ key: "desktop", label: "Desktop", totalSeconds: 3600 }],
  byService: [],
  bySource: [{ key: "app", label: "Apps", totalSeconds: 3600 }],
  fetchedAt: "2026-04-25T12:00:00.000Z",
  items: [
    {
      displayName: "Editor",
      identifier: "com.example.Editor",
      source: "app",
      totalSeconds: 3600,
    },
  ],
  totalSeconds: 3600,
};

const social = {
  browsers: [],
  dataSources: [],
  devices: [],
  fetchedAt: "2026-04-25T12:00:00.000Z",
  messages: {
    channels: [
      {
        channel: "imessage",
        inbound: 2,
        opened: 3,
        outbound: 1,
      },
    ],
    inbound: 2,
    opened: 3,
    outbound: 1,
    replied: 1,
  },
  services: [{ key: "x", label: "X", totalSeconds: 600 }],
  sessions: [],
  since: "2026-04-25T00:00:00.000Z",
  surfaces: [],
  totalSeconds: 600,
  until: "2026-04-25T12:00:00.000Z",
};

beforeEach(() => {
  clientMock.getLifeOpsScreenTimeBreakdown.mockResolvedValue(breakdown);
  clientMock.getLifeOpsSocialHabitSummary.mockResolvedValue(social);
  clientMock.getWebsiteBlockerStatus.mockResolvedValue({
    active: false,
    available: true,
    canUnblockEarly: true,
    elevationPromptMethod: null,
    endsAt: null,
    engine: "hosts-file",
    hostsFilePath: "/etc/hosts",
    platform: "darwin",
    requiresElevation: true,
    supportsElevationPrompt: true,
    websites: [],
  });
  clientMock.getAppBlockerStatus.mockResolvedValue({
    active: false,
    available: false,
    blockedCount: 0,
    blockedPackageNames: [],
    endsAt: null,
    engine: "none",
    permissionStatus: "not-applicable",
    platform: "web",
    reason: "App blocking is only available on mobile.",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsScreenTimeSection", () => {
  it("loads screen-time and social summaries for the selected range", async () => {
    render(<LifeOpsScreenTimeSection />);

    expect(screen.getByTestId("lifeops-screen-time-section")).toBeTruthy();
    await waitFor(() =>
      expect(clientMock.getLifeOpsScreenTimeBreakdown).toHaveBeenCalledWith(
        expect.objectContaining({ topN: 16 }),
      ),
    );
    expect(clientMock.getLifeOpsSocialHabitSummary).toHaveBeenCalledWith(
      expect.objectContaining({ topN: 12 }),
    );
    expect(await screen.findByText("Editor")).toBeTruthy();
    expect(screen.getByText("Development")).toBeTruthy();
  });

  it("renders unified current website and app block status", async () => {
    clientMock.getWebsiteBlockerStatus.mockResolvedValue({
      active: true,
      available: true,
      canUnblockEarly: true,
      elevationPromptMethod: null,
      endsAt: null,
      engine: "hosts-file",
      hostsFilePath: "/etc/hosts",
      platform: "darwin",
      requiresElevation: true,
      supportsElevationPrompt: true,
      websites: ["x.com", "reddit.com"],
    });
    clientMock.getAppBlockerStatus.mockResolvedValue({
      active: true,
      available: true,
      blockedCount: 2,
      blockedPackageNames: ["com.twitter.android", "com.reddit.frontpage"],
      endsAt: null,
      engine: "usage-stats-overlay",
      permissionStatus: "granted",
      platform: "android",
    });

    render(<LifeOpsScreenTimeSection />);

    expect(await screen.findByText("Websites and apps blocked")).toBeTruthy();
    expect(screen.getByText("Websites: 2 websites")).toBeTruthy();
    expect(screen.getByText("Apps: 2 apps on ANDROID")).toBeTruthy();
  });

  it("links incomplete tracking setup from the empty Screen Time state", async () => {
    clientMock.getLifeOpsScreenTimeBreakdown.mockResolvedValue({
      ...breakdown,
      byBrowser: [],
      byCategory: [],
      byDevice: [],
      bySource: [],
      items: [],
      totalSeconds: 0,
    });
    clientMock.getLifeOpsSocialHabitSummary.mockResolvedValue({
      ...social,
      dataSources: [
        { id: "browser_bridge", label: "Browser", state: "partial" },
        { id: "android_usage_stats", label: "Android apps", state: "unwired" },
      ],
      messages: {
        channels: [],
        inbound: 0,
        opened: 0,
        outbound: 0,
        replied: 0,
      },
      services: [],
      sessions: [],
      surfaces: [],
      totalSeconds: 0,
    });
    const onNavigate = vi.fn();

    render(<LifeOpsScreenTimeSection onNavigate={onNavigate} />);

    expect(await screen.findByText("Tracking setup incomplete")).toBeTruthy();
    expect(screen.getByText("Check Browser and Android apps.")).toBeTruthy();
    screen.getAllByRole("button", { name: "Open LifeOps setup" })[0].click();
    expect(onNavigate).toHaveBeenCalledWith("setup");
  });
});
