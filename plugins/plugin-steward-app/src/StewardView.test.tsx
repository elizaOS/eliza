// @vitest-environment jsdom

// Drives the unified StewardView (the single GUI/XR/TUI data wrapper) through
// the rendered DOM: the same component the bundle exports for every modality.
// The wrapper owns the live vault data (status, pending approvals, history) read
// through the app-store accessors and renders the one presentational
// StewardSpatialView, whose Buttons carry `data-agent-id`s. Clicking those
// buttons asserts the wrapper wires each affordance to the store —
// approve/reject/copy, the Approvals/History tabs, refresh, the status/chain
// filters, and pagination — plus the terminal `interact` capabilities
// (state/pending/history/approve/deny). Functional parity with the retired
// hand-written StewardTuiView surface.

import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StewardPendingApproval,
  StewardStatusResponse,
  StewardTxRecord,
} from "./types/steward";

configure({ asyncUtilTimeout: 5000 });

// The wrapper reads its store accessors through useAppSelectorShallow; install
// the per-test store through this mutable holder so the hoisted vi.mock factory
// reads whatever the current test set up. The spatial primitives and
// SpatialSurface (@elizaos/ui/spatial) are intentionally NOT mocked so the real
// data-agent-id DOM is exercised.
const appHolder: { current: Record<string, unknown> } = { current: {} };

vi.mock("@elizaos/ui", () => ({
  useAppSelectorShallow: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(appHolder.current),
}));

import { StewardView } from "./StewardView";
import { interact } from "./StewardView.interact";

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

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

const sampleTx: StewardTxRecord = {
  id: "tx-1",
  agentId: "agent-alpha",
  status: "confirmed",
  request: {
    agentId: "agent-alpha",
    tenantId: "tenant-1",
    to: "0xfeed000000000000000000000000000000000000",
    value: "1000000000000000000",
    chainId: 8453,
  },
  policyResults: [],
  createdAt: "2026-05-18T12:00:00.000Z",
  txHash: "0xhash000000000000000000000000000000000000",
};

const samplePending: StewardPendingApproval[] = [
  {
    queueId: "queue-1",
    status: "pending",
    requestedAt: "2026-05-18T12:00:00.000Z",
    transaction: { ...sampleTx, id: "tx-1", status: "pending" },
  },
];

function installApp(overrides: Record<string, unknown> = {}) {
  appHolder.current = {
    getStewardStatus: vi.fn(async () => connectedStatus),
    getStewardPending: vi.fn(async () => samplePending),
    getStewardHistory: vi.fn(async () => ({
      records: [sampleTx],
      total: 1,
      offset: 0,
      limit: 200,
    })),
    approveStewardTx: vi.fn(async () => ({ ok: true, txHash: "0xapproved" })),
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
  vi.unstubAllGlobals();
  appHolder.current = {};
});

describe("StewardView — connected wrapper", () => {
  it("loads status, pending approvals, and history on mount and renders the rows", async () => {
    const app = installApp();
    render(React.createElement(StewardView));

    await screen.findByText(/connected/);
    // Pending approval row mounted (default Approvals tab).
    await waitFor(() => expect(agent("approve-queue-1")).toBeTruthy());
    expect(agent("reject-queue-1")).toBeTruthy();
    // Truncated EVM address (slice(0,6) + ".." + slice(-4)) — shown in both the
    // card header and the approvals status line.
    expect(screen.getAllByText(/0x1234\.\.5678/).length).toBeGreaterThan(0);

    expect(app.getStewardStatus).toHaveBeenCalledTimes(1);
    expect(app.getStewardPending).toHaveBeenCalledTimes(1);
    expect(app.getStewardHistory).toHaveBeenCalledTimes(1);
  });

  it("clicking Approve passes the tx id to approveStewardTx and removes the row", async () => {
    const app = installApp();
    render(React.createElement(StewardView));
    await waitFor(() => expect(agent("approve-queue-1")).toBeTruthy());

    await act(async () => {
      fireEvent.click(agent("approve-queue-1"));
    });

    await waitFor(() =>
      expect(app.approveStewardTx).toHaveBeenCalledWith("tx-1"),
    );
    expect(app.setActionNotice).toHaveBeenCalledWith(
      "Transaction approved",
      "success",
      3000,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-agent-id="approve-queue-1"]'),
      ).toBeNull(),
    );
  });

  it("clicking Reject passes the tx id to rejectStewardTx and removes the row", async () => {
    const app = installApp();
    render(React.createElement(StewardView));
    await waitFor(() => expect(agent("reject-queue-1")).toBeTruthy());

    await act(async () => {
      fireEvent.click(agent("reject-queue-1"));
    });

    await waitFor(() =>
      expect(app.rejectStewardTx).toHaveBeenCalledWith("tx-1"),
    );
    expect(app.setActionNotice).toHaveBeenCalledWith(
      "Transaction rejected",
      "info",
      3000,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-agent-id="reject-queue-1"]'),
      ).toBeNull(),
    );
  });

  it("clicking Copy on a pending row copies the destination address", async () => {
    const app = installApp();
    render(React.createElement(StewardView));
    await waitFor(() => expect(agent("copy-queue-1")).toBeTruthy());

    await act(async () => {
      fireEvent.click(agent("copy-queue-1"));
    });

    await waitFor(() =>
      expect(app.copyToClipboard).toHaveBeenCalledWith(
        "0xfeed000000000000000000000000000000000000",
      ),
    );
    expect(app.setActionNotice).toHaveBeenCalledWith(
      "Address copied",
      "success",
      2000,
    );
  });

  it("the History tab mounts the history rows with filters and pagination controls", async () => {
    installApp();
    render(React.createElement(StewardView));
    await waitFor(() => expect(agent("tab-history")).toBeTruthy());

    await act(async () => {
      fireEvent.click(agent("tab-history"));
    });

    // History tab affordances appear: status/chain filters + prev/next paging.
    await waitFor(() => expect(agent("filter-status")).toBeTruthy());
    expect(agent("filter-chain")).toBeTruthy();
    expect(agent("page-prev")).toBeTruthy();
    expect(agent("page-next")).toBeTruthy();
    // The history row for tx-1 is rendered with its copy control.
    expect(agent("copy-tx-1")).toBeTruthy();
  });

  it("cycling the status filter re-runs getStewardHistory with the next status", async () => {
    const app = installApp();
    render(React.createElement(StewardView));
    await waitFor(() => expect(agent("tab-history")).toBeTruthy());
    await act(async () => {
      fireEvent.click(agent("tab-history"));
    });
    await waitFor(() => expect(agent("filter-status")).toBeTruthy());

    const before = (app.getStewardHistory as ReturnType<typeof vi.fn>).mock.calls
      .length;
    await act(async () => {
      fireEvent.click(agent("filter-status"));
    });
    // The first non-null status in STATUS_CYCLE is "pending".
    await waitFor(() =>
      expect(app.getStewardHistory).toHaveBeenCalledWith(
        expect.objectContaining({ status: "pending" }),
      ),
    );
    expect(
      (app.getStewardHistory as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(before);
  });

  it("the Refresh control re-runs the status/pending/history load", async () => {
    const app = installApp();
    render(React.createElement(StewardView));
    await waitFor(() => expect(agent("refresh")).toBeTruthy());
    expect(app.getStewardStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(agent("refresh"));
    });

    await waitFor(() =>
      expect(app.getStewardStatus).toHaveBeenCalledTimes(2),
    );
  });
});

describe("StewardView — disconnected branch", () => {
  it("renders the disconnected hint without pending/history rows or paging controls", async () => {
    installApp({
      getStewardStatus: vi.fn(async () => ({
        configured: false,
        available: false,
        connected: false,
        error: "no creds",
      })),
      getStewardPending: vi.fn(async () => []),
      getStewardHistory: vi.fn(async () => ({
        records: [],
        total: 0,
        offset: 0,
        limit: 200,
      })),
    });
    render(React.createElement(StewardView));

    await screen.findByText(/not-connected/);
    expect(
      screen.getByText(/Set STEWARD_API_URL and STEWARD_API_KEY/),
    ).toBeTruthy();
    expect(screen.getByText("no creds")).toBeTruthy();
    expect(
      document.querySelector('[data-agent-id^="approve-"]'),
    ).toBeNull();
  });
});

describe("StewardView — terminal interact capabilities", () => {
  function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const interactStatus: StewardStatusResponse = { ...connectedStatus };
  const interactPending = samplePending;
  const interactHistory = { records: [sampleTx], total: 1, offset: 0, limit: 25 };

  function mockFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/wallet/steward-status")
          return jsonResponse(interactStatus);
        if (url === "/api/wallet/steward-pending-approvals")
          return jsonResponse(interactPending);
        if (url.startsWith("/api/wallet/steward-tx-records"))
          return jsonResponse(interactHistory);
        if (url === "/api/wallet/steward-approve-tx" && init?.method === "POST")
          return jsonResponse({ ok: true, txHash: "0xapproved" });
        if (url === "/api/wallet/steward-deny-tx" && init?.method === "POST")
          return jsonResponse({ ok: true });
        return jsonResponse({ error: `Unexpected ${url}` }, { status: 404 });
      }),
    );
  }

  it("serves state, pending, history, approve, and deny over the loopback API", async () => {
    mockFetch();

    await expect(interact("terminal-steward-state")).resolves.toMatchObject({
      viewType: "tui",
      status: interactStatus,
      pending: interactPending,
      history: interactHistory,
    });

    await expect(interact("terminal-steward-pending")).resolves.toEqual({
      viewType: "tui",
      pending: interactPending,
    });

    await expect(
      interact("terminal-steward-history", { status: "pending", limit: 5 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      history: interactHistory,
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

  it("rejects an unsupported capability", async () => {
    mockFetch();
    await expect(interact("nope")).rejects.toThrow(/Unsupported capability/);
  });
});
