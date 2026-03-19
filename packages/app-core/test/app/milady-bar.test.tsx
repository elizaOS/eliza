// @vitest-environment jsdom
/**
 * Tests for useMiladyBar — macOS menu bar tray integration hook.
 *
 * Verifies the hook builds correct tray menu structures from app state
 * and dispatches them to the Electrobun RPC bridge.
 */
import React, { type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

const { mockInvoke, mockIsDesktop, mockScanProviderCredentials, mockScanAndValidateProviderCredentials, mockSubscribe } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(null),
  mockIsDesktop: vi.fn(() => true),
  mockScanProviderCredentials: vi.fn().mockResolvedValue([]),
  mockScanAndValidateProviderCredentials: vi.fn().mockResolvedValue([]),
  mockSubscribe: vi.fn(() => vi.fn()),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("@elizaos/app-core/bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: mockInvoke,
  scanProviderCredentials: mockScanProviderCredentials,
  scanAndValidateProviderCredentials: mockScanAndValidateProviderCredentials,
  subscribeDesktopBridgeEvent: mockSubscribe,
}));

vi.mock("@elizaos/app-core/platform", () => ({
  isDesktopPlatform: () => mockIsDesktop(),
}));

// ── Imports ────────────────────────────────────────────────────────────

import { useMiladyBar } from "../../src/hooks/useMiladyBar";

// ── Helpers ────────────────────────────────────────────────────────────

function defaultAppState(overrides: Record<string, unknown> = {}) {
  return {
    plugins: [
      { id: "openai", name: "OpenAI", category: "ai-provider", enabled: true, configured: true, parameters: [] },
      { id: "anthropic", name: "Anthropic", category: "ai-provider", enabled: true, configured: false, parameters: [] },
      { id: "streaming-base", name: "Streaming", category: "streaming", enabled: true, configured: true, parameters: [] },
    ],
    uiTheme: "dark",
    agentStatus: { state: "running", agentName: "Milady", startedAt: Date.now() - 3600000 },
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    elizaCloudCredits: null,
    elizaCloudCreditsCritical: false,
    elizaCloudCreditsLow: false,
    walletBalances: null,
    onboardingDetectedProviders: [],
    setTab: vi.fn(),
    setState: vi.fn(),
    t: (key: string) => key,
    ...overrides,
  };
}

function TestHarness() {
  useMiladyBar();
  return React.createElement("div", null, "harness");
}

function getLastMenuCall(): Array<{ id: string; label?: string; type?: string; enabled?: boolean; submenu?: Array<{ id: string; label?: string; type?: string; enabled?: boolean; checked?: boolean }> }> | null {
  const calls = mockInvoke.mock.calls.filter(
    (c: unknown[]) => (c[0] as { rpcMethod: string }).rpcMethod === "desktopSetTrayMenu",
  );
  if (calls.length === 0) return null;
  const lastCall = calls[calls.length - 1][0] as { params: { menu: unknown } };
  return lastCall.params.menu as Array<{ id: string; label?: string; type?: string; enabled?: boolean }>;
}

function getMenuItemById(menu: Array<{ id: string; label?: string }>, id: string) {
  return menu.find((item) => item.id === id) ?? null;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("useMiladyBar", () => {
  beforeEach(() => {
    mockUseApp.mockReturnValue(defaultAppState());
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
    mockSubscribe.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends tray menu update via desktopSetTrayMenu RPC", () => {
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopSetTrayMenu",
        ipcChannel: "desktop:setTrayMenu",
      }),
    );
  });

  it("does not call RPC when not on desktop platform", () => {
    mockIsDesktop.mockReturnValue(false);
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("includes enabled AI providers in menu with status labels", () => {
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    expect(menu).not.toBeNull();

    const header = getMenuItemById(menu, "providers-header");
    expect(header).not.toBeNull();
    expect(header!.label).toBe("AI Providers");

    const openai = getMenuItemById(menu, "provider-openai");
    expect(openai).not.toBeNull();
    expect(openai!.label).toContain("OpenAI");
    expect(openai!.label).toContain("Active");

    const anthropic = getMenuItemById(menu, "provider-anthropic");
    expect(anthropic).not.toBeNull();
    expect(anthropic!.label).toContain("Anthropic");
  });

  it("excludes non-ai-provider plugins from menu", () => {
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const streaming = getMenuItemById(menu, "provider-streaming-base");
    expect(streaming).toBeNull();
  });

  it("shows cloud credits when connected", () => {
    mockUseApp.mockReturnValue(
      defaultAppState({
        elizaCloudEnabled: true,
        elizaCloudConnected: true,
        elizaCloudCredits: 2.4,
      }),
    );
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const cloud = getMenuItemById(menu, "cloud-credits");
    expect(cloud).not.toBeNull();
    expect(cloud!.label).toContain("$2.40");
  });

  it("shows cloud disconnected when enabled but not connected", () => {
    mockUseApp.mockReturnValue(
      defaultAppState({
        elizaCloudEnabled: true,
        elizaCloudConnected: false,
      }),
    );
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const cloud = getMenuItemById(menu, "cloud-credits");
    expect(cloud).not.toBeNull();
    expect(cloud!.label).toContain("Disconnected");
  });

  it("omits cloud section when cloud is not enabled or connected", () => {
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const cloud = getMenuItemById(menu, "cloud-credits");
    expect(cloud).toBeNull();
  });

  it("shows wallet balance total in menu", () => {
    mockUseApp.mockReturnValue(
      defaultAppState({
        walletBalances: {
          evm: {
            address: "0x123",
            chains: [
              {
                chain: "ethereum", chainId: 1,
                nativeBalance: "1.0", nativeSymbol: "ETH", nativeValueUsd: "100.00",
                tokens: [{ symbol: "USDC", valueUsd: "52.50", name: "USDC", contractAddress: "0x", balance: "52.5", decimals: 6, logoUrl: "" }],
                error: null,
              },
            ],
          },
          solana: null,
        },
      }),
    );
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const wallet = getMenuItemById(menu, "wallet-balance");
    expect(wallet).not.toBeNull();
    expect(wallet!.label).toContain("$152.50");
  });

  it("omits wallet section when no balances loaded", () => {
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const wallet = getMenuItemById(menu, "wallet-balance");
    expect(wallet).toBeNull();
  });

  it("always includes standard actions (Show, Restart, Quit, Settings, Refresh)", () => {
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    expect(getMenuItemById(menu, "show")).not.toBeNull();
    expect(getMenuItemById(menu, "restart-agent")).not.toBeNull();
    expect(getMenuItemById(menu, "quit")).not.toBeNull();
    expect(getMenuItemById(menu, "check-for-updates")).not.toBeNull();
    expect(getMenuItemById(menu, "open-settings")).not.toBeNull();
    expect(getMenuItemById(menu, "refresh-now")).not.toBeNull();
  });

  it("provider items have interactive submenus", () => {
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const openai = menu.find((i) => i.id === "provider-openai");
    expect(openai).not.toBeNull();
    expect(openai!.submenu).toBeDefined();
    expect(openai!.submenu!.length).toBeGreaterThan(0);
  });

  it("standard actions are interactive (no enabled: false)", () => {
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const show = getMenuItemById(menu, "show") as Record<string, unknown>;
    expect(show.enabled).toBeUndefined();
  });

  it("shows detected credentials in tray menu with source labels", async () => {
    mockScanProviderCredentials.mockResolvedValue([
      { id: "groq", source: "env", cliInstalled: false },
      { id: "mistral", source: "codex-auth", cliInstalled: true },
    ]);
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenuCall()!;
    const header = getMenuItemById(menu, "detected-header");
    expect(header).not.toBeNull();
    expect(header!.label).toBe("Detected Credentials");

    const groq = getMenuItemById(menu, "detected-groq");
    expect(groq).not.toBeNull();
    expect(groq!.label).toContain("Groq");
    expect(groq!.label).toContain("via Environment");

    const mistral = getMenuItemById(menu, "detected-mistral");
    expect(mistral).not.toBeNull();
    expect(mistral!.label).toContain("Mistral");
    expect(mistral!.label).toContain("via Codex CLI");
  });

  it("merges detected provider into enabled provider line (no duplicate)", async () => {
    mockScanProviderCredentials.mockResolvedValue([
      { id: "openai", source: "claude-credentials", cliInstalled: true },
    ]);
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenuCall()!;
    const openai = getMenuItemById(menu, "provider-openai");
    expect(openai).not.toBeNull();
    expect(openai!.label).toContain("Active");
    expect(openai!.label).toContain("via Claude Code");

    const detectedOpenai = getMenuItemById(menu, "detected-openai");
    expect(detectedOpenai).toBeNull();
  });

  it("maps all source labels correctly", async () => {
    mockScanProviderCredentials.mockResolvedValue([
      { id: "provider-a", source: "codex-auth", cliInstalled: false },
      { id: "provider-b", source: "claude-credentials", cliInstalled: false },
      { id: "provider-c", source: "keychain", cliInstalled: false },
      { id: "provider-d", source: "env", cliInstalled: false },
    ]);
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenuCall()!;
    expect(getMenuItemById(menu, "detected-provider-a")!.label).toContain("via Codex CLI");
    expect(getMenuItemById(menu, "detected-provider-b")!.label).toContain("via Claude Code");
    expect(getMenuItemById(menu, "detected-provider-c")!.label).toContain("via Keychain");
    expect(getMenuItemById(menu, "detected-provider-d")!.label).toContain("via Environment");
  });

  it("updates tray when state changes", () => {
    const state1 = defaultAppState();
    mockUseApp.mockReturnValue(state1);

    const tree = renderAct(() =>
      TestRenderer.create(React.createElement(TestHarness)),
    );
    const callCount1 = mockInvoke.mock.calls.filter(
      (c: unknown[]) => (c[0] as { rpcMethod: string }).rpcMethod === "desktopSetTrayMenu",
    ).length;

    mockUseApp.mockReturnValue(
      defaultAppState({
        elizaCloudEnabled: true,
        elizaCloudConnected: true,
        elizaCloudCredits: 5.0,
      }),
    );

    act(() => {
      tree.update(React.createElement(TestHarness));
    });

    const menuCalls = mockInvoke.mock.calls.filter(
      (c: unknown[]) => (c[0] as { rpcMethod: string }).rpcMethod === "desktopSetTrayMenu",
    );
    expect(menuCalls.length).toBeGreaterThan(callCount1);
    const lastCall = menuCalls[menuCalls.length - 1][0] as { params: { menu: unknown } };
    const latestMenu = lastCall.params.menu as Array<{ id: string; label?: string }>;
    expect(getMenuItemById(latestMenu, "cloud-credits")!.label).toContain("$5.00");
  });
});

describe("useMiladyBar — agent status", () => {
  beforeEach(() => {
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
    mockSubscribe.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("shows agent status with running state and green indicator", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      agentStatus: { state: "running", agentName: "TestAgent", startedAt: Date.now() - 60000 },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const status = getMenuItemById(menu, "agent-status");
    expect(status).not.toBeNull();
    expect(status!.label).toContain("TestAgent");
    expect(status!.label).toContain("Running");
    expect(status!.enabled).toBe(false);
  });

  it("shows uptime when agent is running with startedAt", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      agentStatus: { state: "running", agentName: "Milady", startedAt: Date.now() - 7200000 },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const uptime = getMenuItemById(menu, "agent-uptime");
    expect(uptime).not.toBeNull();
    expect(uptime!.label).toContain("Uptime:");
    expect(uptime!.label).toContain("2h");
  });

  it("shows error state with hint", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      agentStatus: { state: "error", agentName: "Milady" },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const status = getMenuItemById(menu, "agent-status");
    expect(status!.label).toContain("Error");
    const hint = getMenuItemById(menu, "agent-error-hint");
    expect(hint).not.toBeNull();
    expect(hint!.label).toContain("Check logs");
  });

  it("shows stopped state when agent is not running", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      agentStatus: { state: "stopped", agentName: "Milady" },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const status = getMenuItemById(menu, "agent-status");
    expect(status!.label).toContain("Stopped");
  });

  it("shows default state when agentStatus is null", () => {
    mockUseApp.mockReturnValue(defaultAppState({ agentStatus: null }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const status = getMenuItemById(menu, "agent-status");
    expect(status!.label).toContain("Milady");
    expect(status!.label).toContain("Not Started");
  });

  it("updates tray tooltip with agent status", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      agentStatus: { state: "running", agentName: "MyAgent" },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const tooltipCalls = mockInvoke.mock.calls.filter(
      (c: unknown[]) => (c[0] as { rpcMethod: string }).rpcMethod === "desktopUpdateTray",
    );
    expect(tooltipCalls.length).toBeGreaterThan(0);
    const lastTooltip = tooltipCalls[tooltipCalls.length - 1][0] as { params: { tooltip: string } };
    expect(lastTooltip.params.tooltip).toContain("MyAgent");
    expect(lastTooltip.params.tooltip).toContain("Running");
  });
});

describe("useMiladyBar — actions and refresh", () => {
  beforeEach(() => {
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
    mockSubscribe.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("Settings action item is present and clickable", () => {
    mockUseApp.mockReturnValue(defaultAppState());
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const settings = getMenuItemById(menu, "open-settings") as Record<string, unknown>;
    expect(settings).not.toBeNull();
    expect(settings.label).toBe("Settings...");
    expect(settings.enabled).toBeUndefined(); // interactive
  });

  it("Refresh Now action item is present and clickable", () => {
    mockUseApp.mockReturnValue(defaultAppState());
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const refresh = getMenuItemById(menu, "refresh-now") as Record<string, unknown>;
    expect(refresh).not.toBeNull();
    expect(refresh.label).toBe("Refresh Now");
    expect(refresh.enabled).toBeUndefined();
  });

  it("subscribes to tray menu click events", () => {
    mockUseApp.mockReturnValue(defaultAppState());
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    expect(mockSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMessage: "desktopTrayMenuClick",
      }),
    );
  });

  it("refresh-now click triggers validated credential re-scan", async () => {
    let capturedListener: ((payload: unknown) => void) | null = null;
    mockSubscribe.mockImplementation((opts: { listener: (payload: unknown) => void }) => {
      capturedListener = opts.listener;
      return vi.fn();
    });
    mockUseApp.mockReturnValue(defaultAppState());
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });

    mockScanAndValidateProviderCredentials.mockClear();
    expect(capturedListener).not.toBeNull();

    await act(async () => {
      capturedListener!({ itemId: "refresh-now" });
    });
    expect(mockScanAndValidateProviderCredentials).toHaveBeenCalled();
  });

  it("open-settings click calls desktopOpenSettingsWindow RPC", async () => {
    let capturedListener: ((payload: unknown) => void) | null = null;
    mockSubscribe.mockImplementation((opts: { listener: (payload: unknown) => void }) => {
      capturedListener = opts.listener;
      return vi.fn();
    });
    mockUseApp.mockReturnValue(defaultAppState());
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    mockInvoke.mockClear();

    await act(async () => {
      capturedListener!({ itemId: "open-settings" });
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ rpcMethod: "desktopOpenSettingsWindow" }),
    );
  });

  it("shows last updated timestamp after scan completes", async () => {
    mockScanProviderCredentials.mockResolvedValue([]);
    mockUseApp.mockReturnValue(defaultAppState());
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenuCall()!;
    const lastUpdated = getMenuItemById(menu, "last-updated");
    expect(lastUpdated).not.toBeNull();
    expect(lastUpdated!.label).toContain("Last updated:");
    expect(lastUpdated!.label).toContain("just now");
    expect(lastUpdated!.enabled).toBe(false);
  });
});

describe("useMiladyBar — provider submenus", () => {
  beforeEach(() => {
    mockUseApp.mockReturnValue(defaultAppState());
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
    mockSubscribe.mockClear();
    mockScanProviderCredentials.mockReset().mockResolvedValue([]);
    mockScanAndValidateProviderCredentials.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  it("provider submenu includes Test Connection and Set as Active", () => {
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenuCall()!;
    const openai = menu.find((i) => i.id === "provider-openai");
    expect(openai!.submenu).toBeDefined();
    const ids = openai!.submenu!.map((s) => s.id);
    expect(ids).toContain("provider-action:openai:set-active");
    expect(ids).toContain("provider-action:openai:test");
  });

  it("detected provider submenu has Enable & Set Active", async () => {
    mockScanProviderCredentials.mockResolvedValue([
      { id: "groq", source: "env", cliInstalled: false, status: "unchecked" },
    ]);
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenuCall()!;
    const groq = menu.find((i) => i.id === "detected-groq");
    expect(groq).not.toBeNull();
    expect(groq!.submenu).toBeDefined();
    const ids = groq!.submenu!.map((s) => s.id);
    expect(ids).toContain("provider-action:groq:enable");
    expect(ids).toContain("provider-action:groq:test");
  });

  it("invalid credential shows Invalid badge in label", async () => {
    mockScanProviderCredentials.mockResolvedValue([
      { id: "groq", source: "env", cliInstalled: false, status: "invalid", statusDetail: "API key rejected" },
    ]);
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenuCall()!;
    const groq = menu.find((i) => i.id === "detected-groq");
    expect(groq!.label).toContain("Invalid");
  });

  it("provider-action:openai:test triggers model fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    let capturedListener: ((payload: unknown) => void) | null = null;
    mockSubscribe.mockImplementation((opts: { listener: (payload: unknown) => void }) => {
      capturedListener = opts.listener;
      return vi.fn();
    });
    mockUseApp.mockReturnValue(defaultAppState());
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });

    await act(async () => {
      capturedListener!({ itemId: "provider-action:openai:test" });
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/models?provider=openai"),
    );
    vi.unstubAllGlobals();
  });
});

function renderAct<T>(fn: () => T): T {
  let result: T;
  act(() => {
    result = fn();
  });
  return result!;
}
