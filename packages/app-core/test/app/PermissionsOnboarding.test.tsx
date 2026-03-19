/**
 * Tests for PermissionsOnboardingSection — platform-aware onboarding.
 *
 * Validates that the onboarding senses step renders correctly in the
 * desktop app, on the web (auto-continue), and on Capacitor/mobile (streaming).
 */
// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockUseApp, mockIsWeb, mockIsDesktop, mockIsNative } = vi.hoisted(
  () => ({
    mockUseApp: vi.fn(),
    mockIsWeb: vi.fn(() => false),
    mockIsDesktop: vi.fn(() => true),
    mockIsNative: { value: false },
  }),
);
const {
  mockGetPermissions,
  mockInvokeDesktopBridgeRequest,
  mockSubscribeDesktopBridgeEvent,
} = vi.hoisted(() => ({
  mockGetPermissions: vi.fn(),
  mockInvokeDesktopBridgeRequest: vi.fn(),
  mockSubscribeDesktopBridgeEvent: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("@elizaos/app-core/platform", () => ({
  hasRequiredOnboardingPermissions: vi.fn(() => true),
  isWebPlatform: () => mockIsWeb(),
  isDesktopPlatform: () => mockIsDesktop(),
  get isNative() {
    return mockIsNative.value;
  },
  isIOS: false,
  isAndroid: false,
  platform: "web",
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getPermissions: mockGetPermissions,
    isShellEnabled: vi.fn().mockResolvedValue(true),
    refreshPermissions: vi.fn(),
    requestPermission: vi.fn(),
    openPermissionSettings: vi.fn(),
    setShellEnabled: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core/bridge", () => ({
  invokeDesktopBridgeRequest: mockInvokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent: mockSubscribeDesktopBridgeEvent,
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

function findButtonsByAriaLabel(
  root: TestRenderer.ReactTestInstance,
  label: string,
): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    (node) => node.type === "button" && node.props["aria-label"] === label,
  );
}

function ensureNavigatorPermissionMocks(): void {
  if (!navigator.permissions) {
    Object.defineProperty(navigator, "permissions", {
      value: { query: vi.fn() },
      writable: true,
      configurable: true,
    });
  }

  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn(),
        enumerateDevices: vi.fn(),
      },
      writable: true,
      configurable: true,
    });
  }

  if (!navigator.mediaDevices.getUserMedia) {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
  }

  if (!navigator.mediaDevices.enumerateDevices) {
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
  }
}

// ====================================================================

describe("PermissionsOnboardingSection", () => {
  beforeEach(() => {
    ensureNavigatorPermissionMocks();
    mockUseApp.mockReset();
    mockIsWeb.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(true);
    mockIsNative.value = false;
    mockGetPermissions.mockReset();
    mockInvokeDesktopBridgeRequest.mockReset();
    mockSubscribeDesktopBridgeEvent.mockReset();
    mockGetPermissions.mockResolvedValue({
      accessibility: { status: "granted", canRequest: false },
      "screen-recording": { status: "granted", canRequest: false },
      microphone: { status: "granted", canRequest: false },
      camera: { status: "granted", canRequest: false },
      shell: { status: "granted", canRequest: false },
    });
    mockInvokeDesktopBridgeRequest.mockImplementation(
      async (options: { rpcMethod: string }) => {
        if (options.rpcMethod === "permissionsGetAll") {
          return {
            accessibility: { status: "granted", canRequest: false },
            "screen-recording": { status: "granted", canRequest: false },
            microphone: { status: "granted", canRequest: false },
            camera: { status: "granted", canRequest: false },
            shell: { status: "granted", canRequest: false },
          };
        }
        if (options.rpcMethod === "permissionsIsShellEnabled") {
          return true;
        }
        if (options.rpcMethod === "permissionsGetPlatform") {
          return "darwin";
        }
        return null;
      },
    );
    mockSubscribeDesktopBridgeEvent.mockImplementation(() => () => { });
    vi.mocked(navigator.permissions.query).mockReset();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReset();
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockReset();
  });

  it("renders web auto-continue view when isWebPlatform() is true", async () => {
    mockIsWeb.mockReturnValue(true);
    mockIsDesktop.mockReturnValue(false);
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
    expect(text).toContain("Browser Permissions");
    expect(text).toContain("Camera");
    expect(text).toContain("Microphone");

    // Should have a skip button
    const buttons = findButtons(root);
    const skipBtn = buttons.find((b) =>
      collectText(b).includes("Skip for Now"),
    );
    expect(skipBtn).toBeDefined();
    await act(async () => {
      skipBtn?.props.onClick();
    });
    expect(onContinue).toHaveBeenCalledWith({ allowPermissionBypass: true });
  });

  it(
    "renders mobile streaming permissions when isNative and not running in the desktop app",
    async () => {
      mockIsWeb.mockReturnValue(false);
      mockIsDesktop.mockReturnValue(false);
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
      expect(text).toContain("Streaming Permissions");
      expect(text).toContain("Camera");
      expect(text).toContain("Microphone");

      // Should have a skip button
      expect(text).toContain("Skip for Now");
    });

  it("renders desktop permissions in the desktop app", async () => {
    mockIsWeb.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(true);
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
    expect(text).toContain("System Permissions");
    expect(text).toContain("Continue");
    expect(mockInvokeDesktopBridgeRequest).toHaveBeenCalledWith({
      rpcMethod: "permissionsGetAll",
      ipcChannel: "permissions:getAll",
      params: undefined,
    });
    expect(mockGetPermissions).not.toHaveBeenCalled();
  });

  it("hides the camera grant button when renderer access is already granted", async () => {
    mockIsWeb.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(true);
    mockIsNative.value = false;
    const onContinue = vi.fn();
    mockUseApp.mockReturnValue(baseContext());
    mockInvokeDesktopBridgeRequest.mockImplementation(
      async (options: { rpcMethod: string }) => {
        if (options.rpcMethod === "permissionsGetAll") {
          return {
            accessibility: { status: "granted", canRequest: false },
            "screen-recording": { status: "granted", canRequest: false },
            microphone: { status: "granted", canRequest: false },
            camera: { status: "not-determined", canRequest: true },
            shell: { status: "granted", canRequest: false },
          };
        }
        if (options.rpcMethod === "permissionsIsShellEnabled") {
          return true;
        }
        if (options.rpcMethod === "permissionsGetPlatform") {
          return "darwin";
        }
        return null;
      },
    );
    vi.mocked(navigator.permissions.query).mockImplementation(
      async ({ name }: { name: PermissionName }) =>
        ({
          state: name === "camera" ? "granted" : "prompt",
        }) as PermissionStatus,
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(PermissionsOnboardingSection, { onContinue }),
      );
    });

    const root = tree?.root;
    expect(root).toBeDefined();
    if (!root) {
      throw new Error("PermissionsOnboardingSection root not rendered");
    }

    expect(findButtonsByAriaLabel(root, "Check Access Camera")).toHaveLength(0);
  });
});
