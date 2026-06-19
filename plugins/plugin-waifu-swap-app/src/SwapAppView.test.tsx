// @vitest-environment jsdom
//
// Render smoke test for SwapAppView. Mounts the real component with mocked
// @elizaos/app-core primitives and a mocked @elizaos/ui/agent-surface hook, then
// asserts the shell mounts, the venue badge renders, a typed amount produces a
// non-zero local-estimate output, and — the load-bearing safety assertion —
// pressing the swap CTA while SWAP_EXECUTE_ENABLED is false surfaces the
// disabled/stubbed outcome and never reaches the network.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PANCAKE_V3_WBNB, type SwapToken } from "./swap-contracts";

// Mock the app-core UI primitives the view renders. Button/PagePanel/Spinner are
// inert DOM stubs; `client` is unused by the view (the swap client uses fetch).
vi.mock("@elizaos/app-core", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
  PagePanel: {
    Notice: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "notice" }, children),
  },
  Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", { "data-testid": "spinner", ...props }),
  client: {},
}));

// Mock the agent-surface hook to inert refs/props so the view mounts without the
// real agent addressability runtime.
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

// fetch stub. The opportunistic quote-upgrade effect may legitimately probe the
// backend `quote` action (it swallows the failure and keeps the local
// estimate); what MUST never happen while execution is disabled is a call to
// the `swap` action. The stub rejects so the quote probe falls back, and the
// test asserts no `/actions/swap` request was ever issued.
const fetchSpy = vi
  .fn<typeof fetch>()
  .mockRejectedValue(new Error("backend not wired in test"));
vi.stubGlobal("fetch", fetchSpy);

function swapActionRequested(): boolean {
  return fetchSpy.mock.calls.some(([input]) =>
    String(input).includes("/actions/swap"),
  );
}

import { SwapAppView } from "./SwapAppView";

// Two non-native tokens with concrete prices so the local estimator yields a
// finite, non-zero output (BNB is auto-added by config but priced 1:1).
const TOKENS: readonly SwapToken[] = [
  {
    address: PANCAKE_V3_WBNB,
    symbol: "BNB",
    decimals: 18,
    priceBnb: 1,
    isNative: true,
  },
  {
    address: "0x2222222222222222222222222222222222222222",
    symbol: "SUKI",
    decimals: 18,
    priceBnb: 0.0001,
  },
];

function baseProps() {
  return {
    exitToApps: vi.fn(),
    uiTheme: "dark" as const,
    t: (key: string) => key,
    agentTokenAddress: "0x3333333333333333333333333333333333333333",
    tokens: TOKENS,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SwapAppView", () => {
  it("mounts the shell and the PancakeSwap v3 venue badge", () => {
    const { container } = render(React.createElement(SwapAppView, baseProps()));
    expect(container.querySelector('[data-testid="swap-shell"]')).toBeTruthy();
    expect(screen.getByText("PancakeSwap v3")).toBeTruthy();
    // Quote-only preview: the CTA reads "preview swap" while execution is off.
    expect(screen.getByText("preview swap")).toBeTruthy();
  });

  it("produces a non-zero local-estimate output for a valid amount", async () => {
    render(React.createElement(SwapAppView, baseProps()));

    const amountField = screen.getByLabelText("Amount in") as HTMLInputElement;
    fireEvent.change(amountField, { target: { value: "10" } });

    // The "to (estimate)" output cell shows the estimated out (10 BNB at 0.0001
    // BNB/token -> ~99,600 SUKI). Assert it left the "0.0" placeholder.
    await waitFor(() => {
      const out = screen.getByText(/99,6/);
      expect(out).toBeTruthy();
    });
  });

  it("surfaces the disabled-execution stub and never hits the network on swap", async () => {
    render(React.createElement(SwapAppView, baseProps()));

    fireEvent.change(screen.getByLabelText("Amount in"), {
      target: { value: "10" },
    });

    // Wait for a quote so the CTA is enabled.
    const cta = await screen.findByText("preview swap");
    const button = cta.closest("button");
    expect(button).toBeTruthy();
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(button as HTMLButtonElement);

    // Disabled outcome is rendered; no transaction "prepared" success appears.
    expect(
      await screen.findByText(/on-chain swap execution is not enabled yet/i),
    ).toBeTruthy();
    expect(screen.queryByText(/transaction prepared/i)).toBeNull();

    // The execution path must not have reached the swap action route.
    expect(swapActionRequested()).toBe(false);
  });
});
