/**
 * Tests for PermissionsOnboardingSection — platform-aware onboarding.
 *
 * Validates that the onboarding senses step renders correctly on
 * Electron (desktop), Web (auto-continue), and Capacitor/mobile (streaming).
 */
// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockUseApp, mockIsWeb, mockIsElectron, mockIsNative } = vi.hoisted(
  () => ({
    mockUseApp: vi.fn(),
    mockIsWeb: vi.fn(() => false),
    mockIsElectron: vi.fn(() => true),
    mockIsNative: { value: false },
  }),
);

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("@elizaos/app-core/platform", () => ({
  hasRequiredOnboardingPermissions: vi.fn(() => true),
  isWebPlatform: () => mockIsWeb(),
  isElectronPlatform: () => mockIsElectron(),
  get isNative() {
    return mockIsNative.value;
  },
  isIOS: false,
  isAndroid: false,
  platform: "web",
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getPermissions: vi.fn().mockResolvedValue({
      accessibility: { status: "granted", canRequest: false },
      "screen-recording": { status: "granted", canRequest: false },
      microphone: { status: "granted", canRequest: false },
      camera: { status: "granted", canRequest: false },
      shell: { status: "granted", canRequest: false },
    }),
    isShellEnabled: vi.fn().mockResolvedValue(true),
    refreshPermissions: vi.fn(),
    requestPermission: vi.fn(),
    openPermissionSettings: vi.fn(),
    setShellEnabled: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core/bridge", () => ({
  invokeDesktopBridgeRequest: vi.fn(),
}));

vi.mock("@elizaos/app-core/components/ui-badges", () => ({
  StatusBadge: ({ label }: { label: string }) =>
    React.createElement("span", { "data-testid": "status-badge" }, label),
}));

vi.mock("@elizaos/app-core/components/ui-switch", () => ({
  Switch: () => React.createElement("span", null, "switch"),
}));

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) =>
    React.createElement(
      "button",
      { type: "button", onClick, ...rest },
      children,
    ),
}));

vi.mock("lucide-react", () => ({
  Camera: () => React.createElement("span", null, "📷"),
  Check: () => React.createElement("span", null, "✓"),
  CircleUserRound: () => React.createElement("span", null, "👤"),
  Cloud: () => React.createElement("span", null, "☁"),
  Mic: () => React.createElement("span", null, "🎤"),
  Monitor: () => React.createElement("span", null, "🖥"),
  MousePointer2: () => React.createElement("span", null, "🖱"),
  Settings: () => React.createElement("span", null, "⚙"),
  Smartphone: () => React.createElement("span", null, "📱"),
  Terminal: () => React.createElement("span", null, "💻"),
}));

import { PermissionsOnboardingSection } from "@elizaos/app-core/components/PermissionsSection";

// ── Helpers ───────────────────────────────────────────────────────────

function baseContext(overrides?: Record<string, unknown>) {
  return {
    t: (k: string) => k,
    plugins: [],
    handlePluginToggle: vi.fn(),
    ...overrides,
  };
}

function collectText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : collectText(child)))
    .join(" ");
}

function findButtons(
  root: TestRenderer.ReactTestInstance,
): TestRenderer.ReactTestInstance[] {
  return root.findAllByType("button");
}

// ====================================================================

describe("PermissionsOnboardingSection", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    mockIsWeb.mockReturnValue(false);
    mockIsElectron.mockReturnValue(true);
    mockIsNative.value = false;
  });

  it("renders web auto-continue view when isWebPlatform() is true", async () => {
    mockIsWeb.mockReturnValue(true);
    mockIsElectron.mockReturnValue(false);
    const onContinue = vi.fn();
    mockUseApp.mockReturnValue(baseContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(PermissionsOnboardingSection, { onContinue }),
      );
    });

    const root = tree?.root;
    const webView = root.findByProps({
      "data-testid": "web-onboarding-permissions",
    });
    expect(webView).toBeDefined();
    const text = collectText(root);
    expect(text).toContain("permissionssection.BrowserPermissions");
    expect(text).toContain("Camera");
    expect(text).toContain("Microphone");

    // Should have a skip button
    const buttons = findButtons(root);
    const skipBtn = buttons.find((b) =>
      collectText(b).includes("permissionssection.SkipForNow"),
    );
    expect(skipBtn).toBeDefined();
    await act(async () => {
      skipBtn?.props.onClick();
    });
    expect(onContinue).toHaveBeenCalledWith({ allowPermissionBypass: true });
  });

  it("renders mobile streaming permissions when isNative and not Electron", async () => {
    mockIsWeb.mockReturnValue(false);
    mockIsElectron.mockReturnValue(false);
    mockIsNative.value = true;
    const onContinue = vi.fn();
    mockUseApp.mockReturnValue(baseContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(PermissionsOnboardingSection, { onContinue }),
      );
    });

    const root = tree?.root;
    const mobileView = root.findByProps({
      "data-testid": "mobile-onboarding-permissions",
    });
    expect(mobileView).toBeDefined();
    const text = collectText(root);
    expect(text).toContain("permissionssection.StreamingPermissions");
    expect(text).toContain("Camera");
    expect(text).toContain("Microphone");

    // Should have a skip button
    expect(text).toContain("permissionssection.SkipForNow");
  });

  it("renders desktop permissions on Electron", async () => {
    mockIsWeb.mockReturnValue(false);
    mockIsElectron.mockReturnValue(true);
    mockIsNative.value = false;
    const onContinue = vi.fn();
    mockUseApp.mockReturnValue(baseContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(PermissionsOnboardingSection, { onContinue }),
      );
    });

    const root = tree?.root;
    const text = collectText(root);
    // Should show system permissions title and grant UI
    expect(text).toContain("permissionssection.SystemPermissions");
    expect(text).toContain("permissionssection.Continue");
  });
});
