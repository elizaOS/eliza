// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgeSettings,
} from "../contracts/index.js";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getBrowserBridgeSettings: vi.fn(),
    listBrowserBridgeCompanions: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core", () => ({
  client: clientMock,
}));

import { BrowserBridgeStatusChip } from "./BrowserBridgeStatusChip.js";

function buildSettings(
  overrides: Partial<BrowserBridgeSettings> = {},
): BrowserBridgeSettings {
  return {
    allowBrowserControl: true,
    blockedOrigins: [],
    enabled: true,
    grantedOrigins: [],
    incognitoEnabled: false,
    maxRememberedTabs: 10,
    metadata: {},
    pauseUntil: null,
    requireConfirmationForAccountAffecting: true,
    siteAccessMode: "all_sites",
    trackingMode: "current_tab",
    updatedAt: "2026-04-23T12:00:00.000Z",
    ...overrides,
  };
}

function buildCompanion(
  overrides: Partial<BrowserBridgeCompanionStatus> = {},
): BrowserBridgeCompanionStatus {
  return {
    agentId: "agent-1",
    browser: "chrome",
    connectionState: "connected",
    createdAt: "2026-04-23T12:00:00.000Z",
    extensionVersion: "1.0.0",
    id: "companion-1",
    label: "Chrome Default",
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    metadata: {},
    pairedAt: "2026-04-23T12:00:00.000Z",
    permissions: {
      activeTab: true,
      allOrigins: true,
      grantedOrigins: [],
      incognitoEnabled: false,
      scripting: true,
      tabs: true,
    },
    profileId: "default",
    profileLabel: "Default",
    updatedAt: "2026-04-23T12:00:00.000Z",
    ...overrides,
  };
}

async function renderChip() {
  const onNavigate = vi.fn();
  render(<BrowserBridgeStatusChip onNavigate={onNavigate} />);
  const chip = await screen.findByTestId("lifeops-overview-browser-chip");
  await waitFor(() => expect(chip.getAttribute("data-loaded")).toBe("1"));
  return { chip, onNavigate };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/lifeops#lifeops.section=overview");
  clientMock.getBrowserBridgeSettings.mockResolvedValue({
    settings: buildSettings(),
  });
  clientMock.listBrowserBridgeCompanions.mockResolvedValue({
    companions: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BrowserBridgeStatusChip", () => {
  it("reports setup needed when no companion is paired", async () => {
    const { chip } = await renderChip();

    expect(chip.getAttribute("data-state")).toBe("no_companion");
    expect(chip.getAttribute("aria-label")).toBe("Browser setup needed");
  });

  it("reports stale when the only connected companion is old", async () => {
    clientMock.listBrowserBridgeCompanions.mockResolvedValue({
      companions: [
        buildCompanion({
          lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
      ],
    });

    const { chip } = await renderChip();

    expect(chip.getAttribute("data-state")).toBe("stale");
    expect(chip.getAttribute("aria-label")).toBe("Browser offline");
  });

  it("reports ready for a connected recent companion with usable permissions", async () => {
    clientMock.listBrowserBridgeCompanions.mockResolvedValue({
      companions: [buildCompanion()],
    });

    const { chip } = await renderChip();

    expect(chip.getAttribute("data-state")).toBe("ready");
    expect(chip.getAttribute("aria-label")).toBe("Browser ready");
  });

  it("reports disabled settings before companion state", async () => {
    clientMock.getBrowserBridgeSettings.mockResolvedValue({
      settings: buildSettings({ enabled: false }),
    });
    clientMock.listBrowserBridgeCompanions.mockResolvedValue({
      companions: [buildCompanion()],
    });

    const { chip } = await renderChip();

    expect(chip.getAttribute("data-state")).toBe("disabled");
    expect(chip.getAttribute("aria-label")).toBe("Browser tracking off");
  });

  it("reports browser control disabled from settings", async () => {
    clientMock.getBrowserBridgeSettings.mockResolvedValue({
      settings: buildSettings({ allowBrowserControl: false }),
    });
    clientMock.listBrowserBridgeCompanions.mockResolvedValue({
      companions: [buildCompanion()],
    });

    const { chip } = await renderChip();

    expect(chip.getAttribute("data-state")).toBe("control_disabled");
    expect(chip.getAttribute("aria-label")).toBe("Browser control off");
  });

  it("reports paused settings before companion state", async () => {
    clientMock.getBrowserBridgeSettings.mockResolvedValue({
      settings: buildSettings({
        pauseUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
    });
    clientMock.listBrowserBridgeCompanions.mockResolvedValue({
      companions: [buildCompanion()],
    });

    const { chip } = await renderChip();

    expect(chip.getAttribute("data-state")).toBe("paused");
    expect(chip.getAttribute("aria-label")).toBe("Browser paused");
  });

  it("reports permission issues when site access is incomplete", async () => {
    clientMock.listBrowserBridgeCompanions.mockResolvedValue({
      companions: [
        buildCompanion({
          permissions: {
            activeTab: true,
            allOrigins: false,
            grantedOrigins: [],
            incognitoEnabled: false,
            scripting: true,
            tabs: true,
          },
        }),
      ],
    });

    const { chip } = await renderChip();

    expect(chip.getAttribute("data-state")).toBe("permission_blocked");
    expect(chip.getAttribute("aria-label")).toBe("Browser permissions needed");
  });

  it("surfaces browser status API failures", async () => {
    clientMock.getBrowserBridgeSettings.mockRejectedValue(new Error("offline"));

    const { chip } = await renderChip();

    expect(chip.getAttribute("data-state")).toBe("error");
    expect(chip.getAttribute("aria-label")).toBe("Browser status unavailable");
  });

  it("navigates to the setup hash instead of the old browser-bridge anchor", async () => {
    const { chip, onNavigate } = await renderChip();

    fireEvent.click(chip);

    expect(onNavigate).toHaveBeenCalledWith("setup");
    expect(window.location.hash).toBe("#lifeops.section=setup");
  });
});
