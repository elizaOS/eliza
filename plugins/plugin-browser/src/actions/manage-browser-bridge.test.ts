/**
 * MANAGE_BROWSER_BRIDGE action tests for complete companion status reporting.
 */

import { describe, expect, it, vi } from "vitest";
import type { BrowserBridgeCompanionStatus } from "../contracts.js";
import { BROWSER_BRIDGE_ROUTE_SERVICE_TYPE } from "../service.js";
import { manageBrowserBridgeAction } from "./manage-browser-bridge.js";

function companion(index: number): BrowserBridgeCompanionStatus {
  const timestamp = "2026-08-22T00:00:00.000Z";
  return {
    id: `companion-${index}`,
    agentId: "agent-1",
    browser: "chrome",
    profileId: `profile-${index}`,
    profileLabel: `Profile ${index}`,
    label: `Companion ${index}`,
    extensionVersion: "1.0.0",
    connectionState: "connected",
    permissions: {
      tabs: true,
      scripting: true,
      activeTab: true,
      allOrigins: true,
      grantedOrigins: [],
      incognitoEnabled: false,
    },
    lastSeenAt: timestamp,
    pairedAt: timestamp,
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("MANAGE_BROWSER_BRIDGE action", () => {
  it("returns every paired companion and reports the exact count", async () => {
    const companions = Array.from({ length: 30 }, (_, index) =>
      companion(index),
    );
    const service = {
      getBrowserSettings: vi.fn(async () => ({
        trackingMode: "active_tabs",
        allowBrowserControl: true,
      })),
      listBrowserCompanions: vi.fn(async () => companions),
    };
    const runtime = {
      getService: vi.fn((type: string) =>
        type === BROWSER_BRIDGE_ROUTE_SERVICE_TYPE ? service : null,
      ),
    };

    const result = await manageBrowserBridgeAction.handler?.(
      runtime as never,
      { content: { text: "refresh" } } as never,
      undefined,
      { parameters: { action: "refresh" } } as never,
    );

    expect(result).toMatchObject({
      success: true,
      text: expect.stringContaining("Companions: 30 paired."),
      values: { companionCount: 30 },
      data: { companions },
    });
  });
});
