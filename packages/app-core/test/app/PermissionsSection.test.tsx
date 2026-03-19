/**
 * Tests for PermissionsSection — platform-aware rendering.
 *
 * Validates that the settings-page PermissionsSection renders the correct
 * view for each platform: desktop app (desktop permissions), web (info message),
 * and Capacitor/mobile (streaming permissions).
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
  mockIsShellEnabled,
  mockRefreshPermissions,
  mockRequestPermission,
  mockOpenPermissionSettings,
  mockSetShellEnabled,
  mockInvokeDesktopBridgeRequest,
  mockSubscribeDesktopBridgeEvent,
  permissionBridgeListener,
} = vi.hoisted(() => ({
  mockGetPermissions: vi.fn(),
  mockIsShellEnabled: vi.fn(),
  mockRefreshPermissions: vi.fn(),
  mockRequestPermission: vi.fn(),
  mockOpenPermissionSettings: vi.fn(),
  mockSetShellEnabled: vi.fn(),
  mockInvokeDesktopBridgeRequest: vi.fn(),
  mockSubscribeDesktopBridgeEvent: vi.fn(),
  permissionBridgeListener: {
    current: null as ((payload: unknown) => void) | null,
  },
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
    isShellEnabled: mockIsShellEnabled,
    refreshPermissions: mockRefreshPermissions,
    requestPermission: mockRequestPermission,
    openPermissionSettings: mockOpenPermissionSettings,
    setShellEnabled: mockSetShellEnabled,
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

import { PermissionsSection } from "@elizaos/app-core/components/PermissionsSection";

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

describe("PermissionsSection", () => {
  const defaultPermissions = {
    accessibility: {
      id: "accessibility",
      status: "granted",
      canRequest: false,
    },
    "screen-recording": {
      id: "screen-recording",
      status: "granted",
      canRequest: false,
    },
    microphone: {
      id: "microphone",
      status: "not-determined",
      canRequest: true,
    },
    camera: { id: "camera", status: "granted", canRequest: false },
    shell: { id: "shell", status: "granted", canRequest: false },
  };

  beforeEach(() => {
    ensureNavigatorPermissionMocks();
    mockUseApp.mockReset();
    mockIsWeb.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(true);
    mockIsNative.value = false;
    mockGetPermissions.mockReset();
    mockIsShellEnabled.mockReset();
    mockRefreshPermissions.mockReset();
    mockRequestPermission.mockReset();
    mockOpenPermissionSettings.mockReset();
    mockSetShellEnabled.mockReset();
    mockInvokeDesktopBridgeRequest.mockReset();
    mockSubscribeDesktopBridgeEvent.mockReset();
    permissionBridgeListener.current = null;
    mockGetPermissions.mockResolvedValue(defaultPermissions);
    mockIsShellEnabled.mockResolvedValue(true);
    mockInvokeDesktopBridgeRequest.mockImplementation(
      async (options: { rpcMethod: string }) => {
        if (options.rpcMethod === "permissionsGetAll") {
          return defaultPermissions;
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
    mockSubscribeDesktopBridgeEvent.mockImplementation(
      (options: { listener: (payload: unknown) => void }) => {
        permissionBridgeListener.current = options.listener;
        return () => {
          if (permissionBridgeListener.current === options.listener) {
            permissionBridgeListener.current = null;
          }
        };
      },
    );
    vi.mocked(navigator.permissions.query).mockReset();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReset();
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockReset();
  });

  it("renders web informational message when isWebPlatform() is true", async () => {
    mockIsWeb.mockReturnValue(true);
    mockIsDesktop.mockReturnValue(false);
    mockUseApp.mockReturnValue(baseContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(PermissionsSection));
    });

    const root = tree?.root;
    const webInfo = root.findByProps({ "data-testid": "web-permissions-info" });
    expect(webInfo).toBeDefined();
    const text = collectText(root);
    expect(text).toContain("Browser Permissions");
    expect(text).toContain("Camera");
    expect(text).toContain("Microphone");
  });

  it(
    "renders mobile streaming permissions when isNative and not running in the desktop app",
    async () => {
      mockIsWeb.mockReturnValue(false);
      mockIsDesktop.mockReturnValue(false);
      mockIsNative.value = true;
      mockUseApp.mockReturnValue(baseContext());

      let tree: TestRenderer.ReactTestRenderer | undefined;
      await act(async () => {
        tree = TestRenderer.create(React.createElement(PermissionsSection));
      });

      const root = tree?.root;
      const mobileView = root.findByProps({
        "data-testid": "mobile-permissions",
      });
      expect(mobileView).toBeDefined();
      const text = collectText(root);
      expect(text).toContain("Streaming Permissions");
      expect(text).toContain("Camera");
      expect(text).toContain("Microphone");
    });

  it("renders desktop permission rows in the desktop app", async () => {
    mockIsWeb.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(true);
    mockIsNative.value = false;
    mockUseApp.mockReturnValue(baseContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(PermissionsSection));
    });

    const root = tree?.root;
    const text = collectText(root);
    // Should show system permissions section with permission rows
    expect(text).toContain("System Permissions");
    expect(text).toContain("appsview.Capabilities");
  });

  it("uses the Electrobun bridge for permission requests", async () => {
    mockUseApp.mockReturnValue(baseContext());
    mockInvokeDesktopBridgeRequest.mockImplementation(
      async (options: { rpcMethod: string; params?: { id?: string } }) => {
        if (options.rpcMethod === "permissionsGetAll") {
          return defaultPermissions;
        }
        if (options.rpcMethod === "permissionsIsShellEnabled") {
          return true;
        }
        if (options.rpcMethod === "permissionsRequest") {
          return {
            id: options.params?.id ?? "microphone",
            status: "granted",
            canRequest: false,
            lastChecked: Date.now(),
          };
        }
        return null;
      },
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(PermissionsSection));
    });

    const requestButton = tree?.root.findByProps({ children: "Grant" });
    expect(requestButton).toBeDefined();

    await act(async () => {
      requestButton?.props.onClick();
    });

    expect(mockInvokeDesktopBridgeRequest).toHaveBeenCalledWith({
      rpcMethod: "permissionsRequest",
      ipcChannel: "permissions:request",
      params: { id: "microphone" },
    });
    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it("uses fallback Open Settings copy instead of raw translation keys", async () => {
    mockUseApp.mockReturnValue(baseContext());
    mockInvokeDesktopBridgeRequest.mockImplementation(
      async (options: { rpcMethod: string }) => {
        if (options.rpcMethod === "permissionsGetAll") {
          return {
            ...defaultPermissions,
            camera: {
              id: "camera",
              status: "denied",
              canRequest: false,
            },
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

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(PermissionsSection));
    });

    const text = collectText(tree?.root);
    expect(text).toContain("Open Settings");
    expect(text).not.toContain("permissionssection.OpenSettings");
  });

  it("reconciles camera status from renderer permissions when already granted", async () => {
    mockUseApp.mockReturnValue(baseContext());
    mockInvokeDesktopBridgeRequest.mockImplementation(
      async (options: { rpcMethod: string }) => {
        if (options.rpcMethod === "permissionsGetAll") {
          return {
            ...defaultPermissions,
            camera: {
              id: "camera",
              status: "not-determined",
              canRequest: true,
            },
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
          state:
            name === "camera"
              ? "granted"
              : name === "microphone"
                ? "prompt"
                : "prompt",
        }) as PermissionStatus,
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(PermissionsSection));
    });

    const root = tree?.root;
    expect(root).toBeDefined();
    if (!root) {
      throw new Error("PermissionsSection root not rendered");
    }

    expect(findButtonsByAriaLabel(root, "Check Access Camera")).toHaveLength(0);
    expect(collectText(root)).toContain("Granted");
  });

  it("requests renderer camera access before native settings fallback", async () => {
    mockUseApp.mockReturnValue(baseContext());
    mockInvokeDesktopBridgeRequest.mockImplementation(
      async (options: { rpcMethod: string }) => {
        if (options.rpcMethod === "permissionsGetAll") {
          return {
            ...defaultPermissions,
            camera: {
              id: "camera",
              status: "not-determined",
              canRequest: true,
            },
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
          state:
            name === "camera"
              ? "prompt"
              : name === "microphone"
                ? "prompt"
                : "prompt",
        }) as PermissionStatus,
    );
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream);
    let enumerateDevicesCallCount = 0;
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockImplementation(
      async () => {
        enumerateDevicesCallCount += 1;
        if (enumerateDevicesCallCount < 3) {
          return [];
        }

        return [
          {
            deviceId: "camera-1",
            groupId: "group-1",
            kind: "videoinput",
            label: "FaceTime HD Camera",
            toJSON: () => ({}),
          } as MediaDeviceInfo,
        ];
      },
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(PermissionsSection));
    });

    const root = tree?.root;
    expect(root).toBeDefined();
    if (!root) {
      throw new Error("PermissionsSection root not rendered");
    }

    const requestButton = findButtonsByAriaLabel(
      root,
      "Check Access Camera",
    )[0];
    expect(requestButton).toBeDefined();

    mockInvokeDesktopBridgeRequest.mockClear();

    await act(async () => {
      requestButton.props.onClick();
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      video: true,
    });
    expect(mockInvokeDesktopBridgeRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "permissionsRequest",
        params: { id: "camera" },
      }),
    );
  });

  it("uses the Electrobun bridge for permission refresh", async () => {
    mockUseApp.mockReturnValue(baseContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(PermissionsSection));
    });

    mockInvokeDesktopBridgeRequest.mockClear();

    const refreshButton = tree?.root.findByProps({ children: "Refresh" });
    expect(refreshButton).toBeDefined();

    await act(async () => {
      refreshButton?.props.onClick();
    });

    expect(mockInvokeDesktopBridgeRequest).toHaveBeenCalledWith({
      rpcMethod: "permissionsGetAll",
      ipcChannel: "permissions:getAll",
      params: { forceRefresh: true },
    });
    expect(mockRefreshPermissions).not.toHaveBeenCalled();
  });

  it("refreshes from the bridge when permissionsChanged fires", async () => {
    mockUseApp.mockReturnValue(baseContext());

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(PermissionsSection));
    });

    expect(tree).toBeDefined();
    mockInvokeDesktopBridgeRequest.mockClear();

    await act(async () => {
      permissionBridgeListener.current?.({ id: "microphone" });
    });

    expect(mockInvokeDesktopBridgeRequest).toHaveBeenCalledWith({
      rpcMethod: "permissionsGetAll",
      ipcChannel: "permissions:getAll",
      params: { forceRefresh: true },
    });
  });
});
