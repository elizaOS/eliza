// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { BscTradePanel } from "../../src/components/BscTradePanel";

const VALID_TOKEN = "0x1234567890abcdef1234567890abcdef12345678";

function findByTestId(
  root: TestRenderer.ReactTestInstance,
  testId: string,
): TestRenderer.ReactTestInstance {
  return root.find((node) => node.props["data-testid"] === testId);
}

const mockSetActionNotice = vi.fn();
vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => ({
    t: (_k: string) => "Latest quote",
    setActionNotice: mockSetActionNotice,
    copyToClipboard: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("BscTradePanel", () => {
  it("surfaces preflight failures from the toolbar button", async () => {
    const setActionNotice = mockSetActionNotice;
    const getBscTradePreflight = vi.fn().mockResolvedValue({
      ok: false,
      reasons: ["RPC missing"],
    });

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(BscTradePanel, {
          tradeReady: false,
          bnbBalance: 0,
          trackedTokens: [],
          onAddToken: vi.fn(),

          getBscTradePreflight,
          getBscTradeQuote: vi.fn(),
        }),
      );
    });

    if (!tree) {
      throw new Error("Expected BscTradePanel renderer to be created.");
    }

    const root = tree.root;
    const tokenInput = findByTestId(root, "wallet-quick-token-input");
    await act(async () => {
      tokenInput.props.onChange({ target: { value: VALID_TOKEN } });
    });

    const preflightButton = findByTestId(root, "wallet-token-preflight");
    await act(async () => {
      await preflightButton.props.onClick();
    });

    expect(getBscTradePreflight).toHaveBeenCalledWith(VALID_TOKEN);
    expect(setActionNotice).toHaveBeenCalledWith("RPC missing", "error", 3600);
  });

  it("quotes the current trade inputs from the toolbar button", async () => {
    const _setActionNotice = mockSetActionNotice;
    const getBscTradePreflight = vi.fn().mockResolvedValue({
      ok: true,
      reasons: [],
    });
    const getBscTradeQuote = vi.fn().mockResolvedValue({
      side: "buy",
      tokenAddress: VALID_TOKEN,
      slippageBps: 100,
      quoteIn: { amount: "0.1", symbol: "BNB" },
      quoteOut: { amount: "25", symbol: "TKN" },
      route: [],
    });

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(BscTradePanel, {
          tradeReady: true,
          bnbBalance: 1,
          trackedTokens: [],
          onAddToken: vi.fn(),

          getBscTradePreflight,
          getBscTradeQuote,
        }),
      );
    });

    if (!tree) {
      throw new Error("Expected BscTradePanel renderer to be created.");
    }

    const root = tree.root;
    const tokenInput = findByTestId(root, "wallet-quick-token-input");
    await act(async () => {
      tokenInput.props.onChange({ target: { value: VALID_TOKEN } });
    });

    const amountPreset = findByTestId(root, "wallet-quick-amount-0.1");
    await act(async () => {
      amountPreset.props.onClick();
    });

    const quoteButton = findByTestId(root, "wallet-token-quote");
    await act(async () => {
      await quoteButton.props.onClick();
    });

    expect(getBscTradePreflight).toHaveBeenCalledWith(VALID_TOKEN);
    expect(getBscTradeQuote).toHaveBeenCalledWith({
      side: "buy",
      tokenAddress: VALID_TOKEN,
      amount: "0.1",
    });

    const latestQuoteBlocks = root.findAll(
      (node) =>
        node.type === "div" &&
        node.children.some(
          (child) =>
            typeof child === "string" && child.includes("Latest quote"),
        ),
    );
    expect(latestQuoteBlocks.length).toBeGreaterThan(0);
  });
});
