// @vitest-environment jsdom

/**
 * Structure guard for the simplified ApiKeysTable: Name/Key/Created/Last used
 * columns, a prefix-only mono chip, "Never" for never-used keys, a status
 * badge only on non-active keys, and a single per-row Revoke action. Pure
 * props, real DOM render.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApiKeyDisplay,
  ApiKeysTable,
  formatApiKeyDate,
} from "./api-keys-table";

const keys: ApiKeyDisplay[] = [
  {
    id: "key-active",
    name: "Production API",
    keyPrefix: "sk_live_8f2a",
    status: "active",
    createdAt: "2026-01-12T09:00:00Z",
    lastUsedAt: "2026-06-04T10:24:00Z",
  },
  {
    id: "key-expired",
    name: "Legacy mobile",
    keyPrefix: "sk_live_a013",
    status: "expired",
    createdAt: "2024-10-20T09:00:00Z",
    lastUsedAt: null,
  },
];

describe("ApiKeysTable", () => {
  afterEach(cleanup);

  it("renders Name/Key/Created/Last used columns with real values", () => {
    render(<ApiKeysTable keys={keys} />);
    const table = screen.getByRole("table");
    for (const header of ["Name", "Key", "Created", "Last used"]) {
      expect(within(table).getByText(header)).toBeTruthy();
    }
    expect(within(table).getByText("Production API")).toBeTruthy();
    expect(within(table).getByText("sk_live_8f2a…")).toBeTruthy();
    expect(within(table).getByText("Jan 12, 2026")).toBeTruthy();
    expect(within(table).getByText("Jun 4, 2026")).toBeTruthy();
  });

  it('shows "Never" for a key that was never used', () => {
    render(<ApiKeysTable keys={keys} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Never")).toBeTruthy();
  });

  it("shows a status badge only for non-active keys", () => {
    render(<ApiKeysTable keys={keys} />);
    expect(screen.queryByText("Active")).toBeNull();
    // Badge renders in both the mobile card and the desktop row.
    expect(screen.getAllByText("Expired").length).toBeGreaterThan(0);
  });

  it("fires onRevokeKey with the row id from the single Revoke action", async () => {
    const revoked: string[] = [];
    render(
      <ApiKeysTable keys={[keys[0]]} onRevokeKey={(id) => revoked.push(id)} />,
    );
    const table = screen.getByRole("table");
    await userEvent.click(
      within(table).getByRole("button", { name: "Revoke" }),
    );
    expect(revoked).toEqual(["key-active"]);
  });

  it("renders nothing for an empty list (empty state is owned by the view)", () => {
    const { container } = render(<ApiKeysTable keys={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("formatApiKeyDate", () => {
  it("formats ISO dates deterministically and dashes out missing/invalid input", () => {
    expect(formatApiKeyDate("2026-01-12T09:00:00Z")).toBe("Jan 12, 2026");
    expect(formatApiKeyDate(null)).toBe("-");
    expect(formatApiKeyDate("not-a-date")).toBe("-");
  });
});
