// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props, children),
  PageLayout: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  PagePanel: Object.assign(
    ({ children }: { children: React.ReactNode }) =>
      React.createElement("section", {}, children),
    {
      Notice: ({ children }: { children: React.ReactNode }) =>
        React.createElement("div", {}, children),
      Empty: ({ title }: { title: string }) =>
        React.createElement("div", {}, title),
      Toolbar: ({ children }: { children: React.ReactNode }) =>
        React.createElement("div", {}, children),
    },
  ),
  Sidebar: ({ children }: { children: React.ReactNode }) =>
    React.createElement("aside", {}, children),
  SidebarContent: {
    SectionLabel: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", {}, children),
    Item: ({ children }: { children: React.ReactNode }) =>
      React.createElement("button", {}, children),
    ItemIcon: ({ children }: { children: React.ReactNode }) =>
      React.createElement("span", {}, children),
    ItemBody: ({ children }: { children: React.ReactNode }) =>
      React.createElement("span", {}, children),
    ItemTitle: ({ children }: { children: React.ReactNode }) =>
      React.createElement("span", {}, children),
    ItemDescription: ({ children }: { children: React.ReactNode }) =>
      React.createElement("span", {}, children),
  },
  SidebarPanel: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", props),
  StatusBadge: ({ children }: { children: React.ReactNode }) =>
    React.createElement("span", {}, children),
  statusLabelForState: (state: string) => state,
  statusToneForState: () => "neutral",
  useApp: () => ({}),
}));

import { interact, StewardTuiView } from "./StewardView";

const sampleStatus = {
  configured: true,
  available: true,
  connected: true,
  baseUrl: "https://steward.example",
  agentId: "agent-1",
  evmAddress: "0x1234567890abcdef",
  error: null,
  walletAddresses: { evm: "0x1234567890abcdef", solana: null },
  agentName: "eliza",
  vaultHealth: "ok",
};

const sampleTx = {
  id: "tx-1",
  agentId: "agent-1",
  status: "pending",
  request: {
    agentId: "agent-1",
    tenantId: "tenant-1",
    to: "0xfeed000000000000000000000000000000000000",
    value: "1000000000000000000",
    chainId: 8453,
  },
  policyResults: [],
  createdAt: "2026-05-18T12:00:00.000Z",
};

const samplePending = [
  {
    queueId: "queue-1",
    status: "pending",
    requestedAt: "2026-05-18T12:00:00.000Z",
    transaction: sampleTx,
  },
];

const sampleHistory = {
  records: [sampleTx],
  total: 1,
  offset: 0,
  limit: 25,
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/wallet/steward-status")
        return jsonResponse(sampleStatus);
      if (url === "/api/wallet/steward-pending-approvals") {
        return jsonResponse(samplePending);
      }
      if (url.startsWith("/api/wallet/steward-tx-records")) {
        return jsonResponse(sampleHistory);
      }
      if (url === "/api/wallet/steward-approve-tx" && init?.method === "POST") {
        return jsonResponse({ ok: true, txHash: "0xapproved" });
      }
      if (url === "/api/wallet/steward-deny-tx" && init?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: `Unexpected ${url}` }, { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("StewardTuiView", () => {
  it("mounts status, pending approvals, history, and TUI metadata", async () => {
    mockFetch();

    const { container } = render(React.createElement(StewardTuiView));

    await screen.findByText("tx-1 / pending");
    expect(screen.getByText(/0x1234567890abcdef/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/wallet/steward-status");

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "steward",
      connected: true,
      configured: true,
      available: true,
      evmAddress: "0x1234567890abcdef",
      pendingCount: 1,
      historyCount: 1,
    });
  });

  it("supports terminal capabilities for state, pending, history, approve, and deny", async () => {
    mockFetch();

    await expect(interact("terminal-steward-state")).resolves.toMatchObject({
      viewType: "tui",
      status: sampleStatus,
      pending: samplePending,
      history: sampleHistory,
    });

    await expect(interact("terminal-steward-pending")).resolves.toEqual({
      viewType: "tui",
      pending: samplePending,
    });

    await expect(
      interact("terminal-steward-history", { status: "pending", limit: 5 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      history: sampleHistory,
    });

    await expect(
      interact("terminal-steward-approve", { txId: "tx-1" }),
    ).resolves.toEqual({
      viewType: "tui",
      result: { ok: true, txHash: "0xapproved" },
    });

    await expect(
      interact("terminal-steward-deny", {
        txId: "tx-1",
        reason: "Rejected by operator",
      }),
    ).resolves.toEqual({
      viewType: "tui",
      result: { ok: true },
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/wallet/steward-deny-tx",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          txId: "tx-1",
          reason: "Rejected by operator",
        }),
      }),
    );
  });
});
