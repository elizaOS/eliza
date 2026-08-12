/**
 * AccountCommandTable — renders the pool as a table, sorts on header click,
 * maps health to the right badge, and (critically) hides the lease column
 * when the payload has no observability, proving graceful degradation before
 * #16355 merges.
 */

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import { AccountCommandTable } from "./AccountCommandTable";

vi.mock("../../state/app-store", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, vars?: Record<string, unknown>) => string;
    }) => unknown,
  ) => selector({ t: (key, vars) => String(vars?.defaultValue ?? key) }),
}));

function account(
  overrides: Partial<AccountWithCredentialFlag> = {},
): AccountWithCredentialFlag {
  return {
    id: overrides.id ?? "acc-1",
    providerId: "anthropic-subscription",
    label: overrides.label ?? "Account 1",
    source: "oauth",
    enabled: true,
    priority: 1,
    createdAt: 0,
    health: "ok",
    hasCredential: true,
    ...overrides,
  } as AccountWithCredentialFlag;
}

const noop = vi.fn().mockResolvedValue(undefined);

function renderTable(
  accounts: AccountWithCredentialFlag[],
  props: Partial<React.ComponentProps<typeof AccountCommandTable>> = {},
) {
  return render(
    <AccountCommandTable
      providerId="anthropic-subscription"
      accounts={accounts}
      saving={new Set<string>()}
      onPatch={noop}
      onDelete={noop}
      {...props}
    />,
  );
}

function rowOrder(): string[] {
  return screen
    .getAllByTestId(/account-row-/)
    .map((el) => el.getAttribute("data-testid") ?? "");
}

describe("AccountCommandTable", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders one row per account with label and email", () => {
    renderTable([
      account({ id: "a", label: "Work", email: "work@example.com" }),
      account({ id: "b", label: "Personal", priority: 2 }),
    ]);
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("work@example.com")).toBeTruthy();
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(rowOrder()).toEqual(["account-row-a", "account-row-b"]);
  });

  it("preserves inline label editing in the desktop table", () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    renderTable([account({ id: "rename-me", label: "Before" })], { onPatch });

    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    const input = screen.getByRole("textbox", { name: "Rename Before" });
    fireEvent.change(input, { target: { value: "After" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onPatch).toHaveBeenCalledWith("rename-me", { label: "After" });
  });

  it("defaults to worst-health-first ordering", () => {
    renderTable([
      account({ id: "ok", health: "ok", priority: 1 }),
      account({ id: "bad", health: "invalid", priority: 2 }),
      account({ id: "reauth", health: "needs-reauth", priority: 3 }),
    ]);
    expect(rowOrder()).toEqual([
      "account-row-bad",
      "account-row-reauth",
      "account-row-ok",
    ]);
  });

  it("toggles sort direction when the same header is clicked twice", () => {
    renderTable([
      account({ id: "p1", priority: 1, health: "ok" }),
      account({ id: "p3", priority: 3, health: "ok" }),
      account({ id: "p2", priority: 2, health: "ok" }),
    ]);
    const priorityHeader = screen.getByText("Priority").closest("button");
    expect(priorityHeader).toBeTruthy();
    // First click → ascending priority.
    fireEvent.click(priorityHeader as HTMLButtonElement);
    expect(rowOrder()).toEqual([
      "account-row-p1",
      "account-row-p2",
      "account-row-p3",
    ]);
    // Second click → descending.
    fireEvent.click(priorityHeader as HTMLButtonElement);
    expect(rowOrder()).toEqual([
      "account-row-p3",
      "account-row-p2",
      "account-row-p1",
    ]);
  });

  it("maps each health state to the matching status badge tone", () => {
    renderTable([
      account({ id: "ok", health: "ok" }),
      account({ id: "rl", health: "rate-limited", priority: 2 }),
      account({ id: "re", health: "needs-reauth", priority: 3 }),
    ]);
    const okRow = screen.getByTestId("account-row-ok");
    const rlRow = screen.getByTestId("account-row-rl");
    const reRow = screen.getByTestId("account-row-re");
    expect(
      within(okRow)
        .getByText("Healthy")
        .closest("[data-status]")
        ?.getAttribute("data-status"),
    ).toBe("success");
    expect(
      within(rlRow)
        .getByText("Rate-limited")
        .closest("[data-status]")
        ?.getAttribute("data-status"),
    ).toBe("warning");
    expect(
      within(reRow)
        .getByText("Needs reauth")
        .closest("[data-status]")
        ?.getAttribute("data-status"),
    ).toBe("danger");
  });

  it("hides the lease column when no account carries observability", () => {
    renderTable([account({ id: "a" }), account({ id: "b", priority: 2 })]);
    expect(screen.queryByText("Leases")).toBeNull();
  });

  it("shows the lease column and served-last marker when observability is present", () => {
    renderTable([
      account({
        id: "a",
        observability: {
          activeLeaseCount: 3,
          lastLeaseAt: 1,
          lastSelectedAt: 1,
          servedLastRequest: true,
        },
      }),
      account({ id: "b", priority: 2 }),
    ]);
    expect(screen.getByText("Leases")).toBeTruthy();
    const row = screen.getByTestId("account-row-a");
    expect(within(row).getByText("3")).toBeTruthy();
    expect(within(row).getByText("served last").className).toContain(
      "text-accent",
    );
  });

  it("renders the reauth CTA only for accounts needing repair", () => {
    renderTable(
      [
        account({ id: "ok", health: "ok" }),
        account({ id: "re", health: "needs-reauth", priority: 2 }),
      ],
      { onReauthenticate: vi.fn() },
    );
    const okRow = screen.getByTestId("account-row-ok");
    const reRow = screen.getByTestId("account-row-re");
    expect(within(okRow).queryByText("Reauth")).toBeNull();
    expect(within(reRow).getByText("Reauth").className).toContain("text-bg");
  });

  it("invokes onReauthenticate with the account via the existing repair flow", () => {
    const onReauthenticate = vi.fn();
    const reauthAccount = account({ id: "re", health: "invalid" });
    renderTable([reauthAccount], { onReauthenticate });
    // OAuth-less/invalid api-key source shows "Replace"; oauth shows "Reauth".
    fireEvent.click(screen.getByText("Reauth"));
    expect(onReauthenticate).toHaveBeenCalledWith(reauthAccount);
  });

  it("marks disabled rows without lowering descendant contrast and forwards enabled toggles", () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    renderTable([account({ id: "off", enabled: false })], { onPatch });
    const row = screen.getByTestId("account-row-off");
    expect(row.className).toContain("bg-bg-accent/20");
    expect(row.className).not.toContain("opacity-");
    fireEvent.click(within(row).getByRole("checkbox"));
    expect(onPatch).toHaveBeenCalledWith("off", { enabled: true });
  });

  it("exposes test / refresh / reorder actions and targets priority neighbours", () => {
    const onTest = vi.fn().mockResolvedValue(undefined);
    const onRefreshUsage = vi.fn().mockResolvedValue(undefined);
    const onMove = vi.fn().mockResolvedValue(undefined);
    // Pass in NON-priority order to prove move targets the priority neighbour,
    // not the current table row order.
    const pool = [
      account({ id: "c", priority: 3, health: "ok" }),
      account({ id: "a", priority: 1, health: "ok" }),
      account({ id: "b", priority: 2, health: "ok" }),
    ];
    renderTable(pool, { onTest, onRefreshUsage, onMove });

    const rowB = screen.getByTestId("account-row-b");
    fireEvent.click(within(rowB).getByText("Test"));
    expect(onTest).toHaveBeenCalledWith("b");
    fireEvent.click(
      within(rowB).getByRole("button", { name: /Refresh usage/i }),
    );
    expect(onRefreshUsage).toHaveBeenCalledWith("b");
    fireEvent.click(
      within(rowB).getByRole("button", { name: /Raise priority/i }),
    );
    // onMove receives the priority-ordered pool + the id + direction.
    const [orderArg, idArg, dirArg] = onMove.mock.calls[0];
    expect(orderArg.map((a: { id: string }) => a.id)).toEqual(["a", "b", "c"]);
    expect(idArg).toBe("b");
    expect(dirArg).toBe("up");
  });

  it("disables move-up on the highest-priority row and move-down on the lowest", () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    renderTable(
      [
        account({ id: "top", priority: 1, health: "ok" }),
        account({ id: "bottom", priority: 2, health: "ok" }),
      ],
      { onMove },
    );
    const topRow = screen.getByTestId("account-row-top");
    const bottomRow = screen.getByTestId("account-row-bottom");
    expect(
      within(topRow)
        .getByRole("button", { name: /Raise priority/i })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(bottomRow)
        .getByRole("button", { name: /Lower priority/i })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("surfaces rejected table actions instead of swallowing them", async () => {
    renderTable([account({ id: "fails" })], {
      onTest: vi.fn().mockRejectedValue(new Error("Probe unavailable")),
    });

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Probe unavailable",
    );
  });

  it("hides test/refresh/reorder when their handlers are not supplied", () => {
    renderTable([account({ id: "a", health: "ok" })]);
    const row = screen.getByTestId("account-row-a");
    expect(within(row).queryByText("Test")).toBeNull();
    expect(
      within(row).queryByRole("button", { name: /Refresh usage/i }),
    ).toBeNull();
    expect(
      within(row).queryByRole("button", { name: /Raise priority/i }),
    ).toBeNull();
  });

  it("puts aria-sort on the header cell, not the sort button", () => {
    renderTable([
      account({ id: "a", health: "invalid", priority: 1 }),
      account({ id: "b", health: "ok", priority: 2 }),
    ]);
    // Default sort is health ascending → the Health <th> announces ascending.
    const healthHeaderCell = screen
      .getByText("Health")
      .closest("th") as HTMLTableCellElement;
    expect(healthHeaderCell.getAttribute("aria-sort")).toBe("ascending");
    // The button inside must NOT carry aria-sort.
    const healthButton = screen.getByText("Health").closest("button");
    expect(healthButton?.getAttribute("aria-sort")).toBeNull();
    // A non-active sortable header announces "none".
    const usageHeaderCell = screen
      .getByText("Usage")
      .closest("th") as HTMLTableCellElement;
    expect(usageHeaderCell.getAttribute("aria-sort")).toBe("none");
  });

  it("renders loading, error, and empty states distinctly", () => {
    const { rerender } = renderTable([], { loading: true });
    expect(screen.getByText("Loading accounts…")).toBeTruthy();
    expect(screen.queryByText("No accounts in this pool yet.")).toBeNull();

    rerender(
      <AccountCommandTable
        providerId="anthropic-subscription"
        accounts={[]}
        error="Usage service unavailable"
        saving={new Set<string>()}
        onPatch={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Usage service unavailable",
    );

    rerender(
      <AccountCommandTable
        providerId="anthropic-subscription"
        accounts={[]}
        saving={new Set<string>()}
        onPatch={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText("No accounts in this pool yet.")).toBeTruthy();
  });

  it("treats API percentages as percentage points and shows distinct buckets", () => {
    renderTable([
      account({
        id: "usage",
        usage: {
          sessionPct: 1,
          weeklyPct: 42,
          refreshedAt: 0,
          weeklyModelBuckets: { Fable: { pct: 7 } },
        } as AccountWithCredentialFlag["usage"],
      }),
    ]);
    const row = screen.getByTestId("account-row-usage");
    expect(within(row).getByTitle("5h: 1%")).toBeTruthy();
    expect(within(row).getByTitle("7d: 42%")).toBeTruthy();
    expect(within(row).getByTitle("Fable: 7%")).toBeTruthy();
  });

  it("does not invent weekly windows for providers without quota-window data", () => {
    renderTable([account({ id: "direct", providerId: "openai-api" })], {
      providerId: "openai-api",
    });
    const row = screen.getByTestId("account-row-direct");
    expect(within(row).getAllByText("Not reported")).toHaveLength(2);
    expect(within(row).queryByText("7d")).toBeNull();
    expect(within(row).queryByText("Fable")).toBeNull();
  });

  it("shows unknown weekly resets without borrowing the session cooldown", () => {
    renderTable([
      account({
        id: "unknown-reset",
        health: "rate-limited",
        healthDetail: { until: Date.now() + 3_600_000 },
        usage: { sessionPct: 12, weeklyPct: 24, refreshedAt: 0 },
      }),
    ]);
    const row = screen.getByTestId("account-row-unknown-reset");
    expect(
      within(row).getByTitle("All-model weekly reset").textContent,
    ).toContain("Unknown");
    expect(within(row).getByTitle("Fable weekly reset").textContent).toContain(
      "Unknown",
    );
  });

  it("marks the active account row and shows an empty state for no accounts", () => {
    const { rerender } = renderTable(
      [account({ id: "active" }), account({ id: "idle", priority: 2 })],
      { activeAccountId: "active" },
    );
    expect(
      screen.getByTestId("account-row-active").getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen.getByTestId("account-row-idle").getAttribute("data-active"),
    ).toBeNull();

    rerender(
      <AccountCommandTable
        providerId="anthropic-subscription"
        accounts={[]}
        saving={new Set<string>()}
        onPatch={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText("No accounts in this pool yet.")).toBeTruthy();
  });
});
