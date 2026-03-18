/**
 * E2E tests for the Settings Reset functionality.
 *
 * Tests cover:
 * 1. API endpoint /api/agent/reset
 * 2. UI reset button in SettingsView triggers handleReset
 * 3. Post-reset state: onboarding resets to welcome, data cleared
 */

import http from "node:http";
// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@elizaos/app-core/components", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/components")
  >("@elizaos/app-core/components");
  return {
    ...actual,
    ProviderSwitcher: () =>
      React.createElement("div", null, "ProviderSwitcher"),
  };
});

// ---------------------------------------------------------------------------
// Part 1: API Tests for /api/agent/reset
// ---------------------------------------------------------------------------

async function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function createResetTestServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  getState: () => {
    agentState: string;
    onboardingComplete: boolean;
    conversationCount: number;
    pluginCount: number;
    characterName: string;
  };
}> {
  const state = {
    agentState: "running" as string,
    onboardingComplete: true,
    conversationCount: 5,
    pluginCount: 3,
    characterName: "TestAgent",
    model: "test-model",
    startedAt: Date.now(),
  };

  const json = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data));
  };

  const routes: Record<
    string,
    (req: http.IncomingMessage, res: http.ServerResponse) => void
  > = {
    "GET /api/status": (_r, res) =>
      json(res, {
        state: state.agentState,
        agentName: state.characterName,
        model: state.model,
        startedAt: state.startedAt,
      }),
    "GET /api/onboarding/status": (_r, res) =>
      json(res, { complete: state.onboardingComplete }),
    "GET /api/conversations": (_r, res) =>
      json(res, {
        conversations: Array(state.conversationCount)
          .fill(null)
          .map((_, i) => ({ id: `conv-${i}` })),
      }),
    "GET /api/plugins": (_r, res) =>
      json(res, {
        plugins: Array(state.pluginCount)
          .fill(null)
          .map((_, i) => ({ name: `plugin-${i}` })),
      }),
    "POST /api/agent/reset": (_r, res) => {
      // Reset all state
      state.agentState = "not_started";
      state.onboardingComplete = false;
      state.conversationCount = 0;
      state.pluginCount = 0;
      state.characterName = "";
      state.model = undefined as unknown as string;
      state.startedAt = undefined as unknown as number;
      json(res, { ok: true, message: "Agent reset successfully" });
    },
    "GET /api/onboarding/options": (_r, res) =>
      json(res, {
        names: ["Eliza"],
        styles: [{ catchphrase: "uwu~", hint: "chaotic good" }],
        providers: [{ id: "ollama", name: "Ollama" }],
        cloudProviders: [],
        models: { small: [], large: [] },
        sharedStyleRules: "",
      }),
  };

  const server = http.createServer((rq, rs) => {
    if (rq.method === "OPTIONS") {
      rs.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      });
      rs.end();
      return;
    }
    const key = `${rq.method} ${new URL(rq.url ?? "/", "http://localhost").pathname}`;
    const handler = routes[key];
    if (handler) {
      handler(rq, rs);
    } else {
      json(rs, { error: "Not found" }, 404);
    }
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
        getState: () => ({
          agentState: state.agentState,
          onboardingComplete: state.onboardingComplete,
          conversationCount: state.conversationCount,
          pluginCount: state.pluginCount,
          characterName: state.characterName,
        }),
      });
    });
  });
}

describe("Agent Reset API", () => {
  let port: number;
  let close: () => Promise<void>;
  let _getState: () => {
    agentState: string;
    onboardingComplete: boolean;
    conversationCount: number;
    pluginCount: number;
    characterName: string;
  };

  beforeAll(async () => {
    ({ port, close, _getState } = await createResetTestServer());
  });

  afterAll(async () => {
    await close();
  });

  it("pre-reset: agent is running with completed onboarding", async () => {
    const status = await req(port, "GET", "/api/status");
    expect(status.data.state).toBe("running");
    expect(status.data.agentName).toBe("TestAgent");

    const onboarding = await req(port, "GET", "/api/onboarding/status");
    expect(onboarding.data.complete).toBe(true);

    const conversations = await req(port, "GET", "/api/conversations");
    expect((conversations.data.conversations as unknown[]).length).toBe(5);

    const plugins = await req(port, "GET", "/api/plugins");
    expect((plugins.data.plugins as unknown[]).length).toBe(3);
  });

  it("POST /api/agent/reset returns success", async () => {
    const { status, data } = await req(port, "POST", "/api/agent/reset");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  it("post-reset: agent state is not_started", async () => {
    const { data } = await req(port, "GET", "/api/status");
    expect(data.state).toBe("not_started");
    expect(data.agentName).toBe("");
  });

  it("post-reset: onboarding is incomplete", async () => {
    const { data } = await req(port, "GET", "/api/onboarding/status");
    expect(data.complete).toBe(false);
  });

  it("post-reset: conversations cleared", async () => {
    const { data } = await req(port, "GET", "/api/conversations");
    expect((data.conversations as unknown[]).length).toBe(0);
  });

  it("post-reset: plugins cleared", async () => {
    const { data } = await req(port, "GET", "/api/plugins");
    expect((data.plugins as unknown[]).length).toBe(0);
  });

  it("post-reset: onboarding options still available", async () => {
    const { status, data } = await req(port, "GET", "/api/onboarding/options");
    expect(status).toBe(200);
    expect(Array.isArray(data.names)).toBe(true);
    expect(Array.isArray(data.styles)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 2: UI Tests for Settings Reset Button
// ---------------------------------------------------------------------------

type OnboardingStep =
  | "welcome"
  | "name"
  | "avatar"
  | "style"
  | "theme"
  | "runMode"
  | "llmProvider"
  | "inventorySetup"
  | "connectors"
  | "permissions";

type AppHarnessState = {
  onboardingLoading: boolean;
  authRequired: boolean;
  onboardingComplete: boolean;
  tab: string;
  actionNotice: string | null;
  onboardingStep: OnboardingStep;
  onboardingOptions: object | null;
  onboardingName: string;
  onboardingStyle: string;
  conversations: unknown[];
  plugins: unknown[];
  skills: unknown[];
  logs: unknown[];
  currentTheme: string;
  [key: string]: unknown;
};

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
    THEMES: [
      { id: "eliza", label: "Eliza" },
      { id: "dark", label: "Dark" },
    ],
  };
});

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

function createUIHarnessState(): AppHarnessState {
  return {
    onboardingLoading: false,
    authRequired: false,
    onboardingComplete: true,
    tab: "settings",
    actionNotice: null,
    onboardingStep: "welcome",
    onboardingOptions: {
      names: ["Eliza"],
      styles: [{ catchphrase: "uwu~" }],
      providers: [],
      cloudProviders: [],
      models: { small: [], large: [] },
      sharedStyleRules: "",
    },
    onboardingName: "TestAgent",
    onboardingStyle: "uwu~",
    conversations: [{ id: "conv-1" }, { id: "conv-2" }],
    plugins: [{ name: "plugin-1" }],
    skills: [],
    logs: [],
    currentTheme: "eliza",
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    elizaCloudCredits: 0,
    elizaCloudCreditsLow: false,
    elizaCloudCreditsCritical: false,
    elizaCloudTopUpUrl: "",
    elizaCloudUserId: "",
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: "",
    cloudDisconnecting: false,
    pluginSaving: false,
    pluginSaveSuccess: false,
  };
}

describe("Settings Reset UI", () => {
  let state: AppHarnessState;
  let handleResetCalled: boolean;
  let confirmDialogShown: boolean;

  beforeEach(() => {
    state = createUIHarnessState();
    handleResetCalled = false;
    confirmDialogShown = false;

    // Mock window.confirm to track calls and auto-confirm
    vi.spyOn(window, "confirm").mockImplementation((message) => {
      confirmDialogShown = true;
      expect(message).toContain("reset");
      return true;
    });

    const handleReset = async () => {
      // Simulate the actual handleReset behavior
      const confirmed = window.confirm("settings.resetConfirmMessage");
      if (!confirmed) return;

      handleResetCalled = true;
      state.onboardingComplete = false;
      state.onboardingStep = "welcome";
      state.onboardingName = "";
      state.onboardingStyle = "";
      state.conversations = [];
      state.plugins = [];
      state.skills = [];
      state.logs = [];
    };

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      t: (k: string) => k,
      ...state,
      triggers: [],
      triggersLoading: false,
      triggersSaving: false,
      triggerRunsById: {},
      triggerHealth: null,
      triggerError: null,
      setState: (key: string, value: unknown) => {
        state[key] = value;
      },
      setTheme: (theme: string) => {
        state.currentTheme = theme;
      },
      setTab: (tab: string) => {
        state.tab = tab;
      },
      loadPlugins: vi.fn(),
      handlePluginToggle: vi.fn(),
      handlePluginConfigSave: vi.fn(),
      handleCloudLogin: vi.fn(),
      handleCloudDisconnect: vi.fn(),
      loadTriggers: vi.fn(async () => {}),
      createTrigger: vi.fn(async () => null),
      updateTrigger: vi.fn(async () => null),
      deleteTrigger: vi.fn(async () => true),
      runTriggerNow: vi.fn(async () => true),
      loadTriggerRuns: vi.fn(async () => {}),
      loadTriggerHealth: vi.fn(async () => {}),
      loadUpdateStatus: vi.fn(),
      handleReset,
    }));
  });

  it("renders SettingsView with Danger Zone section", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    expect(tree).not.toBeNull();
    const renderedTree = tree;

    // Find the Danger Zone text
    const dangerZoneText = renderedTree.root.findAll(
      (node) =>
        node.type === "span" && node.children.includes("settings.dangerZone"),
    );
    expect(dangerZoneText.length).toBeGreaterThan(0);
  });

  it("renders Reset Agent button in Danger Zone", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    const renderedTree = tree;

    // Find the Reset button
    const resetButtons = renderedTree.root.findAll(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) =>
            typeof child === "string" &&
            child.includes("settings.resetEverything"),
        ),
    );
    expect(resetButtons.length).toBeGreaterThan(0);
  });

  it("clicking Reset button calls handleReset", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    const renderedTree = tree;

    // Find and click the Reset button in Danger Zone
    const resetButton = renderedTree.root.findAll(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) =>
            typeof child === "string" &&
            child.includes("settings.resetEverything"),
        ),
    )[0];

    expect(resetButton).toBeDefined();

    await act(async () => {
      resetButton.props.onClick();
    });

    expect(confirmDialogShown).toBe(true);
    expect(handleResetCalled).toBe(true);
  });

  it("after reset, onboarding state is cleared", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    const renderedTree = tree;

    // Verify pre-reset state
    expect(state.onboardingComplete).toBe(true);
    expect(state.conversations.length).toBe(2);
    expect(state.plugins.length).toBe(1);

    // Find and click the Reset button
    const resetButton = renderedTree.root.findAll(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) =>
            typeof child === "string" &&
            child.includes("settings.resetEverything"),
        ),
    )[0];

    await act(async () => {
      resetButton.props.onClick();
    });

    // Verify post-reset state
    expect(state.onboardingComplete).toBe(false);
    expect(state.onboardingStep).toBe("welcome");
    expect(state.onboardingName).toBe("");
    expect(state.onboardingStyle).toBe("");
    expect(state.conversations.length).toBe(0);
    expect(state.plugins.length).toBe(0);
  });

  it("reset is cancelled if user declines confirmation", async () => {
    // Override confirm to return false
    vi.spyOn(window, "confirm").mockImplementation(() => {
      confirmDialogShown = true;
      return false;
    });

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    const renderedTree = tree;

    const originalComplete = state.onboardingComplete;
    const originalConvCount = state.conversations.length;

    // Find and click the Reset button
    const resetButton = renderedTree.root.findAll(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) =>
            typeof child === "string" &&
            child.includes("settings.resetEverything"),
        ),
    )[0];

    await act(async () => {
      resetButton.props.onClick();
    });

    // Confirm was shown but reset was not executed
    expect(confirmDialogShown).toBe(true);
    expect(handleResetCalled).toBe(false);
    expect(state.onboardingComplete).toBe(originalComplete);
    expect(state.conversations.length).toBe(originalConvCount);
  });
});

// ---------------------------------------------------------------------------
// Part 3: Integration test - Reset flow returns to onboarding
// ---------------------------------------------------------------------------

describe("Reset to Onboarding Flow Integration", () => {
  let state: AppHarnessState;

  beforeEach(() => {
    state = createUIHarnessState();
    state.onboardingComplete = true;
    state.tab = "chat";

    vi.spyOn(window, "confirm").mockImplementation(() => true);

    const handleReset = async () => {
      const confirmed = window.confirm("Reset?");
      if (!confirmed) return;

      state.onboardingComplete = false;
      state.onboardingStep = "welcome";
      state.onboardingName = "";
      state.onboardingStyle = "";
      state.conversations = [];
      state.plugins = [];
      state.skills = [];
      state.logs = [];
      state.tab = "chat"; // Will show onboarding wizard when onboardingComplete is false
    };

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      t: (k: string) => k,
      ...state,
      setState: (key: string, value: unknown) => {
        state[key] = value;
      },
      setTheme: vi.fn(),
      setTab: (tab: string) => {
        state.tab = tab;
      },
      loadPlugins: vi.fn(),
      handlePluginToggle: vi.fn(),
      handlePluginConfigSave: vi.fn(),
      handleCloudLogin: vi.fn(),
      handleCloudDisconnect: vi.fn(),
      loadUpdateStatus: vi.fn(),
      handleReset,
    }));
  });

  it("after reset, app should show onboarding wizard (welcome step)", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    const renderedTree = tree;

    // Trigger reset
    const resetButton = renderedTree.root.findAll(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) =>
            typeof child === "string" &&
            child.includes("settings.resetEverything"),
        ),
    )[0];

    await act(async () => {
      resetButton.props.onClick();
    });

    // Verify state is ready for onboarding
    expect(state.onboardingComplete).toBe(false);
    expect(state.onboardingStep).toBe("welcome");

    // The App component would now render OnboardingWizard instead of main UI
    // This is verified by the onboardingComplete === false state
  });

  it("personality (onboardingStyle) is cleared after reset", async () => {
    state.onboardingStyle = "uwu~";
    state.onboardingName = "CustomAgent";

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(SettingsView));
    });

    const renderedTree = tree;

    // Verify pre-reset
    expect(state.onboardingStyle).toBe("uwu~");
    expect(state.onboardingName).toBe("CustomAgent");

    // Trigger reset
    const resetButton = renderedTree.root.findAll(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) =>
            typeof child === "string" &&
            child.includes("settings.resetEverything"),
        ),
    )[0];

    await act(async () => {
      resetButton.props.onClick();
    });

    // Verify personality is cleared
    expect(state.onboardingStyle).toBe("");
    expect(state.onboardingName).toBe("");
  });
});
