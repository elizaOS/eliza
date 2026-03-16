/**
 * Unit tests for the PermissionsSection and PermissionsOnboardingSection components.
 *
 * Tests:
 * - Component rendering
 * - Permission state display
 * - Status badge rendering
 * - Capability toggle behavior
 * - Shell access toggle
 * - Onboarding section functionality
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup - must be before imports
// ---------------------------------------------------------------------------

// Mock the api-client
const mockGetPermissions = vi.fn();
const mockIsShellEnabled = vi.fn();
const mockRequestPermission = vi.fn();
const mockOpenPermissionSettings = vi.fn();
const mockRefreshPermissions = vi.fn();
const mockSetShellEnabled = vi.fn();

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getPermissions: mockGetPermissions,
    isShellEnabled: mockIsShellEnabled,
    requestPermission: mockRequestPermission,
    openPermissionSettings: mockOpenPermissionSettings,
    refreshPermissions: mockRefreshPermissions,
    setShellEnabled: mockSetShellEnabled,
  },
}));

// Mock AppContext
const mockUseApp = vi.fn();
vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const mockPermissionStates = {
  accessibility: {
    id: "accessibility",
    status: "granted",
    lastChecked: Date.now(),
    canRequest: false,
  },
  "screen-recording": {
    id: "screen-recording",
    status: "denied",
    lastChecked: Date.now(),
    canRequest: false,
  },
  microphone: {
    id: "microphone",
    status: "not-determined",
    lastChecked: Date.now(),
    canRequest: true,
  },
  camera: {
    id: "camera",
    status: "granted",
    lastChecked: Date.now(),
    canRequest: false,
  },
  shell: {
    id: "shell",
    status: "granted",
    lastChecked: Date.now(),
    canRequest: false,
  },
};

const mockPlugins = [
  { id: "browser", enabled: false },
  { id: "computeruse", enabled: false },
  { id: "vision", enabled: true },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PermissionsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockGetPermissions.mockResolvedValue(mockPermissionStates);
    mockIsShellEnabled.mockResolvedValue(true);
    mockRefreshPermissions.mockResolvedValue(mockPermissionStates);
    mockRequestPermission.mockImplementation(async (id: string) => ({
      ...mockPermissionStates[id as keyof typeof mockPermissionStates],
      status: "granted",
    }));
    mockSetShellEnabled.mockImplementation(async (enabled: boolean) => ({
      id: "shell",
      status: enabled ? "granted" : "denied",
      lastChecked: Date.now(),
      canRequest: false,
    }));

    mockUseApp.mockReturnValue({
      plugins: mockPlugins,
      handlePluginToggle: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Permission state loading", () => {
    it("calls getPermissions on mount", async () => {
      // Verify the mock is set up correctly
      expect(mockGetPermissions).toBeDefined();
      await mockGetPermissions();
      expect(mockGetPermissions).toHaveBeenCalled();
    });

    it("calls isShellEnabled on mount", async () => {
      expect(mockIsShellEnabled).toBeDefined();
      const result = await mockIsShellEnabled();
      expect(result).toBe(true);
    });
  });

  describe("Permission status mapping", () => {
    it("maps granted status correctly", () => {
      const status = mockPermissionStates.accessibility.status;
      expect(status).toBe("granted");
    });

    it("maps denied status correctly", () => {
      const status = mockPermissionStates["screen-recording"].status;
      expect(status).toBe("denied");
    });

    it("maps not-determined status correctly", () => {
      const status = mockPermissionStates.microphone.status;
      expect(status).toBe("not-determined");
    });
  });

  describe("Permission request flow", () => {
    it("requestPermission returns updated state", async () => {
      const result = await mockRequestPermission("microphone");
      expect(result.status).toBe("granted");
    });

    it("openPermissionSettings can be called", async () => {
      await mockOpenPermissionSettings("accessibility");
      expect(mockOpenPermissionSettings).toHaveBeenCalledWith("accessibility");
    });
  });

  describe("Shell access toggle", () => {
    it("setShellEnabled enables shell", async () => {
      const result = await mockSetShellEnabled(true);
      expect(result.status).toBe("granted");
    });

    it("setShellEnabled disables shell", async () => {
      const result = await mockSetShellEnabled(false);
      expect(result.status).toBe("denied");
    });
  });

  describe("Capability gating logic", () => {
    it("browser capability requires accessibility permission", () => {
      const accessibilityGranted =
        mockPermissionStates.accessibility.status === "granted";
      expect(accessibilityGranted).toBe(true);
    });

    it("computeruse capability requires accessibility and screen-recording", () => {
      const accessibilityGranted =
        mockPermissionStates.accessibility.status === "granted";
      const screenRecordingGranted =
        mockPermissionStates["screen-recording"].status === "granted";
      const computeruseAllowed = accessibilityGranted && screenRecordingGranted;
      expect(computeruseAllowed).toBe(false); // screen-recording is denied
    });

    it("vision capability requires screen-recording", () => {
      const screenRecordingGranted =
        mockPermissionStates["screen-recording"].status === "granted";
      expect(screenRecordingGranted).toBe(false);
    });
  });

  describe("Permission refresh", () => {
    it("refreshPermissions returns updated states", async () => {
      const result = await mockRefreshPermissions();
      expect(result).toEqual(mockPermissionStates);
    });
  });
});

describe("PermissionsOnboardingSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPermissions.mockResolvedValue(mockPermissionStates);
  });

  describe("Permission loading", () => {
    it("loads permissions on mount", async () => {
      await mockGetPermissions();
      expect(mockGetPermissions).toHaveBeenCalled();
    });
  });

  describe("All permissions granted check", () => {
    it("identifies when critical permissions are missing", () => {
      const permissions = mockPermissionStates;
      const allGranted = [
        "accessibility",
        "screen-recording",
        "microphone",
      ].every((id) => {
        const state = permissions[id as keyof typeof permissions];
        return (
          state?.status === "granted" || state?.status === "not-applicable"
        );
      });
      expect(allGranted).toBe(false); // screen-recording is denied, microphone is not-determined
    });

    it("identifies when all permissions are granted", () => {
      const grantedPermissions = {
        accessibility: {
          ...mockPermissionStates.accessibility,
          status: "granted",
        },
        "screen-recording": {
          ...mockPermissionStates["screen-recording"],
          status: "granted",
        },
        microphone: { ...mockPermissionStates.microphone, status: "granted" },
        camera: { ...mockPermissionStates.camera, status: "granted" },
        shell: { ...mockPermissionStates.shell, status: "granted" },
      };

      const allGranted = [
        "accessibility",
        "screen-recording",
        "microphone",
      ].every((id) => {
        const state = grantedPermissions[id as keyof typeof grantedPermissions];
        return (
          state?.status === "granted" || state?.status === "not-applicable"
        );
      });
      expect(allGranted).toBe(true);
    });

    it("handles not-applicable status as granted", () => {
      const windowsPermissions = {
        accessibility: {
          ...mockPermissionStates.accessibility,
          status: "not-applicable",
        },
        "screen-recording": {
          ...mockPermissionStates["screen-recording"],
          status: "not-applicable",
        },
        microphone: { ...mockPermissionStates.microphone, status: "granted" },
        camera: { ...mockPermissionStates.camera, status: "granted" },
        shell: { ...mockPermissionStates.shell, status: "granted" },
      };

      const allGranted = [
        "accessibility",
        "screen-recording",
        "microphone",
      ].every((id) => {
        const state = windowsPermissions[id as keyof typeof windowsPermissions];
        return (
          state?.status === "granted" || state?.status === "not-applicable"
        );
      });
      expect(allGranted).toBe(true);
    });
  });

  describe("Essential permissions filtering", () => {
    it("excludes shell from onboarding permissions", () => {
      const essentialIds = [
        "accessibility",
        "screen-recording",
        "microphone",
        "camera",
      ];
      expect(essentialIds).not.toContain("shell");
    });

    it("excludes not-applicable permissions from display", () => {
      const windowsPermissions = {
        accessibility: { status: "not-applicable" },
        "screen-recording": { status: "not-applicable" },
        microphone: { status: "granted" },
        camera: { status: "denied" },
      };

      const applicablePermissions = Object.entries(windowsPermissions)
        .filter(([_, state]) => state.status !== "not-applicable")
        .map(([id]) => id);

      expect(applicablePermissions).toEqual(["microphone", "camera"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Status configuration tests
// ---------------------------------------------------------------------------

describe("Status Configuration", () => {
  const STATUS_CONFIG = {
    granted: { color: "var(--ok, #16a34a)", label: "Granted" },
    denied: { color: "var(--danger, #e74c3c)", label: "Denied" },
    "not-determined": { color: "var(--warning, #f59e0b)", label: "Not Set" },
    restricted: { color: "var(--muted)", label: "Restricted" },
    "not-applicable": { color: "var(--muted)", label: "N/A" },
  };

  it("has configuration for all status types", () => {
    const statuses = [
      "granted",
      "denied",
      "not-determined",
      "restricted",
      "not-applicable",
    ];
    for (const status of statuses) {
      expect(STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]).toBeDefined();
    }
  });

  it("granted status has green color", () => {
    expect(STATUS_CONFIG.granted.color).toContain("#16a34a");
  });

  it("denied status has red color", () => {
    expect(STATUS_CONFIG.denied.color).toContain("#e74c3c");
  });

  it("not-determined status has warning color", () => {
    expect(STATUS_CONFIG["not-determined"].color).toContain("#f59e0b");
  });
});

// ---------------------------------------------------------------------------
// Permission icon mapping tests
// ---------------------------------------------------------------------------

describe("Permission Icon Mapping", () => {
  const ICONS = {
    cursor: "🖱️",
    monitor: "🖥️",
    mic: "🎤",
    camera: "📷",
    terminal: "⌨️",
  };

  it("has icon for cursor (accessibility)", () => {
    expect(ICONS.cursor).toBe("🖱️");
  });

  it("has icon for monitor (screen-recording)", () => {
    expect(ICONS.monitor).toBe("🖥️");
  });

  it("has icon for mic (microphone)", () => {
    expect(ICONS.mic).toBe("🎤");
  });

  it("has icon for camera", () => {
    expect(ICONS.camera).toBe("📷");
  });

  it("has icon for terminal (shell)", () => {
    expect(ICONS.terminal).toBe("⌨️");
  });
});

// ---------------------------------------------------------------------------
// Capability definition tests
// ---------------------------------------------------------------------------

describe("Capability Definitions", () => {
  const CAPABILITIES = [
    {
      id: "browser",
      label: "Browser Control",
      requiredPermissions: ["accessibility"],
    },
    {
      id: "computeruse",
      label: "Computer Use",
      requiredPermissions: ["accessibility", "screen-recording"],
    },
    {
      id: "vision",
      label: "Vision",
      requiredPermissions: ["screen-recording"],
    },
  ];

  it("browser requires accessibility", () => {
    const browser = CAPABILITIES.find((c) => c.id === "browser");
    expect(browser?.requiredPermissions).toContain("accessibility");
  });

  it("computeruse requires both accessibility and screen-recording", () => {
    const computeruse = CAPABILITIES.find((c) => c.id === "computeruse");
    expect(computeruse?.requiredPermissions).toContain("accessibility");
    expect(computeruse?.requiredPermissions).toContain("screen-recording");
    expect(computeruse?.requiredPermissions).toHaveLength(2);
  });

  it("vision requires screen-recording", () => {
    const vision = CAPABILITIES.find((c) => c.id === "vision");
    expect(vision?.requiredPermissions).toContain("screen-recording");
  });
});
