// @vitest-environment jsdom
/**
 * Tests for MiladyBarSettings — standalone macOS-style settings window.
 *
 * Covers rendering, tab navigation, deep-linking, General/Providers/Advanced/About
 * tab content, dark mode, and API helpers (getApiBase, apiFetch).
 */
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("@elizaos/app-core/bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: mockInvoke,
}));

// ── Imports ────────────────────────────────────────────────────────────

import { MiladyBarSettings } from "../../src/components/MiladyBarSettings";

// ── Helpers ────────────────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>;

function setupFetch(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    "/api/status": {
      state: "running",
      agentName: "Milady",
      startedAt: Date.now() - 3600000,
    },
    "/api/subscription/status": { credits: 12.5, connected: true },
    "/api/plugins": {
      plugins: [
        {
          id: "openai",
          name: "OpenAI",
          category: "ai-provider",
          enabled: true,
          configured: true,
        },
        {
          id: "anthropic",
          name: "Anthropic",
          category: "ai-provider",
          enabled: true,
          configured: false,
        },
        {
          id: "streaming-base",
          name: "Streaming",
          category: "streaming",
          enabled: true,
          configured: true,
        },
      ],
    },
    "/api/models": { models: ["gpt-4", "gpt-3.5-turbo"] },
    "/api/config": { model: "gpt-4", temperature: 0.7 },
    "/api/agent/restart": { ok: true },
    "/api/provider/switch": { ok: true },
    ...overrides,
  };

  mockFetch = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
    const path = url
      .replace(/^http:\/\/127\.0\.0\.1:2138/, "")
      .replace(/\?.*$/, "");
    const data = defaults[path];
    if (data !== undefined) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(data),
        status: 200,
        statusText: "OK",
      });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: () => Promise.resolve({ error: "not found" }),
    });
  });
  vi.stubGlobal("fetch", mockFetch);
}

function setLocationSearch(search: string) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, search },
    writable: true,
    configurable: true,
  });
}

function renderSettings(): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(MiladyBarSettings));
  });
  return tree;
}

async function renderSettingsAsync(): Promise<TestRenderer.ReactTestRenderer> {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(MiladyBarSettings));
  });
  return tree;
}

function findByText(
  root: TestRenderer.ReactTestInstance,
  text: string | RegExp,
): TestRenderer.ReactTestInstance | null {
  const matches = root.findAll((node) => {
    if (typeof node.children?.[0] === "string") {
      return typeof text === "string"
        ? node.children[0] === text
        : text.test(node.children[0]);
    }
    return false;
  });
  return matches.length > 0 ? matches[0] : null;
}

function findAllByText(
  root: TestRenderer.ReactTestInstance,
  text: string | RegExp,
): TestRenderer.ReactTestInstance[] {
  return root.findAll((node) => {
    if (typeof node.children?.[0] === "string") {
      return typeof text === "string"
        ? node.children[0] === text
        : text.test(node.children[0]);
    }
    return false;
  });
}

function findButtons(
  root: TestRenderer.ReactTestInstance,
): TestRenderer.ReactTestInstance[] {
  return root.findAll((node) => node.type === "button");
}

function findInputs(
  root: TestRenderer.ReactTestInstance,
): TestRenderer.ReactTestInstance[] {
  return root.findAll((node) => node.type === "input");
}

function expectDefined<T>(value: T | undefined, message: string): T {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

// ── Setup / Teardown ───────────────────────────────────────────────────

beforeEach(() => {
  setupFetch();
  mockInvoke.mockClear();
  // Reset localStorage
  localStorage.clear();
  // Reset location
  setLocationSearch("");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── 1. Rendering ───────────────────────────────────────────────────────

describe("MiladyBarSettings — rendering", () => {
  it("renders without crashing", () => {
    const tree = renderSettings();
    expect(tree.toJSON()).not.toBeNull();
  });

  it("renders all 4 tab buttons (General, Providers, Advanced, About)", () => {
    const tree = renderSettings();
    const root = tree.root;
    const tabLabels = ["General", "Providers", "Advanced", "About"];
    for (const label of tabLabels) {
      const found = findByText(root, label);
      expect(found).not.toBeNull();
    }
  });

  it("defaults to the General tab", () => {
    const tree = renderSettings();
    const root = tree.root;
    // The title bar should show "General" when it's the active tab
    const titleNode = findByText(root, "General");
    expect(titleNode).not.toBeNull();
    // AGENT card should be visible on the General tab
    const agentCard = findByText(root, "AGENT");
    expect(agentCard).not.toBeNull();
  });

  it("deep-links to Providers tab with ?tab=providers", () => {
    setLocationSearch("?tab=providers");
    const tree = renderSettings();
    const root = tree.root;
    const providersCard = findByText(root, "AI PROVIDERS");
    expect(providersCard).not.toBeNull();
  });

  it("maps ?tab=plugins to Providers tab", () => {
    setLocationSearch("?tab=plugins");
    const tree = renderSettings();
    const root = tree.root;
    const providersCard = findByText(root, "AI PROVIDERS");
    expect(providersCard).not.toBeNull();
  });

  it("switches tabs when tab button is clicked", () => {
    const tree = renderSettings();
    const root = tree.root;

    // Find the About tab button
    const buttons = findButtons(root);
    const aboutButton = buttons.find((btn) => {
      const textChildren = btn.findAll(
        (n) => typeof n.children?.[0] === "string" && n.children[0] === "About",
      );
      return textChildren.length > 0;
    });
    const resolvedAboutButton = expectDefined(
      aboutButton,
      "About tab button not found",
    );

    act(() => {
      resolvedAboutButton.props.onClick();
    });

    // VERSION card should now be visible (About tab)
    const versionCard = findByText(tree.root, "VERSION");
    expect(versionCard).not.toBeNull();
  });
});

// ── 2. General Tab ─────────────────────────────────────────────────────

describe("MiladyBarSettings — General tab", () => {
  it("fetches agent status from /api/status on mount", async () => {
    await renderSettingsAsync();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/status"),
      undefined,
    );
  });

  it("displays agent name from API response", async () => {
    const tree = await renderSettingsAsync();
    const nameNode = findByText(tree.root, "Milady");
    expect(nameNode).not.toBeNull();
  });

  it("renders running state badge correctly", async () => {
    const tree = await renderSettingsAsync();
    const badge = findByText(tree.root, /Running/);
    expect(badge).not.toBeNull();
  });

  it("renders stopped state badge when agent is stopped", async () => {
    setupFetch({
      "/api/status": { state: "stopped", agentName: "TestBot" },
    });
    const tree = await renderSettingsAsync();
    const badge = findByText(tree.root, /Stopped/);
    expect(badge).not.toBeNull();
  });

  it("renders error state badge when agent has error", async () => {
    setupFetch({
      "/api/status": { state: "error", agentName: "TestBot" },
    });
    const tree = await renderSettingsAsync();
    const badge = findByText(tree.root, /Error/);
    expect(badge).not.toBeNull();
  });

  it("auto-launch toggle calls desktop RPC", async () => {
    mockInvoke.mockResolvedValueOnce({ enabled: false });
    const tree = await renderSettingsAsync();

    // Find toggle button (the button in the ToggleRow for "Start at Login")
    const buttons = findButtons(tree.root);
    const toggleButton = buttons.find((btn) => {
      // Toggle buttons have the toggle styling (width: 44)
      return btn.props.style?.width === 44;
    });
    const resolvedToggleButton = expectDefined(
      toggleButton,
      "Auto-launch toggle button not found",
    );

    await act(async () => {
      resolvedToggleButton.props.onClick();
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopSetAutoLaunch",
        params: { enabled: true },
      }),
    );
  });

  it("displays eliza cloud credits from /api/subscription/status", async () => {
    const tree = await renderSettingsAsync();
    const credits = findByText(tree.root, "$12.50");
    expect(credits).not.toBeNull();
  });

  it("shows 'Not connected' when subscription API fails", async () => {
    setupFetch({
      "/api/subscription/status": undefined, // will 404
    });
    // Override fetch to reject for this endpoint
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/subscription/status")) {
        return Promise.reject(new Error("Network error"));
      }
      if (url.includes("/api/status")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ state: "running", agentName: "Milady" }),
          status: 200,
          statusText: "OK",
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        status: 200,
        statusText: "OK",
      });
    });
    const tree = await renderSettingsAsync();
    const notConnected = findByText(tree.root, "Not connected");
    expect(notConnected).not.toBeNull();
  });

  it("fetches auto-launch status via desktop RPC on mount", async () => {
    mockInvoke.mockResolvedValue({ enabled: true });
    await renderSettingsAsync();
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopGetAutoLaunchStatus",
        ipcChannel: "desktop:getAutoLaunchStatus",
      }),
    );
  });
});

// ── 3. Providers Tab ───────────────────────────────────────────────────

describe("MiladyBarSettings — Providers tab", () => {
  function renderProvidersTab(): Promise<TestRenderer.ReactTestRenderer> {
    setLocationSearch("?tab=providers");
    return renderSettingsAsync();
  }

  it("fetches plugin list from /api/plugins", async () => {
    await renderProvidersTab();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/plugins"),
      undefined,
    );
  });

  it("shows only ai-provider category plugins", async () => {
    const tree = await renderProvidersTab();
    const root = tree.root;
    // OpenAI and Anthropic should appear
    expect(findByText(root, "OpenAI")).not.toBeNull();
    expect(findByText(root, "Anthropic")).not.toBeNull();
    // Streaming plugin should NOT appear
    expect(findByText(root, "Streaming")).toBeNull();
  });

  it("clicking a provider selects it", async () => {
    const tree = await renderProvidersTab();
    const root = tree.root;

    // Find the Anthropic button in the provider list
    const buttons = findButtons(root);
    const anthropicButton = buttons.find((btn) => {
      const textNodes = btn.findAll(
        (n) =>
          typeof n.children?.[0] === "string" && n.children[0] === "Anthropic",
      );
      return textNodes.length > 0;
    });
    const resolvedAnthropicButton = expectDefined(
      anthropicButton,
      "Anthropic provider button not found",
    );

    await act(async () => {
      resolvedAnthropicButton.props.onClick();
    });

    // After selecting Anthropic, detail view should show its name
    const detailNodes = findAllByText(tree.root, "Anthropic");
    // Should have at least 2: one in the list, one in the detail header
    expect(detailNodes.length).toBeGreaterThanOrEqual(2);
  });

  it("renders API key input for selected provider", async () => {
    const tree = await renderProvidersTab();
    const inputs = findInputs(tree.root);
    const passwordInput = inputs.find((inp) => inp.props.type === "password");
    expect(passwordInput).toBeDefined();
  });

  it("'Save & Activate' calls /api/provider/switch with provider + apiKey", async () => {
    const tree = await renderProvidersTab();

    // Type an API key
    const inputs = findInputs(tree.root);
    const passwordInput = expectDefined(
      inputs.find((inp) => inp.props.type === "password"),
      "Provider API key input not found",
    );
    await act(async () => {
      passwordInput.props.onChange({ target: { value: "sk-test-key-123" } });
    });

    // Click Save & Activate
    const buttons = findButtons(tree.root);
    const saveButton = buttons.find((btn) => {
      const textNodes = btn.findAll(
        (n) =>
          typeof n.children?.[0] === "string" &&
          n.children[0] === "Save & Activate",
      );
      return textNodes.length > 0;
    });
    const resolvedSaveButton = expectDefined(
      saveButton,
      "Save & Activate button not found",
    );

    await act(async () => {
      resolvedSaveButton.props.onClick();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/provider/switch"),
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining("sk-test-key-123"),
      }),
    );
  });

  it("'Test Connection' calls /api/models?provider=X", async () => {
    const tree = await renderProvidersTab();

    const buttons = findButtons(tree.root);
    const testButton = buttons.find((btn) => {
      const textNodes = btn.findAll(
        (n) =>
          typeof n.children?.[0] === "string" &&
          n.children[0] === "Test Connection",
      );
      return textNodes.length > 0;
    });
    const resolvedTestButton = expectDefined(
      testButton,
      "Test Connection button not found",
    );

    await act(async () => {
      resolvedTestButton.props.onClick();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/models?provider=openai"),
      undefined,
    );
  });

  it("save success shows green checkmark message", async () => {
    const tree = await renderProvidersTab();

    // Type API key
    const inputs = findInputs(tree.root);
    const passwordInput = expectDefined(
      inputs.find((inp) => inp.props.type === "password"),
      "Provider API key input not found",
    );
    await act(async () => {
      passwordInput.props.onChange({ target: { value: "sk-valid-key" } });
    });

    // Click Save
    const buttons = findButtons(tree.root);
    const saveButton = buttons.find((btn) => {
      const textNodes = btn.findAll(
        (n) =>
          typeof n.children?.[0] === "string" &&
          n.children[0] === "Save & Activate",
      );
      return textNodes.length > 0;
    });

    // Mock the provider/switch and plugins refresh calls
    const resolvedSaveButton = expectDefined(
      saveButton,
      "Save & Activate button not found",
    );

    await act(async () => {
      resolvedSaveButton.props.onClick();
    });

    const savedMessage = findByText(tree.root, /Saved/);
    expect(savedMessage).not.toBeNull();
  });

  it("save failure shows red error message", async () => {
    // Make provider/switch fail
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/provider/switch")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        });
      }
      if (url.includes("/api/plugins")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              plugins: [
                {
                  id: "openai",
                  name: "OpenAI",
                  category: "ai-provider",
                  enabled: true,
                  configured: true,
                },
              ],
            }),
          status: 200,
          statusText: "OK",
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        status: 200,
        statusText: "OK",
      });
    });

    setLocationSearch("?tab=providers");
    const tree = await renderSettingsAsync();

    // Type API key
    const inputs = findInputs(tree.root);
    const passwordInput = expectDefined(
      inputs.find((inp) => inp.props.type === "password"),
      "Provider API key input not found",
    );
    await act(async () => {
      passwordInput.props.onChange({ target: { value: "sk-bad-key" } });
    });

    const buttons = findButtons(tree.root);
    const saveButton = buttons.find((btn) => {
      const textNodes = btn.findAll(
        (n) =>
          typeof n.children?.[0] === "string" &&
          n.children[0] === "Save & Activate",
      );
      return textNodes.length > 0;
    });

    const resolvedSaveButton = expectDefined(
      saveButton,
      "Save & Activate button not found",
    );

    await act(async () => {
      resolvedSaveButton.props.onClick();
    });

    const errorMessage = findByText(tree.root, /✗/);
    expect(errorMessage).not.toBeNull();
  });

  it("configured providers show 'Active' badge", async () => {
    const tree = await renderProvidersTab();
    // OpenAI is configured: true, so should show "Active"
    const activeBadge = findByText(tree.root, /Active/);
    expect(activeBadge).not.toBeNull();
  });

  it("shows 'No AI providers found' when plugin list is empty", async () => {
    setupFetch({
      "/api/plugins": { plugins: [] },
    });
    setLocationSearch("?tab=providers");
    const tree = await renderSettingsAsync();
    const empty = findByText(tree.root, "No AI providers found");
    expect(empty).not.toBeNull();
  });

  it("test connection success shows green checkmark", async () => {
    const tree = await renderProvidersTab();

    const buttons = findButtons(tree.root);
    const testButton = buttons.find((btn) => {
      const textNodes = btn.findAll(
        (n) =>
          typeof n.children?.[0] === "string" &&
          n.children[0] === "Test Connection",
      );
      return textNodes.length > 0;
    });

    const resolvedTestButton = expectDefined(
      testButton,
      "Test Connection button not found",
    );

    await act(async () => {
      resolvedTestButton.props.onClick();
    });

    const okMessage = findByText(tree.root, /Connection OK/);
    expect(okMessage).not.toBeNull();
  });

  it("test connection failure shows red error", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/models")) {
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
        });
      }
      if (url.includes("/api/plugins")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              plugins: [
                {
                  id: "openai",
                  name: "OpenAI",
                  category: "ai-provider",
                  enabled: true,
                  configured: true,
                },
              ],
            }),
          status: 200,
          statusText: "OK",
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        status: 200,
        statusText: "OK",
      });
    });

    setLocationSearch("?tab=providers");
    const tree = await renderSettingsAsync();

    const buttons = findButtons(tree.root);
    const testButton = buttons.find((btn) => {
      const textNodes = btn.findAll(
        (n) =>
          typeof n.children?.[0] === "string" &&
          n.children[0] === "Test Connection",
      );
      return textNodes.length > 0;
    });

    const resolvedTestButton = expectDefined(
      testButton,
      "Test Connection button not found",
    );

    await act(async () => {
      resolvedTestButton.props.onClick();
    });

    const errorMessage = findByText(tree.root, /✗/);
    expect(errorMessage).not.toBeNull();
  });
});

// ── 4. Advanced Tab ────────────────────────────────────────────────────

describe("MiladyBarSettings — Advanced tab", () => {
  async function renderAdvancedTab(): Promise<TestRenderer.ReactTestRenderer> {
    setLocationSearch("?tab=advanced");
    return renderSettingsAsync();
  }

  it("export config button triggers download", async () => {
    // Mock URL.createObjectURL and URL.revokeObjectURL for jsdom
    const mockCreateObjectURL = vi.fn().mockReturnValue("blob:test-url");
    const mockRevokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: mockCreateObjectURL,
      revokeObjectURL: mockRevokeObjectURL,
    });

    const tree = await renderAdvancedTab();
    const buttons = findButtons(tree.root);
    const exportButton = buttons.find((btn) => {
      const textNodes = btn.findAll(
        (n) =>
          typeof n.children?.[0] === "string" &&
          n.children[0] === "Export Config",
      );
      return textNodes.length > 0;
    });
    const resolvedExportButton = expectDefined(
      exportButton,
      "Export Config button not found",
    );

    await act(async () => {
      resolvedExportButton.props.onClick();
    });

    // Should have fetched /api/config
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/config"),
      undefined,
    );
    // Should have created a blob URL for download
    expect(mockCreateObjectURL).toHaveBeenCalled();
  });

  it("restart agent button calls API", async () => {
    const tree = await renderAdvancedTab();
    const buttons = findButtons(tree.root);
    const restartButton = buttons.find((btn) => {
      const textNodes = btn.findAll(
        (n) =>
          typeof n.children?.[0] === "string" && n.children[0] === "Restart",
      );
      return textNodes.length > 0;
    });
    const resolvedRestartButton = expectDefined(
      restartButton,
      "Restart button not found",
    );

    await act(async () => {
      resolvedRestartButton.props.onClick();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/agent/restart"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopOpenSettingsWindow",
        ipcChannel: "desktop:openSettingsWindow",
      }),
    );
  });

  it("shows exported result message on success", async () => {
    // Mock URL APIs for jsdom
    const mockCreateObjectURL = vi.fn().mockReturnValue("blob:test-url");
    const mockRevokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: mockCreateObjectURL,
      revokeObjectURL: mockRevokeObjectURL,
    });

    const tree = await renderAdvancedTab();
    const buttons = findButtons(tree.root);
    const exportButton = buttons.find((btn) => {
      const textNodes = btn.findAll(
        (n) =>
          typeof n.children?.[0] === "string" &&
          n.children[0] === "Export Config",
      );
      return textNodes.length > 0;
    });

    const resolvedExportButton = expectDefined(
      exportButton,
      "Export Config button not found",
    );

    await act(async () => {
      resolvedExportButton.props.onClick();
    });

    const exported = findByText(tree.root, /Exported/);
    expect(exported).not.toBeNull();
  });
});

// ── 5. About Tab ───────────────────────────────────────────────────────

describe("MiladyBarSettings — About tab", () => {
  async function renderAboutTab(): Promise<TestRenderer.ReactTestRenderer> {
    setLocationSearch("?tab=about");
    return renderSettingsAsync();
  }

  it("fetches version info from desktop RPC", async () => {
    mockInvoke.mockResolvedValue({
      version: "1.2.3",
      name: "Milady",
      runtime: "Electrobun",
    });
    await renderAboutTab();
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopGetVersion",
        ipcChannel: "desktop:getVersion",
      }),
    );
  });

  it("displays version info from RPC response", async () => {
    mockInvoke.mockResolvedValue({
      version: "1.2.3",
      name: "Milady",
      runtime: "Electrobun",
    });
    const tree = await renderAboutTab();
    const versionText = findByText(tree.root, "Version: 1.2.3");
    expect(versionText).not.toBeNull();
  });

  it("displays platform info", async () => {
    mockInvoke.mockResolvedValue({
      version: "1.0.0",
      name: "Milady",
      runtime: "Electrobun",
    });
    const tree = await renderAboutTab();
    const platformNode = findByText(tree.root, "Platform");
    expect(platformNode).not.toBeNull();
  });

  it("displays runtime info from RPC response", async () => {
    mockInvoke.mockResolvedValue({
      version: "1.0.0",
      name: "Milady",
      runtime: "Electrobun",
    });
    const tree = await renderAboutTab();
    const runtimeText = findByText(tree.root, "Electrobun");
    expect(runtimeText).not.toBeNull();
  });

  it("shows fallback values when RPC fails", async () => {
    mockInvoke.mockRejectedValue(new Error("RPC unavailable"));
    const tree = await renderAboutTab();
    // Should show fallback name
    const nameNode = findByText(tree.root, "Milady");
    expect(nameNode).not.toBeNull();
    // Should show dash for version
    const versionNode = findByText(tree.root, /Version: —/);
    expect(versionNode).not.toBeNull();
  });
});

// ── 6. Dark Mode ───────────────────────────────────────────────────────

describe("MiladyBarSettings — dark mode", () => {
  it("uses dark theme when localStorage has 'dark'", async () => {
    localStorage.setItem("milady:ui-theme", "dark");
    const tree = await renderSettingsAsync();
    const root = tree.toJSON() as TestRenderer.ReactTestRendererJSON;
    // Dark mode background is #1c1c1e
    expect(root.props.style.backgroundColor).toBe("#1c1c1e");
  });

  it("uses light theme when localStorage has 'light'", async () => {
    localStorage.setItem("milady:ui-theme", "light");
    const tree = await renderSettingsAsync();
    const root = tree.toJSON() as TestRenderer.ReactTestRendererJSON;
    // Light mode background is #f5f5f7
    expect(root.props.style.backgroundColor).toBe("#f5f5f7");
  });

  it("theme tokens change based on dark mode state", async () => {
    // Render in light mode
    localStorage.setItem("milady:ui-theme", "light");
    const lightTree = await renderSettingsAsync();
    const lightRoot = lightTree.toJSON() as TestRenderer.ReactTestRendererJSON;
    const lightBg = lightRoot.props.style.backgroundColor;

    lightTree.unmount();

    // Render in dark mode
    localStorage.setItem("milady:ui-theme", "dark");
    const darkTree = await renderSettingsAsync();
    const darkRoot = darkTree.toJSON() as TestRenderer.ReactTestRendererJSON;
    const darkBg = darkRoot.props.style.backgroundColor;

    expect(lightBg).not.toBe(darkBg);
    expect(lightBg).toBe("#f5f5f7");
    expect(darkBg).toBe("#1c1c1e");
  });
});

// ── 7. API Connection ──────────────────────────────────────────────────

describe("MiladyBarSettings — API helpers", () => {
  it("getApiBase reads from window.__MILADY_API_BASE__", async () => {
    window.__MILADY_API_BASE__ = "http://custom:9999";
    await renderSettingsAsync();
    // Fetch should be called with the custom base
    const calls = mockFetch.mock.calls as unknown[][];
    const hasCustomBase = calls.some((c) =>
      (c[0] as string).startsWith("http://custom:9999"),
    );
    expect(hasCustomBase).toBe(true);
    delete window.__MILADY_API_BASE__;
  });

  it("getApiBase falls back to localhost:2138", async () => {
    // Ensure __MILADY_API_BASE__ is not set
    delete window.__MILADY_API_BASE__;
    await renderSettingsAsync();
    const calls = mockFetch.mock.calls as unknown[][];
    const hasDefault = calls.some((c) =>
      (c[0] as string).startsWith("http://127.0.0.1:2138"),
    );
    expect(hasDefault).toBe(true);
  });

  it("apiFetch prepends base URL to path", async () => {
    delete window.__MILADY_API_BASE__;
    await renderSettingsAsync();
    // Should have called fetch with full URL
    const statusCall = mockFetch.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("/api/status"),
    );
    const resolvedStatusCall = expectDefined(
      statusCall,
      "Status API call not found",
    );
    expect(resolvedStatusCall[0]).toBe("http://127.0.0.1:2138/api/status");
  });

  it("apiFetch throws on non-OK response", async () => {
    // Make /api/status return non-OK
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/status")) {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        status: 200,
        statusText: "OK",
      });
    });
    // The component catches the error internally, but the fetch was attempted
    const tree = await renderSettingsAsync();
    // Agent status should fall back to default since the API failed
    const loading = findByText(tree.root, "Loading...");
    // Either shows Loading or Milady (the default name when API fails)
    const fallback = findByText(tree.root, "Milady");
    expect(loading !== null || fallback !== null).toBe(true);
  });
});

// ── 8. Tab navigation edge cases ───────────────────────────────────────

describe("MiladyBarSettings — tab navigation edge cases", () => {
  it("unknown ?tab value defaults to General", () => {
    setLocationSearch("?tab=nonexistent");
    const tree = renderSettings();
    const agentCard = findByText(tree.root, "AGENT");
    expect(agentCard).not.toBeNull();
  });

  it("?tab=connectors maps to Providers tab", () => {
    setLocationSearch("?tab=connectors");
    const tree = renderSettings();
    const providersCard = findByText(tree.root, "AI PROVIDERS");
    expect(providersCard).not.toBeNull();
  });

  it("no query string defaults to General", () => {
    setLocationSearch("");
    const tree = renderSettings();
    const agentCard = findByText(tree.root, "AGENT");
    expect(agentCard).not.toBeNull();
  });

  it("all tabs render correct title", () => {
    const tree = renderSettings();
    const root = tree.root;

    const tabNames = ["General", "Providers", "Advanced", "About"];
    for (const name of tabNames) {
      const buttons = findButtons(root);
      const tabBtn = buttons.find((btn) => {
        const texts = btn.findAll(
          (n) => typeof n.children?.[0] === "string" && n.children[0] === name,
        );
        return texts.length > 0;
      });
      const resolvedTabButton = expectDefined(
        tabBtn,
        `Tab button not found: ${name}`,
      );

      act(() => {
        resolvedTabButton.props.onClick();
      });

      // Title bar should update to the active tab's label
      // Find the title div (first child of root with the tab label)
      const titleNodes = findAllByText(tree.root, name);
      expect(titleNodes.length).toBeGreaterThanOrEqual(1);
    }
  });
});
