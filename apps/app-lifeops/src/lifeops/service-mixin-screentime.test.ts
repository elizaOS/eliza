import { describe, expect, it, vi } from "vitest";
import { withScreenTime } from "./service-mixin-screentime.js";

vi.mock("../activity-profile/activity-tracker-reporting.js", () => ({
  getActivityReportBetween: vi.fn(async () => ({ apps: [] })),
}));

vi.mock("../activity-profile/system-inactivity-apps.js", () => ({
  isSystemInactivityApp: vi.fn(() => false),
}));

const browserSettings = {
  enabled: true,
  trackingMode: "current_tab",
  allowBrowserControl: false,
  requireConfirmationForAccountAffecting: true,
  incognitoEnabled: false,
  siteAccessMode: "current_site_only",
  grantedOrigins: [],
  blockedOrigins: [],
  maxRememberedTabs: 10,
  pauseUntil: null,
  metadata: {},
  updatedAt: null,
};

function browserCompanion(now: string) {
  return {
    id: "browser-companion",
    agentId: "agent",
    browser: "chrome",
    profileId: "profile",
    profileLabel: "Default",
    label: "Chrome Default",
    extensionVersion: "1.0.0",
    connectionState: "connected",
    permissions: {
      tabs: true,
      scripting: true,
      activeTab: true,
      allOrigins: false,
      grantedOrigins: [],
      incognitoEnabled: false,
    },
    lastSeenAt: now,
    pairedAt: now,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function createService({
  companions = [],
  signals = [],
}: {
  companions?: unknown[];
  signals?: unknown[];
}) {
  class Base {
    runtime = {};
    repository = {
      listActivitySignals: vi.fn(async () => signals),
      listScreenTimeSessionsOverlapping: vi.fn(async () => []),
      listXDms: vi.fn(async () => []),
    };

    agentId() {
      return "agent";
    }

    async getBrowserSettings() {
      return browserSettings;
    }

    async listBrowserCompanions() {
      return companions;
    }
  }

  const Service = withScreenTime(Base as never) as unknown as new () => {
    getSocialHabitSummary(opts: {
      since: string;
      until: string;
      topN?: number;
    }): Promise<{
      sessions: unknown[];
      dataSources: Array<{ id: string; state: string }>;
    }>;
  };
  return new Service();
}

describe("LifeOps screen-time social data sources", () => {
  it("reports browser setup from companion readiness without usage rows", async () => {
    const service = createService({
      companions: [browserCompanion(new Date().toISOString())],
    });

    const social = await service.getSocialHabitSummary({
      since: "2025-03-01T00:00:00.000Z",
      until: "2025-03-01T01:00:00.000Z",
    });

    expect(social.sessions).toEqual([]);
    expect(social.dataSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "browser_bridge", state: "live" }),
      ]),
    );
  });

  it("reports Android setup from recent Usage Access permission state", async () => {
    const now = new Date().toISOString();
    const service = createService({
      signals: [
        {
          platform: "android",
          source: "mobile_device",
          state: "active",
          observedAt: now,
          metadata: {
            screenTime: {
              granted: true,
              topApps: [],
            },
          },
        },
      ],
    });

    const social = await service.getSocialHabitSummary({
      since: "2025-03-01T00:00:00.000Z",
      until: "2025-03-01T01:00:00.000Z",
    });

    expect(social.dataSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "android_usage_stats", state: "live" }),
      ]),
    );
  });
});
