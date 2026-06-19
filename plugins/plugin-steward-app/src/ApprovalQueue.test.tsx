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

// Components import useAgentElement from the @elizaos/ui/agent-surface subpath;
// the primitives (Button/PagePanel/Spinner) come from the bare @elizaos/ui.
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
}));

import { ApprovalQueue } from "./ApprovalQueue";
import type { StewardPendingApproval } from "./types/steward";

function makeApproval(
  overrides: Partial<StewardPendingApproval> & {
    id?: string;
    to?: string;
    value?: string;
    chainId?: number;
  } = {},
): StewardPendingApproval {
  const id = overrides.id ?? "tx-1";
  return {
    queueId: `queue-${id}`,
    status: "pending",
    requestedAt: new Date().toISOString(),
    transaction: {
      id,
      agentId: "agent-alpha",
      status: "pending",
      request: {
        agentId: "agent-alpha",
        tenantId: "tenant-1",
        to: overrides.to ?? "0xfeed000000000000000000000000000000000000",
        value: overrides.value ?? "1000000000000000000",
        chainId: overrides.chainId ?? 1,
      },
      policyResults: [],
      createdAt: new Date().toISOString(),
    },
  };
}

function makeProps(items: StewardPendingApproval[]) {
  return {
    getStewardPending: vi.fn(async () => items),
    approveStewardTx: vi.fn(async () => ({ ok: true, txHash: "0xapproved" })),
    rejectStewardTx: vi.fn(async () => ({ ok: true })),
    copyToClipboard: vi.fn(async () => {}),
    setActionNotice: vi.fn(),
    onPendingCountChange: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ApprovalQueue — populated data", () => {
  it("renders per-tx amount, chain name, truncated To, and policy-reason box", async () => {
    const item = makeApproval({
      id: "tx-1",
      to: "0xAbCdEf0123456789abcdef0123456789AbCdEf01",
      value: "1000000000000000000",
      chainId: 1,
    });
    item.transaction.policyResults = [
      {
        status: "rejected",
        reason: "Recipient not on allowlist",
      } as never,
    ];
    const props = makeProps([item]);

    render(React.createElement(ApprovalQueue, props));

    // Formatted amount (18-decimal ETH on Ethereum mainnet).
    expect(await screen.findByText("1 ETH")).toBeTruthy();
    // Chain name from getChainName(1).
    expect(screen.getByText("Ethereum")).toBeTruthy();
    // Truncated destination address (truncateAddress default 6 chars).
    expect(screen.getByText("0xAbCdEf…CdEf01")).toBeTruthy();
    // Policy-reason box only renders for status rejected|pending.
    expect(screen.getByText("Recipient not on allowlist")).toBeTruthy();
    // Pending count badge.
    expect(props.onPendingCountChange).toHaveBeenCalledWith(1);
  });

  it("shows the empty state when there are no pending approvals", async () => {
    const props = makeProps([]);
    render(React.createElement(ApprovalQueue, props));
    expect(await screen.findByText("No pending approvals")).toBeTruthy();
  });

  it("shows an error notice when loading fails", async () => {
    const props = makeProps([]);
    props.getStewardPending = vi.fn(async () => {
      throw new Error("vault offline");
    });
    render(React.createElement(ApprovalQueue, props));
    expect(await screen.findByText("vault offline")).toBeTruthy();
  });
});

describe("ApprovalQueue — interactive controls", () => {
  it("Approve removes the item, fires success notice, decrements count", async () => {
    const props = makeProps([makeApproval({ id: "tx-1" })]);
    render(React.createElement(ApprovalQueue, props));

    const approveBtn = await screen.findByRole("button", {
      name: "Approve transaction tx-1",
    });
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    expect(props.approveStewardTx).toHaveBeenCalledWith("tx-1");
    expect(props.setActionNotice).toHaveBeenCalledWith(
      "Transaction approved",
      "success",
      3000,
    );
    // Optimistic removal -> empty state appears.
    expect(await screen.findByText("No pending approvals")).toBeTruthy();
    // Count decremented (items.length - 1 == 0).
    expect(props.onPendingCountChange).toHaveBeenLastCalledWith(0);
  });

  it("Reject opens the inline dialog, typing the reason and Confirm calls rejectStewardTx", async () => {
    const props = makeProps([makeApproval({ id: "tx-1" })]);
    render(React.createElement(ApprovalQueue, props));

    const rejectBtn = await screen.findByRole("button", {
      name: "Reject transaction tx-1",
    });
    await act(async () => {
      fireEvent.click(rejectBtn);
    });

    // Dialog opened: the reason input is present.
    const reasonInput = await screen.findByLabelText("Rejection reason");
    await act(async () => {
      fireEvent.change(reasonInput, {
        target: { value: "Unauthorized recipient" },
      });
    });

    const confirmBtn = screen.getByText("Confirm Reject");
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(props.rejectStewardTx).toHaveBeenCalledWith(
      "tx-1",
      "Unauthorized recipient",
    );
    expect(props.setActionNotice).toHaveBeenCalledWith(
      "Transaction rejected",
      "info",
      3000,
    );
  });

  it("Cancel closes the reject dialog without rejecting", async () => {
    const props = makeProps([makeApproval({ id: "tx-1" })]);
    render(React.createElement(ApprovalQueue, props));

    const rejectBtn = await screen.findByRole("button", {
      name: "Reject transaction tx-1",
    });
    await act(async () => {
      fireEvent.click(rejectBtn);
    });
    expect(screen.getByLabelText("Rejection reason")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"));
    });

    expect(screen.queryByLabelText("Rejection reason")).toBeNull();
    expect(props.rejectStewardTx).not.toHaveBeenCalled();
  });

  it("copy-address button calls copyToClipboard with the destination address", async () => {
    const addr = "0xAbCdEf0123456789abcdef0123456789AbCdEf01";
    const props = makeProps([makeApproval({ id: "tx-1", to: addr })]);
    render(React.createElement(ApprovalQueue, props));

    // The copy-address control is a <button title={fullAddress}> whose
    // accessible name normally comes from useAgentElement's agentProps; we
    // locate it by its title attribute (the full destination address).
    await screen.findByText("1 ETH");
    const copyBtn = screen.getByTitle(addr);
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(props.copyToClipboard).toHaveBeenCalledWith(addr);
    expect(props.setActionNotice).toHaveBeenCalledWith(
      "Address copied",
      "success",
      2000,
    );
  });

  it("Refresh re-invokes getStewardPending", async () => {
    const props = makeProps([makeApproval({ id: "tx-1" })]);
    render(React.createElement(ApprovalQueue, props));

    await screen.findByText("1 ETH");
    const callsBefore = props.getStewardPending.mock.calls.length;

    const refreshBtn = screen.getByRole("button", {
      name: "Refresh approvals",
    });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    expect(props.getStewardPending.mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
  });
});
