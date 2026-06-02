import { describe, expect, it } from "vitest";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgeSettings,
} from "./contracts.js";
import {
  browserBridgeCompanionIsRecent,
  browserBridgePermissionsReady,
  isBrowserBridgePaused,
  resolveBrowserBridgeReadiness,
} from "./bridge-readiness.js";

const nowMs = Date.parse("2026-06-02T12:00:00.000Z");

const settings: BrowserBridgeSettings = {
  enabled: true,
  allowBrowserControl: true,
  trackingMode: "page_context",
  siteAccessMode: "all_sites",
  grantedOrigins: [],
  pauseUntil: null,
  updatedAt: "2026-06-02T00:00:00.000Z",
};

function companion(
  overrides: Partial<BrowserBridgeCompanionStatus> = {},
): BrowserBridgeCompanionStatus {
  return {
    id: "companion-1",
    browser: "chrome",
    label: "Chrome",
    connectionState: "connected",
    lastSeenAt: "2026-06-02T11:59:00.000Z",
    permissions: {
      tabs: true,
      scripting: true,
      activeTab: true,
      allOrigins: true,
      grantedOrigins: [],
    },
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T11:59:00.000Z",
    ...overrides,
  };
}

describe("browser bridge readiness", () => {
  it("detects pause and recent companion windows", () => {
    expect(
      isBrowserBridgePaused(
        { pauseUntil: "2026-06-02T12:01:00.000Z" },
        nowMs,
      ),
    ).toBe(true);
    expect(
      browserBridgeCompanionIsRecent(
        { lastSeenAt: "2026-06-02T11:56:00.000Z" },
        nowMs,
      ),
    ).toBe(true);
    expect(
      browserBridgeCompanionIsRecent(
        { lastSeenAt: "2026-06-02T11:54:59.000Z" },
        nowMs,
      ),
    ).toBe(false);
  });

  it("checks required permissions and site access", () => {
    expect(browserBridgePermissionsReady(settings, companion().permissions)).toBe(
      true,
    );
    expect(
      browserBridgePermissionsReady(
        { ...settings, siteAccessMode: "current_site_only" },
        { ...companion().permissions, activeTab: false },
      ),
    ).toBe(false);
    expect(
      browserBridgePermissionsReady(
        {
          ...settings,
          siteAccessMode: "granted_sites",
          grantedOrigins: ["https://example.com"],
        },
        {
          ...companion().permissions,
          allOrigins: false,
          grantedOrigins: ["https://example.com"],
        },
      ),
    ).toBe(true);
  });

  it("resolves readiness states from settings and companions", () => {
    expect(resolveBrowserBridgeReadiness(settings, [companion()], nowMs))
      .toMatchObject({
        ready: true,
        state: "ready",
        recentConnectedCompanions: [expect.objectContaining({ id: "companion-1" })],
      });

    expect(
      resolveBrowserBridgeReadiness(
        { ...settings, allowBrowserControl: false },
        [companion()],
        nowMs,
      ).state,
    ).toBe("control_disabled");

    expect(resolveBrowserBridgeReadiness(settings, [], nowMs).state).toBe(
      "no_companion",
    );

    expect(
      resolveBrowserBridgeReadiness(
        settings,
        [companion({ lastSeenAt: "2026-06-02T11:00:00.000Z" })],
        nowMs,
      ).state,
    ).toBe("stale");

    expect(
      resolveBrowserBridgeReadiness(
        settings,
        [
          companion({
            permissions: { ...companion().permissions, scripting: false },
          }),
        ],
        nowMs,
      ).state,
    ).toBe("permission_blocked");
  });
});
