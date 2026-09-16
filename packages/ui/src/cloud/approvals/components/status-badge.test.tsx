/** Verifies approval-domain status mapping through the canonical StatusBadge. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalStatusBadge } from "./status-badge";

afterEach(cleanup);

describe("ApprovalStatusBadge", () => {
  it.each([
    { source: "pending", label: "Pending", status: "warning" },
    { source: "delivered", label: "Awaiting signature", status: "warning" },
    { source: "approved", label: "Approved", status: "success" },
    { source: "denied", label: "Denied", status: "danger" },
    { source: "expired", label: "Expired", status: "muted" },
    { source: "fulfilled", label: "Fulfilled", status: "success" },
    { source: "failed", label: "Failed", status: "danger" },
  ])("maps $source to $status without owning paint", (state) => {
    render(<ApprovalStatusBadge status={state.source} />);

    const badge = screen.getByText(state.label).closest("[data-status]");
    expect(badge?.getAttribute("data-slot")).toBe("status-badge");
    expect(badge?.getAttribute("data-status")).toBe(state.status);
  });

  it("preserves an unknown domain status as a muted label", () => {
    render(<ApprovalStatusBadge status="awaiting_review" />);

    const badge = screen.getByText("awaiting_review").closest("[data-status]");
    expect(badge?.getAttribute("data-status")).toBe("muted");
  });
});
