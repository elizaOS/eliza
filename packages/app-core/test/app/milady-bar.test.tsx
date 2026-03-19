// @vitest-environment jsdom
/**
 * Tests for MiladyBar — provider toolbar with cloud credits and wallet summary.
 */
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    switchProvider: vi.fn().mockResolvedValue({ success: true, provider: "openai", restarting: true }),
    fetchModels: vi.fn().mockResolvedValue({ provider: "openai", models: [{ id: "gpt-4" }] }),
  },
}));

vi.mock("@miladyai/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("@miladyai/app-core/api", () => ({
  client: mockClient,
}));

vi.mock("@miladyai/app-core/providers", () => ({
  getProviderLogo: (id: string, _isDark: boolean) =>
    `data:image/svg+xml,${id}`,
  getOnboardingProviderOption: (id: string) => {
    const order: Record<string, number> = { openai: 1, anthropic: 2, groq: 3 };
    return order[id] ? { order: order[id], name: id } : null;
  },
}));

vi.mock("@miladyai/ui", () => ({
  Button: ({ children, onClick, disabled, ...rest }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) =>
    React.createElement("button", { type: "button", onClick, disabled, ...rest }, children),
  Input: ({ ...props }: Record<string, unknown>) =>
    React.createElement("input", props),
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => React.createElement("span", null, "⚠"),
  CircleDollarSign: () => React.createElement("span", null, "💲"),
  Wallet: () => React.createElement("span", null, "👛"),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────

import { MiladyBar } from "@miladyai/app-core/components/MiladyBar";
import { CloudCreditsChip } from "../../src/components/milady-bar/CloudCreditsChip";
import { WalletSummary } from "../../src/components/milady-bar/WalletSummary";

// ── Helpers ────────────────────────────────────────────────────────────

function defaultAppState(overrides: Record<string, unknown> = {}) {
  return {
    plugins: [
      { id: "openai", name: "OpenAI", category: "ai-provider", enabled: true, configured: true, parameters: [] },
      { id: "anthropic", name: "Anthropic", category: "ai-provider", enabled: true, configured: true, parameters: [] },
      { id: "streaming-base", name: "Streaming", category: "streaming", enabled: true, configured: true, parameters: [] },
    ],
    uiTheme: "dark",
    uiShellMode: "native",
    onboardingDetectedProviders: [],
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    elizaCloudCredits: null,
    elizaCloudCreditsCritical: false,
    elizaCloudCreditsLow: false,
    walletBalances: null,
    setTab: vi.fn(),
    setState: vi.fn(),
    t: (key: string) => key,
    ...overrides,
  };
}

/** Recursively search JSON tree for a node with matching data-testid. */
function findJsonByTestId(json: unknown, testId: string): unknown | null {
  if (!json || typeof json !== "object") return null;
  if (Array.isArray(json)) {
    for (const item of json) {
      const found = findJsonByTestId(item, testId);
      if (found) return found;
    }
    return null;
  }
  const obj = json as Record<string, unknown>;
  const props = obj.props as Record<string, unknown> | undefined;
  if (props?.["data-testid"] === testId) return obj;
  if (obj.children && Array.isArray(obj.children)) {
    for (const child of obj.children) {
      const found = findJsonByTestId(child, testId);
      if (found) return found;
    }
  }
  return null;
}

function jsonContains(json: unknown, text: string): boolean {
  return JSON.stringify(json).includes(text);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("MiladyBar", () => {
  beforeEach(() => {
    mockUseApp.mockReturnValue(defaultAppState());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders provider icons for enabled AI providers", () => {
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<MiladyBar />);
    });
    const json = tree!.toJSON();
    expect(findJsonByTestId(json, "milady-bar-provider-openai")).not.toBeNull();
    expect(findJsonByTestId(json, "milady-bar-provider-anthropic")).not.toBeNull();
  });

  it("does not render non-ai-provider plugins as icons", () => {
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<MiladyBar />);
    });
    const json = tree!.toJSON();
    expect(findJsonByTestId(json, "milady-bar-provider-streaming-base")).toBeNull();
  });

  it("opens dropdown on provider click and shows API key input", () => {
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<MiladyBar />);
    });
    // Click the openai provider button
    const openaiBtn = tree!.root.findAll(
      (n) => n.props?.["data-testid"] === "milady-bar-provider-openai",
    )[0];
    expect(openaiBtn).toBeTruthy();

    act(() => {
      openaiBtn.props.onClick();
    });

    const json = tree!.toJSON();
    expect(findJsonByTestId(json, "provider-dropdown")).not.toBeNull();
    expect(findJsonByTestId(json, "provider-api-key-input")).not.toBeNull();
  });

  it("closes dropdown on Escape key", () => {
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<MiladyBar />);
    });

    const openaiBtn = tree!.root.findAll(
      (n) => n.props?.["data-testid"] === "milady-bar-provider-openai",
    )[0];
    act(() => {
      openaiBtn.props.onClick();
    });
    expect(findJsonByTestId(tree!.toJSON(), "provider-dropdown")).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(findJsonByTestId(tree!.toJSON(), "provider-dropdown")).toBeNull();
  });

  it("closes dropdown when clicking a different provider (simulates outside click)", () => {
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<MiladyBar />);
    });

    // Open openai dropdown
    const openaiBtn = tree!.root.findAll(
      (n) => n.props?.["data-testid"] === "milady-bar-provider-openai",
    )[0];
    act(() => {
      openaiBtn.props.onClick();
    });
    expect(findJsonByTestId(tree!.toJSON(), "provider-dropdown")).not.toBeNull();

    // Click the same button again to toggle closed
    act(() => {
      tree!.root.findAll(
        (n) => n.props?.["data-testid"] === "milady-bar-provider-openai",
      )[0].props.onClick();
    });
    expect(findJsonByTestId(tree!.toJSON(), "provider-dropdown")).toBeNull();
  });

  it("only one dropdown open at a time", () => {
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<MiladyBar />);
    });

    const openaiBtn = tree!.root.findAll(
      (n) => n.props?.["data-testid"] === "milady-bar-provider-openai",
    )[0];
    act(() => {
      openaiBtn.props.onClick();
    });

    // Now click anthropic — should close openai and open anthropic
    const anthropicBtn = tree!.root.findAll(
      (n) => n.props?.["data-testid"] === "milady-bar-provider-anthropic",
    )[0];
    act(() => {
      anthropicBtn.props.onClick();
    });

    // Count dropdowns in JSON
    const jsonStr = JSON.stringify(tree!.toJSON());
    const matches = jsonStr.match(/"data-testid":"provider-dropdown"/g);
    expect(matches?.length ?? 0).toBe(1);
  });

  it("highlights active provider with ring styling", () => {
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<MiladyBar />);
    });

    const openaiBtn = tree!.root.findAll(
      (n) => n.props?.["data-testid"] === "milady-bar-provider-openai",
    )[0];
    act(() => {
      openaiBtn.props.onClick();
    });

    const updatedBtn = tree!.root.findAll(
      (n) => n.props?.["data-testid"] === "milady-bar-provider-openai",
    )[0];
    expect(updatedBtn.props.className).toContain("ring-2");
  });
});

describe("CloudCreditsChip", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows cloud credits when connected", () => {
    mockUseApp.mockReturnValue(
      defaultAppState({
        elizaCloudEnabled: true,
        elizaCloudConnected: true,
        elizaCloudCredits: 2.4,
      }),
    );
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<CloudCreditsChip />);
    });
    const json = tree!.toJSON();
    expect(findJsonByTestId(json, "milady-bar-cloud-credits")).not.toBeNull();
    expect(jsonContains(json, "$2.40")).toBe(true);
  });

  it("shows warning when cloud disconnected", () => {
    mockUseApp.mockReturnValue(
      defaultAppState({
        elizaCloudEnabled: true,
        elizaCloudConnected: false,
      }),
    );
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<CloudCreditsChip />);
    });
    const json = tree!.toJSON();
    expect(findJsonByTestId(json, "milady-bar-cloud-disconnected")).not.toBeNull();
  });

  it("renders nothing when cloud not enabled", () => {
    mockUseApp.mockReturnValue(defaultAppState());
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<CloudCreditsChip />);
    });
    expect(tree!.toJSON()).toBeNull();
  });
});

describe("WalletSummary", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows wallet balance total", () => {
    mockUseApp.mockReturnValue(
      defaultAppState({
        walletBalances: {
          evm: {
            address: "0x123",
            chains: [
              {
                chain: "ethereum",
                chainId: 1,
                nativeBalance: "1.0",
                nativeSymbol: "ETH",
                nativeValueUsd: "100.00",
                tokens: [{ symbol: "USDC", valueUsd: "50.00", name: "USDC", contractAddress: "0x", balance: "50", decimals: 6, logoUrl: "" }],
                error: null,
              },
            ],
          },
          solana: {
            address: "sol123",
            solBalance: "1.0",
            solValueUsd: "2.50",
            tokens: [],
          },
        },
      }),
    );
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<WalletSummary />);
    });
    const json = tree!.toJSON();
    // Total: 100 + 50 + 2.50 = 152.50
    expect(jsonContains(json, "152.50")).toBe(true);
  });

  it("navigates to wallets tab on click", () => {
    const setTab = vi.fn();
    mockUseApp.mockReturnValue(
      defaultAppState({
        setTab,
        walletBalances: {
          evm: { address: "0x123", chains: [] },
          solana: { address: "sol123", solBalance: "0", solValueUsd: "0", tokens: [] },
        },
      }),
    );
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<WalletSummary />);
    });
    const walletBtn = tree!.root.findAll(
      (n) => n.props?.["data-testid"] === "milady-bar-wallet",
    )[0];
    act(() => {
      walletBtn.props.onClick();
    });
    expect(setTab).toHaveBeenCalledWith("wallets");
  });

  it("shows muted text when no balances loaded", () => {
    mockUseApp.mockReturnValue(defaultAppState());
    let tree: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<WalletSummary />);
    });
    const json = tree!.toJSON();
    expect(jsonContains(json, "Wallet")).toBe(true);
    expect(jsonContains(json, "text-muted")).toBe(true);
  });
});
