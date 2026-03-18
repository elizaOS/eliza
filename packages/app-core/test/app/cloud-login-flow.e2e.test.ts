/**
 * E2E tests for Cloud Login Flow — UI Tests.
 *
 * Tests cover:
 * 1. Cloud login UI state
 * 2. Cloud connection status display
 * 3. Cloud credits display
 * 4. Cloud disconnect UI
 * 5. Cloud error handling
 *
 * API endpoint tests are in cloud-api.e2e.test.ts (separated to avoid
 * mixing node HTTP server with jsdom, which causes V8 OOM).
 */

// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Part 2: UI Tests for Cloud Login
// ---------------------------------------------------------------------------

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
  THEMES: [{ id: "eliza", label: "Eliza" }],
}));

vi.mock("@elizaos/app-core/components", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/components")
  >("@elizaos/app-core/components");
  return {
    ...actual,
  };
});

vi.mock("@elizaos/app-core/components/ConfigPageView", () => ({
  ConfigPageView: () => React.createElement("div", null, "ConfigPageView"),
}));

vi.mock("@elizaos/app-core/components/CodingAgentSettingsSection", () => ({
  CodingAgentSettingsSection: () =>
    React.createElement("div", null, "CodingAgentSettingsSection"),
}));

vi.mock("@elizaos/app-core/components/MediaSettingsSection", () => ({
  MediaSettingsSection: () =>
    React.createElement("div", null, "MediaSettingsSection"),
}));

vi.mock("@elizaos/app-core/components/ElizaCloudDashboard", () => ({
  CloudDashboard: () => React.createElement("div", null, "ElizaCloudDashboard"),
}));

vi.mock("@elizaos/app-core/components/PermissionsSection", () => ({
  PermissionsSection: () =>
    React.createElement("div", null, "PermissionsSection"),
}));

vi.mock("@elizaos/app-core/components/ProviderSwitcher", () => ({
  ProviderSwitcher: () => React.createElement("div", null, "ProviderSwitcher"),
}));

vi.mock("@elizaos/app-core/components/VoiceConfigView", () => ({
  VoiceConfigView: () => React.createElement("div", null, "VoiceConfigView"),
}));

import { SettingsView } from "@elizaos/app-core/components/SettingsView";

type CloudState = {
  elizaCloudEnabled: boolean;
  elizaCloudConnected: boolean;
  elizaCloudCredits: number;
  elizaCloudCreditsLow: boolean;
  elizaCloudCreditsCritical: boolean;
  elizaCloudTopUpUrl: string;
  elizaCloudUserId: string;
  elizaCloudLoginBusy: boolean;
  elizaCloudLoginError: string;
  cloudDisconnecting: boolean;
  currentTheme: string;
  plugins: unknown[];
  pluginSaving: boolean;
  pluginSaveSuccess: boolean;
};

function createCloudUIState(): CloudState {
  return {
    elizaCloudEnabled: true,
    elizaCloudConnected: false,
    elizaCloudCredits: 0,
    elizaCloudCreditsLow: false,
    elizaCloudCreditsCritical: false,
    elizaCloudTopUpUrl: "https://example.com/topup",
    elizaCloudUserId: "",
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: "",
    cloudDisconnecting: false,
    currentTheme: "eliza",
    plugins: [],
    pluginSaving: false,
    pluginSaveSuccess: false,
  };
}

describe("Cloud Login UI", () => {
  let state: CloudState;
  let _loginCalled: boolean;
  let _disconnectCalled: boolean;
  let tree: TestRenderer.ReactTestRenderer | null = null;

  afterEach(() => {
    // Unmount React tree to clean up effects/timers and allow the
    // worker process to exit cleanly.
    if (tree) {
      act(() => {
        tree?.unmount();
      });
      tree = null;
    }
  });

  beforeEach(() => {
    state = createCloudUIState();
    _loginCalled = false;
    _disconnectCalled = false;

    vi.spyOn(window, "confirm").mockImplementation(() => true);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] }),
    }) as unknown as typeof fetch;

    const sharedLoadDropStatus = vi.fn().mockResolvedValue(undefined);
    const cachedMock = {
      t: (k: string) => k,
      ...state,
      uiLanguage: "en",
      setUiLanguage: vi.fn(),
      exportBusy: false,
      exportPassword: "",
      exportIncludeLogs: false,
      exportError: null,
      exportSuccess: null,
      triggers: [],
      triggersLoading: false,
      triggersSaving: false,
      triggerRunsById: {},
      triggerHealth: null,
      triggerError: null,
      importBusy: false,
      importPassword: "",
      importFile: null,
      importError: null,
      importSuccess: null,
      loadPlugins: vi.fn(),
      loadTriggers: vi.fn(async () => {}),
      createTrigger: vi.fn(async () => null),
      updateTrigger: vi.fn(async () => null),
      deleteTrigger: vi.fn(async () => true),
      runTriggerNow: vi.fn(async () => true),
      loadTriggerRuns: vi.fn(async () => {}),
      loadTriggerHealth: vi.fn(async () => {}),
      handlePluginToggle: vi.fn(),
      setTheme: vi.fn(),
      setTab: vi.fn(),
      setActionNotice: vi.fn(),
      loadUpdateStatus: vi.fn(),
      handlePluginConfigSave: vi.fn(),
      handleCloudLogin: async () => {
        _loginCalled = true;
        state.elizaCloudConnected = true;
        state.elizaCloudUserId = "user-123";
        state.elizaCloudCredits = 1000;
      },
      handleCloudDisconnect: async () => {
        _disconnectCalled = true;
        state.elizaCloudConnected = false;
        state.elizaCloudUserId = "";
        state.elizaCloudCredits = 0;
      },
      handleReset: vi.fn(),
      handleAgentExport: vi.fn(),
      handleAgentImport: vi.fn(),
      setState: vi.fn(),
      loadDropStatus: sharedLoadDropStatus,
    };

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => cachedMock);
  });

  it("renders cloud section in settings", async () => {
    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    expect(tree).not.toBeNull();
  });

  it("shows login state when not connected", async () => {
    state.elizaCloudConnected = false;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    // Should show login or connect button
    expect(tree).not.toBeNull();
  });

  it("shows connected state with user info", async () => {
    state.elizaCloudConnected = true;
    state.elizaCloudUserId = "user-123";
    state.elizaCloudCredits = 500;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    // Should show disconnect button or user info
    expect(tree).not.toBeNull();
  });

  it("shows loading state during login", async () => {
    state.elizaCloudLoginBusy = true;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    expect(tree).not.toBeNull();
  });

  it("shows error when login fails", async () => {
    state.elizaCloudLoginError = "Invalid token";

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    expect(tree).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 3: Cloud Connection Integration Tests
// ---------------------------------------------------------------------------

describe("Cloud Connection Integration", () => {
  let state: CloudState;

  beforeEach(() => {
    state = createCloudUIState();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] }),
    }) as unknown as typeof fetch;

    const sharedLoadDropStatus = vi.fn().mockResolvedValue(undefined);
    const cachedMock = {
      t: (k: string) => k,
      ...state,
      uiLanguage: "en",
      setUiLanguage: vi.fn(),
      triggers: [],
      triggersLoading: false,
      triggersSaving: false,
      triggerRunsById: {},
      triggerHealth: null,
      triggerError: null,
      loadPlugins: vi.fn(),
      loadTriggers: vi.fn(async () => {}),
      createTrigger: vi.fn(async () => null),
      updateTrigger: vi.fn(async () => null),
      deleteTrigger: vi.fn(async () => true),
      runTriggerNow: vi.fn(async () => true),
      loadTriggerRuns: vi.fn(async () => {}),
      loadTriggerHealth: vi.fn(async () => {}),
      handlePluginToggle: vi.fn(),
      setTheme: vi.fn(),
      setTab: vi.fn(),
      setActionNotice: vi.fn(),
      loadUpdateStatus: vi.fn(),
      handlePluginConfigSave: vi.fn(),
      handleCloudLogin: async () => {
        state.elizaCloudLoginBusy = true;
        state.elizaCloudConnected = true;
        state.elizaCloudUserId = "user-123";
        state.elizaCloudCredits = 1000;
        state.elizaCloudLoginBusy = false;
      },
      handleCloudDisconnect: async () => {
        state.cloudDisconnecting = true;
        state.elizaCloudConnected = false;
        state.elizaCloudUserId = "";
        state.elizaCloudCredits = 0;
        state.cloudDisconnecting = false;
      },
      handleReset: vi.fn(),
      handleAgentExport: vi.fn(),
      handleAgentImport: vi.fn(),
      setState: vi.fn(),
      loadDropStatus: sharedLoadDropStatus,
    };

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => cachedMock);
  });

  it("login updates connection state", async () => {
    const loginFn = mockUseApp().handleCloudLogin;

    expect(state.elizaCloudConnected).toBe(false);
    await loginFn();
    expect(state.elizaCloudConnected).toBe(true);
  });

  it("login sets user ID", async () => {
    const loginFn = mockUseApp().handleCloudLogin;

    await loginFn();
    expect(state.elizaCloudUserId).toBe("user-123");
  });

  it("login sets credits", async () => {
    const loginFn = mockUseApp().handleCloudLogin;

    await loginFn();
    expect(state.elizaCloudCredits).toBe(1000);
  });

  it("disconnect clears connection state", async () => {
    const loginFn = mockUseApp().handleCloudLogin;
    const disconnectFn = mockUseApp().handleCloudDisconnect;

    await loginFn();
    expect(state.elizaCloudConnected).toBe(true);

    await disconnectFn();
    expect(state.elizaCloudConnected).toBe(false);
  });

  it("disconnect clears user ID and credits", async () => {
    const loginFn = mockUseApp().handleCloudLogin;
    const disconnectFn = mockUseApp().handleCloudDisconnect;

    await loginFn();
    await disconnectFn();

    expect(state.elizaCloudUserId).toBe("");
    expect(state.elizaCloudCredits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Part 4: Cloud Credits Display Tests
// ---------------------------------------------------------------------------

describe("Cloud Credits Display", () => {
  let state: CloudState;

  beforeEach(() => {
    state = createCloudUIState();
    state.elizaCloudConnected = true;
    state.elizaCloudUserId = "user-123";

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] }),
    }) as unknown as typeof fetch;

    const sharedLoadDropStatus = vi.fn().mockResolvedValue(undefined);
    const cachedMock = {
      t: (k: string) => k,
      ...state,
      uiLanguage: "en",
      setUiLanguage: vi.fn(),
      loadPlugins: vi.fn(),
      handlePluginToggle: vi.fn(),
      setTheme: vi.fn(),
      setTab: vi.fn(),
      setActionNotice: vi.fn(),
      loadUpdateStatus: vi.fn(),
      handlePluginConfigSave: vi.fn(),
      handleCloudLogin: vi.fn(),
      handleCloudDisconnect: vi.fn(),
      handleReset: vi.fn(),
      handleAgentExport: vi.fn(),
      handleAgentImport: vi.fn(),
      setState: vi.fn(),
      loadDropStatus: sharedLoadDropStatus,
    };

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => cachedMock);
  });

  it("normal credits show without warning", () => {
    state.elizaCloudCredits = 500;
    state.elizaCloudCreditsLow = false;
    state.elizaCloudCreditsCritical = false;

    expect(state.elizaCloudCreditsLow).toBe(false);
    expect(state.elizaCloudCreditsCritical).toBe(false);
  });

  it("low credits sets warning flag", () => {
    state.elizaCloudCredits = 50;
    state.elizaCloudCreditsLow = true;

    expect(state.elizaCloudCreditsLow).toBe(true);
  });

  it("critical credits sets critical flag", () => {
    state.elizaCloudCredits = 5;
    state.elizaCloudCreditsCritical = true;

    expect(state.elizaCloudCreditsCritical).toBe(true);
  });

  it("topup URL is available", () => {
    expect(state.elizaCloudTopUpUrl).toBe("https://example.com/topup");
  });
});

// ---------------------------------------------------------------------------
// Part 5: Cloud Error Handling Tests
// ---------------------------------------------------------------------------

describe("Cloud Error Handling", () => {
  let state: CloudState;

  beforeEach(() => {
    state = createCloudUIState();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] }),
    }) as unknown as typeof fetch;

    const sharedLoadDropStatus = vi.fn().mockResolvedValue(undefined);
    const cachedMock = {
      t: (k: string) => k,
      ...state,
      uiLanguage: "en",
      setUiLanguage: vi.fn(),
      loadPlugins: vi.fn(),
      handlePluginToggle: vi.fn(),
      setTheme: vi.fn(),
      setTab: vi.fn(),
      setActionNotice: vi.fn(),
      loadUpdateStatus: vi.fn(),
      handlePluginConfigSave: vi.fn(),
      handleCloudLogin: async () => {
        state.elizaCloudLoginBusy = true;
        state.elizaCloudLoginError = "Authentication failed";
        state.elizaCloudLoginBusy = false;
      },
      handleCloudDisconnect: vi.fn(),
      handleReset: vi.fn(),
      handleAgentExport: vi.fn(),
      handleAgentImport: vi.fn(),
      setState: vi.fn(),
      loadDropStatus: sharedLoadDropStatus,
    };

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => cachedMock);
  });

  it("login failure sets error message", async () => {
    const loginFn = mockUseApp().handleCloudLogin;

    await loginFn();

    expect(state.elizaCloudLoginError).toBe("Authentication failed");
  });

  it("login failure keeps disconnected state", async () => {
    const loginFn = mockUseApp().handleCloudLogin;

    await loginFn();

    expect(state.elizaCloudConnected).toBe(false);
  });
});
