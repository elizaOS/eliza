/** Verifies the permission-domain status adapter against the canonical badge in jsdom. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionStatusBadge } from "./permission-status-badge";

afterEach(cleanup);

describe("PermissionStatusBadge", () => {
  it.each([
    { granted: true, label: "Granted", status: "success" },
    { granted: false, label: "Not granted", status: "muted" },
  ])("maps $label to the canonical $status tone", (state) => {
    render(<PermissionStatusBadge granted={state.granted} />);

    const badge = screen.getByText(state.label).closest("[data-status]");
    expect(badge?.getAttribute("data-slot")).toBe("status-badge");
    expect(badge?.getAttribute("data-status")).toBe(state.status);
    expect(badge?.querySelector(".size-2")).toBeTruthy();
  });
});
