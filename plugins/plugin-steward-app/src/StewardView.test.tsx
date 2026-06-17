// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StewardStatusResponse } from "./types/steward";

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

// Per-test useApp() return value, injected through this mutable holder so the
// hoisted vi.mock factory can read whatever the current test installed.
const appHolder: { current: Record<string, unknown> } = { current: {} };

vi.mock("@elizaos/ui", () => ({
  cn: (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(" "),
  useApp: () => appHolder.current,
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
  Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", props),
  PagePanel: Object.assign(
    ({ children }: { children: React.ReactNode }) =>
      React.createElement("section", {}, children),
    {
      Notice: ({ children }: { children: React.ReactNode }) =>
        React.createElement("div", { role: "alert" }, children),
      Empty: ({ title }: { title: string }) =>
        React.createElement("div", {}, title),
      Toolbar: ({ children }: { children: React.ReactNode }) =>
        React.createElement("div", {}, children),
    },
  ),
  StatusBadge: ({ label }: { label: string }) =>
    React.createElement("span", {}, label),
  statusLabelForState: (state: string) => state,
  statusToneForState: () => "neutral",
}));

import { StewardView } from "./StewardView";

const connectedStatus: StewardStatusResponse = {
  configured: true,
  available: true,
  connected: true,
  baseUrl: "https://steward.example",
  agentId: "agent-alpha",
  evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
  error: null,
  walletAddresses: {
    evm: "0x1234567890abcdef1234567890abcdef12345678",
    solana: null,
  },
  agentName: "eliza",
  vaultHealth: "ok",
};

function installApp(overrides: Record<string, unknown> = {}) {
  appHolder.current = {
    getStewardStatus: vi.fn(async () => connectedStatus),
    getStewardPending: vi.fn(async () => []),
    getStewardHistory: vi.fn(async () => ({
      records: [],
      total: 0,
      offset: 0,
      limit: 25,
    })),
    approveStewardTx: vi.fn(async () => ({ ok: true })),
    rejectStewardTx: vi.fn(async () => ({ ok: true })),
    copyToClipboard: vi.fn(async () => {}),
    setActionNotice: vi.fn(),
    ...overrides,
  };
  return appHolder.current;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  appHolder.current = {};
});

describe("StewardView — connected state", () => {
  it("renders the connected header with truncated address and Connected pill, Approvals default", async () => {
    installApp();
    render(React.createElement(StewardView));

    // Connected pill.
    expect(await screen.findByText("Connected")).toBeTruthy();
    // Truncated EVM address (slice(0,6) + ... + slice(-4)).
    expect(screen.getByText(/0x1234\.\.\.5678/)).toBeTruthy();
    // Default tab is Approvals: the header <h1> reads "Approvals".
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Approvals");
    // Approvals tab is selected.
    const approvalsTab = screen.getByRole("tab", { name: /Approvals/ });
    expect(approvalsTab.getAttribute("aria-selected")).toBe("true");
    // ApprovalQueue child mounted -> its empty state shows.
    expect(await screen.findByText("No pending approvals")).toBeTruthy();
  });

  it("switching to History flips aria-selected, retitles the header, and mounts TransactionHistory", async () => {
    installApp();
    render(React.createElement(StewardView));
    await screen.findByText("Connected");

    const historyTab = screen.getByRole("tab", { name: /History/ });
    await act(async () => {
      fireEvent.click(historyTab);
    });

    expect(historyTab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen
        .getByRole("tab", { name: /Approvals/ })
        .getAttribute("aria-selected"),
    ).toBe("false");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "History",
    );
    // TransactionHistory child mounted -> its empty state shows.
    expect(await screen.findByText("No transactions yet")).toBeTruthy();

    // Switch back to Approvals re-mounts the ApprovalQueue.
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: /Approvals/ }));
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Approvals",
    );
    expect(await screen.findByText("No pending approvals")).toBeTruthy();
  });

  it("shows a pendingCount badge fed from ApprovalQueue.onPendingCountChange", async () => {
    installApp({
      getStewardPending: vi.fn(async () => [
        {
          queueId: "queue-1",
          status: "pending",
          requestedAt: new Date().toISOString(),
          transaction: {
            id: "tx-1",
            agentId: "agent-alpha",
            status: "pending",
            request: {
              agentId: "agent-alpha",
              tenantId: "tenant-1",
              to: "0xfeed000000000000000000000000000000000000",
              value: "1000000000000000000",
              chainId: 1,
            },
            policyResults: [],
            createdAt: new Date().toISOString(),
          },
        },
      ]),
    });
    render(React.createElement(StewardView));

    // The badge inside the Approvals tab shows the pending count "1".
    const approvalsTab = await screen.findByRole("tab", { name: /Approvals/ });
    await screen.findByText("1 ETH");
    expect(approvalsTab.textContent).toContain("1");
  });
});

describe("StewardView — disconnected branch", () => {
  it("renders the disconnected empty state, the env hint, and the error box", async () => {
    installApp({
      getStewardStatus: vi.fn(async () => ({
        configured: false,
        available: false,
        connected: false,
        error: "no creds",
      })),
    });
    render(React.createElement(StewardView));

    expect(await screen.findByText("Steward disconnected")).toBeTruthy();
    expect(screen.getByText("STEWARD_API_URL + STEWARD_API_KEY")).toBeTruthy();
    expect(screen.getByText("no creds")).toBeTruthy();
    // No tablist in the disconnected branch.
    expect(screen.queryByRole("tab")).toBeNull();
  });
});
