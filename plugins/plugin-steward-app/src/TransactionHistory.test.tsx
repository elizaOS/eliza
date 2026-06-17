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

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("@elizaos/ui", () => ({
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
  StatusBadge: ({ label }: { label: string; tone?: string }) =>
    React.createElement("span", { "data-testid": "status-badge" }, label),
  statusLabelForState: (state: string) => `status:${state}`,
  statusToneForState: () => "neutral",
}));

import { TransactionHistory } from "./TransactionHistory";
import type { StewardTxRecord, StewardTxStatus } from "./types/steward";

function makeRecord(
  i: number,
  overrides: Partial<{
    status: StewardTxStatus;
    chainId: number;
    txHash?: string;
    value: string;
    to: string;
  }> = {},
): StewardTxRecord {
  return {
    id: `tx-${i}`,
    agentId: "agent-alpha",
    status: overrides.status ?? "confirmed",
    request: {
      agentId: "agent-alpha",
      tenantId: "tenant-1",
      to: overrides.to ?? `0xto${String(i).padStart(38, "0")}`,
      value: overrides.value ?? "1000000000000000000",
      chainId: overrides.chainId ?? 1,
    },
    txHash: overrides.txHash,
    policyResults: [],
    // createdAt as ISO string; newer records get later timestamps.
    createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TransactionHistory — populated rows", () => {
  it("renders StatusBadge, formatted amount, To, chain, and explorer link vs em-dash", async () => {
    const records = [
      makeRecord(1, {
        status: "confirmed",
        chainId: 1,
        txHash: "0xhash1234567890",
        value: "1000000000000000000",
        to: "0xAbCdEf0123456789abcdef0123456789AbCdEf01",
      }),
      makeRecord(2, {
        status: "pending",
        chainId: 8453,
        value: "500000000000000000",
        // no txHash -> em-dash
      }),
    ];
    const getStewardHistory = vi.fn(async () => ({
      records,
      total: records.length,
      offset: 0,
      limit: 25,
    }));
    render(
      React.createElement(TransactionHistory, {
        getStewardHistory,
        copyToClipboard: vi.fn(async () => {}),
        setActionNotice: vi.fn(),
      }),
    );

    // StatusBadge label via statusLabelForState.
    expect(await screen.findByText("status:confirmed")).toBeTruthy();
    expect(screen.getByText("status:pending")).toBeTruthy();
    // Formatted amounts.
    expect(screen.getByText("1 ETH")).toBeTruthy();
    expect(screen.getByText("0.5 ETH")).toBeTruthy();
    // Chain names appear in the row cells (the filter <select> also lists them
    // as <option>s, so scope to <td> cells).
    const cellChainNames = screen
      .getAllByText(/^(Ethereum|Base)$/)
      .filter((el) => el.closest("td"));
    expect(cellChainNames.map((el) => el.textContent).sort()).toEqual([
      "Base",
      "Ethereum",
    ]);
    // Explorer link for the record that has a txHash.
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "https://etherscan.io/tx/0xhash1234567890",
    );
    // The hash-less record renders an em-dash.
    expect(screen.getByText("—")).toBeTruthy();
    // Transaction count label.
    expect(screen.getByText("2 transactions")).toBeTruthy();
  });

  it("renders the empty state when there are no records", async () => {
    const getStewardHistory = vi.fn(async () => ({
      records: [],
      total: 0,
      offset: 0,
      limit: 25,
    }));
    render(
      React.createElement(TransactionHistory, {
        getStewardHistory,
        copyToClipboard: vi.fn(async () => {}),
        setActionNotice: vi.fn(),
      }),
    );
    expect(await screen.findByText("No transactions yet")).toBeTruthy();
  });

  it("renders an error notice when the fetch rejects", async () => {
    const getStewardHistory = vi.fn(async () => {
      throw new Error("history fetch failed");
    });
    render(
      React.createElement(TransactionHistory, {
        getStewardHistory,
        copyToClipboard: vi.fn(async () => {}),
        setActionNotice: vi.fn(),
      }),
    );
    expect(await screen.findByText("history fetch failed")).toBeTruthy();
  });
});

describe("TransactionHistory — interactive controls", () => {
  it("Status filter refetches with the chosen status and resets to page 1", async () => {
    const getStewardHistory = vi.fn(async () => ({
      records: [makeRecord(1, { status: "confirmed" })],
      total: 1,
      offset: 0,
      limit: 25,
    }));
    render(
      React.createElement(TransactionHistory, {
        getStewardHistory,
        copyToClipboard: vi.fn(async () => {}),
        setActionNotice: vi.fn(),
      }),
    );
    await screen.findByText("status:confirmed");

    const statusSelect = screen.getByLabelText("Status filter");
    await act(async () => {
      fireEvent.change(statusSelect, { target: { value: "pending" } });
    });

    expect(
      getStewardHistory.mock.calls.some(
        (call) => call[0]?.status === "pending",
      ),
    ).toBe(true);
  });

  it("Chain filter narrows the rows client-side without refetching", async () => {
    const records = [
      makeRecord(1, { chainId: 1, txHash: "0xeth" }),
      makeRecord(2, { chainId: 8453, txHash: "0xbase" }),
      makeRecord(3, { chainId: 8453, txHash: "0xbase2" }),
    ];
    const getStewardHistory = vi.fn(async () => ({
      records,
      total: records.length,
      offset: 0,
      limit: 25,
    }));
    render(
      React.createElement(TransactionHistory, {
        getStewardHistory,
        copyToClipboard: vi.fn(async () => {}),
        setActionNotice: vi.fn(),
      }),
    );
    await screen.findByText("3 transactions");
    const callsBefore = getStewardHistory.mock.calls.length;

    const chainSelect = screen.getByLabelText("Chain filter");
    await act(async () => {
      fireEvent.change(chainSelect, { target: { value: "8453" } });
    });

    // Client-side filter -> only the 2 Base rows remain, no extra refetch.
    expect(await screen.findByText("2 transactions")).toBeTruthy();
    expect(getStewardHistory.mock.calls.length).toBe(callsBefore);
  });

  it("paginates 25 per page with Next/Previous and bound-disabling", async () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      makeRecord(i + 1, { txHash: `0xhash${i}` }),
    );
    const getStewardHistory = vi.fn(async () => ({
      records,
      total: records.length,
      offset: 0,
      limit: 25,
    }));
    render(
      React.createElement(TransactionHistory, {
        getStewardHistory,
        copyToClipboard: vi.fn(async () => {}),
        setActionNotice: vi.fn(),
      }),
    );
    await screen.findByText("30 transactions");

    // 30 records / 25 per page -> page 1 of 2.
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    const prev = screen.getByRole("button", { name: "Previous page" });
    const next = screen.getByRole("button", { name: "Next page" });
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(next);
    });

    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Previous page",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    });
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
  });

  it("Refresh re-invokes getStewardHistory", async () => {
    const getStewardHistory = vi.fn(async () => ({
      records: [makeRecord(1)],
      total: 1,
      offset: 0,
      limit: 25,
    }));
    render(
      React.createElement(TransactionHistory, {
        getStewardHistory,
        copyToClipboard: vi.fn(async () => {}),
        setActionNotice: vi.fn(),
      }),
    );
    await screen.findByText("1 transaction");
    const callsBefore = getStewardHistory.mock.calls.length;

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh transactions" }),
      );
    });
    expect(getStewardHistory.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("copy-address button copies the destination address", async () => {
    const addr = "0xAbCdEf0123456789abcdef0123456789AbCdEf01";
    const copyToClipboard = vi.fn(async () => {});
    const setActionNotice = vi.fn();
    const getStewardHistory = vi.fn(async () => ({
      records: [makeRecord(1, { to: addr, txHash: "0xh" })],
      total: 1,
      offset: 0,
      limit: 25,
    }));
    render(
      React.createElement(TransactionHistory, {
        getStewardHistory,
        copyToClipboard,
        setActionNotice,
      }),
    );
    await screen.findByText("1 transaction");

    // The To control is a <button title={fullAddress}>.
    const copyBtn = screen.getByTitle(addr);
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(copyToClipboard).toHaveBeenCalledWith(addr);
    expect(setActionNotice).toHaveBeenCalledWith(
      "Address copied",
      "success",
      2000,
    );
  });
});
