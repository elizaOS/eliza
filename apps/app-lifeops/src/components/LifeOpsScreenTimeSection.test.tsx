// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getLifeOpsScreenTimeHistory: vi.fn(),
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
        label: "iMessage",
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

function historyResponse({
  nextBreakdown = breakdown,
  nextSocial = social,
  hasUsage = true,
}: {
  nextBreakdown?: typeof breakdown;
  nextSocial?: typeof social;
  hasUsage?: boolean;
} = {}) {
  return {
    range: "today",
    label: "Today",
    window: {
      since: "2026-04-25T00:00:00.000Z",
      until: "2026-04-25T12:00:00.000Z",
    },
    priorWindow: null,
    breakdown: nextBreakdown,
    social: nextSocial,
    history: [],
    metrics: {
      totalSeconds: nextBreakdown.totalSeconds,
      appSeconds:
        nextBreakdown.bySource.find((item) => item.key === "app")
          ?.totalSeconds ?? 0,
      webSeconds:
        nextBreakdown.bySource.find((item) => item.key === "website")
          ?.totalSeconds ?? 0,
      phoneSeconds:
        nextBreakdown.byDevice.find((item) => item.key === "phone")
          ?.totalSeconds ?? 0,
      socialSeconds: nextSocial.totalSeconds,
      youtubeSeconds:
        nextSocial.services.find((item) => item.key === "youtube")
          ?.totalSeconds ?? 0,
      xSeconds:
        nextSocial.services.find((item) => item.key === "x")?.totalSeconds ?? 0,
      messageOpened: nextSocial.messages.opened,
      messageOutbound: nextSocial.messages.outbound,
      messageInbound: nextSocial.messages.inbound,
      deltas: null,
    },
    visible: {
      categories: nextBreakdown.byCategory,
      devices: nextBreakdown.byDevice,
      browsers: nextBreakdown.byBrowser,
      services: nextSocial.services,
      surfaces: nextSocial.surfaces,
      topTargets: nextBreakdown.items.map((item) => ({
        key: `${item.source}:${item.identifier}`,
        label: item.displayName,
        totalSeconds: item.totalSeconds,
        source: item.source,
        identifier: item.identifier,
      })),
      sessionBuckets: nextSocial.sessions.map((item) => ({
        key: `${item.source}:${item.identifier}`,
        label: item.serviceLabel ?? item.displayName,
        totalSeconds: item.totalSeconds,
        source: item.source,
        identifier: item.identifier,
      })),
      channels: nextSocial.messages.channels,
      setupSources: nextSocial.dataSources.filter(
        (source) => source.state !== "live",
      ),
      hasMessageActivity:
        nextSocial.messages.opened > 0 ||
        nextSocial.messages.outbound > 0 ||
        nextSocial.messages.inbound > 0,
      hasUsage,
    },
    fetchedAt: "2026-04-25T12:00:00.000Z",
  };
}

beforeEach(() => {
  clientMock.getLifeOpsScreenTimeHistory.mockResolvedValue(historyResponse());
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
  it("loads screen-time history for the selected range", async () => {
    render(<LifeOpsScreenTimeSection />);

    expect(screen.getByTestId("lifeops-screen-time-section")).toBeTruthy();
    await waitFor(() =>
      expect(clientMock.getLifeOpsScreenTimeHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          range: "today",
          topN: 16,
          socialTopN: 12,
        }),
      ),
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

  it("keeps website block status visible when app-blocker status is unavailable", async () => {
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
      websites: ["x.com"],
    });
    clientMock.getAppBlockerStatus.mockRejectedValue(
      new Error("App blocker is mobile-only."),
    );

    render(<LifeOpsScreenTimeSection />);

    expect(await screen.findByText("Websites blocked")).toBeTruthy();
    expect(screen.getByText("Websites: x.com")).toBeTruthy();
    expect(
      screen.getByText("Block status unavailable: App blocker is mobile-only."),
    ).toBeTruthy();
  });

  it("links incomplete tracking setup from the empty Screen Time state", async () => {
    const emptyBreakdown = {
      ...breakdown,
      byBrowser: [],
      byCategory: [],
      byDevice: [],
      bySource: [],
      items: [],
      totalSeconds: 0,
    };
    const emptySocial = {
      ...social,
      dataSources: [
        {
          id: "browser_bridge",
          label: "Browser",
          state: "partial",
          statusLabel: "Needs attention",
          detail: "Browser tracking needs attention.",
        },
        {
          id: "android_usage_stats",
          label: "Android apps",
          state: "unwired",
          statusLabel: "Not connected",
          detail: "No Android Usage Stats signal has been received.",
        },
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
    };
    clientMock.getLifeOpsScreenTimeHistory.mockResolvedValue(
      historyResponse({
        nextBreakdown: emptyBreakdown,
        nextSocial: emptySocial,
        hasUsage: false,
      }),
    );
    const onNavigate = vi.fn();

    render(<LifeOpsScreenTimeSection onNavigate={onNavigate} />);

    expect(await screen.findByText("Tracking setup incomplete")).toBeTruthy();
    expect(screen.getByText("Check Browser and Android apps.")).toBeTruthy();
    screen.getAllByRole("button", { name: "Open LifeOps setup" })[0].click();
    expect(onNavigate).toHaveBeenCalledWith("setup");
  });
});
