// @vitest-environment jsdom
/**
 * Regression tests for Milady Bar — macOS menu bar tray integration.
 *
 * Locks down tray menu construction edge cases: multi-chain wallets,
 * NaN balances, cloud credit tiers, provider sorting, empty states,
 * agent status transitions, auto-refresh, and credential scanning.
 */
import React from "react";
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
  return React.createElement("div");
}

function renderAct<T>(fn: () => T): T {
  let result: T;
  act(() => { result = fn(); });
  return result!;
}

function getLastMenu(): Array<{ id: string; label?: string; type?: string; enabled?: boolean; submenu?: Array<{ id: string; label?: string; type?: string; enabled?: boolean; checked?: boolean }> }> | null {
  const calls = mockInvoke.mock.calls.filter(
    (c: unknown[]) => (c[0] as { rpcMethod: string }).rpcMethod === "desktopSetTrayMenu",
  );
  if (calls.length === 0) return null;
  const lastCall = calls[calls.length - 1][0] as { params: { menu: unknown } };
  return lastCall.params.menu as Array<{ id: string; label?: string; type?: string; enabled?: boolean }>;
}

function findItem(menu: Array<{ id: string; label?: string }>, id: string) {
  return menu.find((i) => i.id === id) ?? null;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("useMiladyBar regression — wallet edge cases", () => {
  beforeEach(() => {
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("sums across multiple EVM chains and Solana", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      walletBalances: {
        evm: {
          address: "0xabc",
          chains: [
            { chain: "eth", chainId: 1, nativeBalance: "1", nativeSymbol: "ETH", nativeValueUsd: "200.00", tokens: [{ symbol: "USDC", valueUsd: "100.00" }], error: null },
            { chain: "polygon", chainId: 137, nativeBalance: "100", nativeSymbol: "MATIC", nativeValueUsd: "30.00", tokens: [], error: null },
          ],
        },
        solana: { address: "sol", solBalance: "10", solValueUsd: "20.50", tokens: [{ symbol: "RAY", valueUsd: "5.00" }] },
      },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const wallet = findItem(getLastMenu()!, "wallet-balance");
    // 200 + 100 + 30 + 20.50 + 5 = 355.50
    expect(wallet!.label).toContain("355.50");
  });

  it("handles Solana-only (no EVM)", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      walletBalances: {
        evm: null,
        solana: { address: "sol", solBalance: "5", solValueUsd: "125.00", tokens: [] },
      },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    expect(findItem(getLastMenu()!, "wallet-balance")!.label).toContain("$125.00");
  });

  it("handles EVM-only (no Solana)", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      walletBalances: {
        evm: { address: "0x0", chains: [{ chain: "eth", chainId: 1, nativeBalance: "0", nativeSymbol: "ETH", nativeValueUsd: "42.00", tokens: [], error: null }] },
        solana: null,
      },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    expect(findItem(getLastMenu()!, "wallet-balance")!.label).toContain("$42.00");
  });

  it("shows $0.00 for zero balances", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      walletBalances: {
        evm: { address: "0x0", chains: [] },
        solana: { address: "s", solBalance: "0", solValueUsd: "0", tokens: [] },
      },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    expect(findItem(getLastMenu()!, "wallet-balance")!.label).toContain("$0.00");
  });

  it("handles NaN / garbage valueUsd gracefully (defaults to 0)", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      walletBalances: {
        evm: {
          address: "0x0",
          chains: [{ chain: "eth", chainId: 1, nativeBalance: "0", nativeSymbol: "ETH", nativeValueUsd: "garbage", tokens: [{ symbol: "X", valueUsd: "" }], error: null }],
        },
        solana: { address: "s", solBalance: "0", solValueUsd: "NaN", tokens: [] },
      },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    expect(findItem(getLastMenu()!, "wallet-balance")!.label).toContain("$0.00");
  });
});

describe("useMiladyBar regression — cloud credits tiers", () => {
  beforeEach(() => {
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("shows dollar amount when credits are available", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      elizaCloudEnabled: true,
      elizaCloudConnected: true,
      elizaCloudCredits: 0.01,
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    expect(findItem(getLastMenu()!, "cloud-credits")!.label).toContain("$0.01");
  });

  it("shows 'Connected' when credits is null but connected", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      elizaCloudEnabled: true,
      elizaCloudConnected: true,
      elizaCloudCredits: null,
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    expect(findItem(getLastMenu()!, "cloud-credits")!.label).toContain("Connected");
  });

  it("renders when only elizaCloudConnected is true", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      elizaCloudEnabled: false,
      elizaCloudConnected: true,
      elizaCloudCredits: 7.77,
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    expect(findItem(getLastMenu()!, "cloud-credits")!.label).toContain("$7.77");
  });
});

describe("useMiladyBar regression — provider filtering", () => {
  beforeEach(() => {
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("excludes disabled ai-provider plugins", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      plugins: [
        { id: "openai", name: "OpenAI", category: "ai-provider", enabled: true, configured: true },
        { id: "groq", name: "Groq", category: "ai-provider", enabled: false, configured: false },
      ],
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenu()!;
    expect(findItem(menu, "provider-openai")).not.toBeNull();
    expect(findItem(menu, "provider-groq")).toBeNull();
  });

  it("shows no providers section when none are enabled", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      plugins: [
        { id: "streaming-base", name: "Streaming", category: "streaming", enabled: true, configured: true },
      ],
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenu()!;
    expect(findItem(menu, "providers-header")).toBeNull();
  });

  it("excludes connector and streaming category plugins", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      plugins: [
        { id: "openai", name: "OpenAI", category: "ai-provider", enabled: true, configured: true },
        { id: "discord", name: "Discord", category: "connector", enabled: true, configured: true },
        { id: "streaming-base", name: "Streaming", category: "streaming", enabled: true, configured: true },
      ],
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenu()!;
    expect(findItem(menu, "provider-discord")).toBeNull();
    expect(findItem(menu, "provider-streaming-base")).toBeNull();
  });
});

describe("useMiladyBar regression — menu structure", () => {
  beforeEach(() => {
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("menu items are separated by separator types", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      elizaCloudEnabled: true,
      elizaCloudConnected: true,
      elizaCloudCredits: 1.0,
      walletBalances: {
        evm: { address: "0x0", chains: [] },
        solana: { address: "s", solBalance: "0", solValueUsd: "0", tokens: [] },
      },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenu()!;
    const separators = menu.filter((i) => i.type === "separator");
    // agent, providers, cloud, wallet, and between standard actions
    expect(separators.length).toBeGreaterThanOrEqual(6);
  });

  it("Quit is always the last non-separator item", () => {
    mockUseApp.mockReturnValue(defaultAppState());
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenu()!;
    const lastItem = menu[menu.length - 1];
    expect(lastItem.id).toBe("quit");
    expect(lastItem.label).toBe("Quit");
  });

  it("agent status is always the first item", () => {
    mockUseApp.mockReturnValue(defaultAppState());
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenu()!;
    expect(menu[0].id).toBe("agent-status");
  });

  it("Show Milady is always present and clickable", () => {
    mockUseApp.mockReturnValue(defaultAppState());
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenu()!;
    const show = findItem(menu, "show") as Record<string, unknown>;
    expect(show).not.toBeNull();
    expect(show.enabled).toBeUndefined(); // not disabled
  });
});

describe("useMiladyBar regression — credential scan", () => {
  beforeEach(() => {
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
    mockScanProviderCredentials.mockReset().mockResolvedValue([]);
    mockScanAndValidateProviderCredentials.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  it("scan failure (rejected promise) doesn't crash the hook", async () => {
    mockScanProviderCredentials.mockRejectedValue(new Error("scan failed"));
    mockUseApp.mockReturnValue(defaultAppState());
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenu()!;
    expect(findItem(menu, "detected-header")).toBeNull();
    expect(findItem(menu, "show")).not.toBeNull();
  });

  it("empty scan results produce no detected section", async () => {
    mockScanProviderCredentials.mockResolvedValue([]);
    mockUseApp.mockReturnValue(defaultAppState());
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenu()!;
    expect(findItem(menu, "detected-header")).toBeNull();
  });

  it("multiple detected providers from different sources", async () => {
    mockScanProviderCredentials.mockResolvedValue([
      { id: "cohere", source: "env", cliInstalled: false },
      { id: "together", source: "keychain", cliInstalled: false },
      { id: "fireworks", source: "codex-auth", cliInstalled: true },
    ]);
    mockUseApp.mockReturnValue(defaultAppState());
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenu()!;
    expect(findItem(menu, "detected-header")).not.toBeNull();
    expect(findItem(menu, "detected-cohere")!.label).toContain("via Environment");
    expect(findItem(menu, "detected-together")!.label).toContain("via Keychain");
    expect(findItem(menu, "detected-fireworks")!.label).toContain("via Codex CLI");
  });
});

describe("useMiladyBar regression — agent status transitions", () => {
  beforeEach(() => {
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("starting state shows yellow indicator", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      agentStatus: { state: "starting", agentName: "Milady" },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenu()!;
    const status = findItem(menu, "agent-status");
    expect(status!.label).toContain("Starting...");
    // No uptime for non-running state
    expect(findItem(menu, "agent-uptime")).toBeNull();
  });

  it("restarting state shows yellow indicator", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      agentStatus: { state: "restarting", agentName: "Milady" },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const status = findItem(getLastMenu()!, "agent-status");
    expect(status!.label).toContain("Restarting...");
  });

  it("no uptime shown when startedAt is missing", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      agentStatus: { state: "running", agentName: "Milady" },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const menu = getLastMenu()!;
    expect(findItem(menu, "agent-uptime")).toBeNull();
  });

  it("uptime shows minutes for short durations", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      agentStatus: { state: "running", agentName: "Milady", startedAt: Date.now() - 300000 },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const uptime = findItem(getLastMenu()!, "agent-uptime");
    expect(uptime).not.toBeNull();
    expect(uptime!.label).toContain("5m");
  });

  it("tooltip updates for each agent state change", () => {
    mockUseApp.mockReturnValue(defaultAppState({
      agentStatus: { state: "stopped", agentName: "Milady" },
    }));
    renderAct(() => TestRenderer.create(React.createElement(TestHarness)));
    const tooltipCalls = mockInvoke.mock.calls.filter(
      (c: unknown[]) => (c[0] as { rpcMethod: string }).rpcMethod === "desktopUpdateTray",
    );
    expect(tooltipCalls.length).toBeGreaterThan(0);
    const tooltip = (tooltipCalls[tooltipCalls.length - 1][0] as { params: { tooltip: string } }).params.tooltip;
    expect(tooltip).toBe("Milady — Stopped");
  });
});

describe("useMiladyBar regression — auto-refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
    mockScanProviderCredentials.mockReset().mockResolvedValue([]);
    mockScanAndValidateProviderCredentials.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("sets up auto-refresh interval", async () => {
    mockUseApp.mockReturnValue(defaultAppState());
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const initialCalls = mockScanAndValidateProviderCredentials.mock.calls.length;

    // Advance 5 minutes
    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });
    expect(mockScanAndValidateProviderCredentials.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it("cleans up interval on unmount", async () => {
    mockUseApp.mockReturnValue(defaultAppState());
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(TestHarness));
    });

    act(() => {
      tree!.unmount();
    });

    mockScanAndValidateProviderCredentials.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });
    // After unmount, no new scan calls
    expect(mockScanAndValidateProviderCredentials).not.toHaveBeenCalled();
  });
});

describe("useMiladyBar regression — provider actions", () => {
  beforeEach(() => {
    mockIsDesktop.mockReturnValue(true);
    mockInvoke.mockClear();
    mockScanProviderCredentials.mockReset().mockResolvedValue([]);
    mockScanAndValidateProviderCredentials.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  it("provider action with unknown action is a no-op", async () => {
    const mockFetch = vi.fn();
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
      capturedListener!({ itemId: "provider-action:openai:unknown-action" });
    });
    expect(mockFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("validation failure doesn't crash the hook", async () => {
    mockScanAndValidateProviderCredentials.mockRejectedValue(new Error("validation failed"));
    mockUseApp.mockReturnValue(defaultAppState());
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenu()!;
    expect(findItem(menu, "show")).not.toBeNull();
  });

  it("mix of valid/invalid/unchecked renders correctly", async () => {
    mockScanProviderCredentials.mockResolvedValue([
      { id: "groq", source: "env", cliInstalled: false, status: "valid", statusDetail: undefined },
      { id: "mistral", source: "env", cliInstalled: false, status: "invalid", statusDetail: "API key rejected" },
      { id: "together", source: "keychain", cliInstalled: false, status: "unchecked" },
    ]);
    mockUseApp.mockReturnValue(defaultAppState());
    await act(async () => {
      TestRenderer.create(React.createElement(TestHarness));
    });
    const menu = getLastMenu()!;
    const groq = findItem(menu, "detected-groq");
    expect(groq!.label).toContain("Verified");
    const mistral = findItem(menu, "detected-mistral");
    expect(mistral!.label).toContain("Invalid");
    const together = findItem(menu, "detected-together");
    expect(together).not.toBeNull();
    // "unchecked" has empty label so no badge
    expect(together!.label).not.toContain("Verified");
    expect(together!.label).not.toContain("Invalid");
  });
});
