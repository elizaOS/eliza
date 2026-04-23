// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  clientMock,
  navigatePreOpenedWindowMock,
  preOpenWindowMock,
  setActionNoticeMock,
  setTabMock,
} = vi.hoisted(() => ({
  clientMock: {
    buildBrowserBridgeCompanionPackage: vi.fn(),
    createBrowserBridgeCompanionPairing: vi.fn(),
    downloadBrowserBridgeCompanionPackage: vi.fn(),
    getBrowserBridgePackageStatus: vi.fn(),
    getBrowserBridgeSettings: vi.fn(),
    listBrowserBridgeCompanions: vi.fn(),
    openBrowserBridgeCompanionManager: vi.fn(),
    openBrowserBridgeCompanionPackagePath: vi.fn(),
    openBrowserWorkspaceTab: vi.fn(),
    updateBrowserBridgeSettings: vi.fn(),
  },
  navigatePreOpenedWindowMock: vi.fn(),
  preOpenWindowMock: vi.fn(),
  setActionNoticeMock: vi.fn(),
  setTabMock: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => {
  const React = require("react") as typeof import("react");

  function Button({
    children,
    disabled,
    onClick,
    type = "button",
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    type?: "button" | "submit" | "reset";
  }) {
    return React.createElement(
      "button",
      { disabled, onClick, type },
      children,
    );
  }

  function Badge({ children }: { children?: ReactNode }) {
    return React.createElement("span", null, children);
  }

  function Switch({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) {
    return React.createElement("input", {
      checked,
      onChange: (event: Event) =>
        onCheckedChange?.((event.target as HTMLInputElement).checked),
      type: "checkbox",
    });
  }

  function SegmentedControl<T extends string>({
    items,
    onValueChange,
    value,
  }: {
    items: Array<{ label: ReactNode; value: T }>;
    onValueChange: (value: T) => void;
    value: T;
  }) {
    return React.createElement(
      "div",
      null,
      items.map((item) =>
        React.createElement(
          "button",
          {
            key: item.value,
            onClick: () => onValueChange(item.value),
            type: "button",
          },
          item.label,
          item.value === value ? " (selected)" : "",
        ),
      ),
    );
  }

  return {
    Badge,
    Button,
    client: clientMock,
    copyTextToClipboard: vi.fn(),
    Input: "input",
    invokeDesktopBridgeRequest: vi.fn(),
    isElectrobunRuntime: () => false,
    Label: "label",
    navigatePreOpenedWindow: navigatePreOpenedWindowMock,
    openExternalUrl: vi.fn(),
    preOpenWindow: preOpenWindowMock,
    SegmentedControl,
    Switch,
    Textarea: "textarea",
    useApp: () => ({
      setActionNotice: setActionNoticeMock,
      setTab: setTabMock,
    }),
  };
});

import { BrowserBridgeSetupPanel } from "./BrowserBridgeSetupPanel";

const originalUserAgent = window.navigator.userAgent;
const originalVendor = window.navigator.vendor;

function setNavigatorValues(values: { userAgent: string; vendor: string }) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: values.userAgent,
  });
  Object.defineProperty(window.navigator, "vendor", {
    configurable: true,
    value: values.vendor,
  });
}

beforeEach(() => {
  setNavigatorValues({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    vendor: "Google Inc.",
  });
  clientMock.getBrowserBridgeSettings.mockResolvedValue({
    settings: {
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
      updatedAt: "2026-04-23T16:20:00.000Z",
    },
  });
  clientMock.listBrowserBridgeCompanions.mockResolvedValue({
    companions: [],
  });
  clientMock.getBrowserBridgePackageStatus.mockResolvedValue({
    status: {
      chromeBuildPath: null,
      chromePackagePath: null,
      extensionPath: "/tmp/browser-bridge",
      releaseManifest: {
        chrome: {
          asset: {
            downloadUrl:
              "https://example.test/browser-bridge-chrome-v9.9.9.zip",
            fileName: "browser-bridge-chrome-v9.9.9.zip",
          },
          installKind: "github_release",
          installUrl: "https://example.test/chrome-release",
          storeListingUrl: null,
        },
        chromeVersion: "9.9.9.60000",
        chromeVersionName: "9.9.9",
        generatedAt: "2026-04-23T16:20:00.000Z",
        releasePageUrl: "https://example.test/release-page",
        releaseTag: "v9.9.9",
        releaseVersion: "9.9.9",
        repository: "example/test",
        safari: {
          asset: {
            downloadUrl:
              "https://example.test/browser-bridge-safari-v9.9.9.zip",
            fileName: "browser-bridge-safari-v9.9.9.zip",
          },
          installKind: "github_release",
          installUrl: "https://example.test/safari-release",
          storeListingUrl: null,
        },
        safariBuildVersion: "909099000",
        safariMarketingVersion: "9.9.9",
        schema: "browser_bridge_release_v2",
        safariAppPath: null,
        safariPackagePath: null,
        safariWebExtensionPath: null,
      },
      safariAppPath: null,
      safariPackagePath: null,
      safariWebExtensionPath: null,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setNavigatorValues({
    userAgent: originalUserAgent,
    vendor: originalVendor,
  });
});

describe("BrowserBridgeSetupPanel", () => {
  it("treats a local browser-bridge workspace as the primary install path", async () => {
    render(<BrowserBridgeSetupPanel />);

    expect(await screen.findByText("Build & Install in Chrome")).toBeTruthy();
    expect(screen.queryByText("Install Chrome Extension")).toBeNull();
    expect(screen.getByText("This Browser")).toBeTruthy();
    expect(screen.getAllByText("Local build")).toHaveLength(2);
    expect(screen.getAllByText("Build on install")).toHaveLength(2);
    expect(screen.getAllByText("Manual Pairing")).toHaveLength(2);
    expect(
      screen.getByText(
        "Install builds the extension, opens chrome://extensions in this browser profile when possible, and reveals the folder for Load unpacked.",
      ),
    ).toBeTruthy();
  });
});
