/** Verifies the cloud data-list barrel export surface through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Consumer-contract guard for the cloud data-list barrel: every runtime export
 * of `./index` must bind to the real implementation and behave when consumed
 * the way `@elizaos/ui/cloud-ui` consumers consume it — components render their
 * documented DOM, row callbacks fire with the right ids, and the date helper
 * dashes out missing input. Per-component branches are owned by the co-located
 * component suites; this file pins the public binding layer they ship through.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApiKeyDisplay,
  ApiKeysTable,
  type AppsListItem,
  AppsListView,
  DashboardDataList,
  DashboardDataListCard,
  DashboardDataListDesktop,
  DashboardDataListFilteredCount,
  DashboardDataListMobile,
  DashboardTableSkeleton,
  DataListEmptyState,
  formatApiKeyDate,
  ListActionMenu,
} from "./index";

afterEach(cleanup);

function makeKey(overrides?: Partial<ApiKeyDisplay>): ApiKeyDisplay {
  return {
    id: "key-1",
    name: "Production API",
    keyPrefix: "sk_live_8f2a",
    status: "active",
    createdAt: "2026-01-12T09:00:00Z",
    lastUsedAt: null,
    ...overrides,
  };
}

function makeApp(overrides?: Partial<AppsListItem>): AppsListItem {
  return {
    id: "app-1",
    name: "Trading bot",
    app_url: "https://trading.example.com",
    website_url: null,
    is_active: true,
    affiliate_code: null,
    total_users: 12,
    total_requests: 340,
    updated_at: "2026-01-10T09:00:00Z",
    ...overrides,
  };
}

function appLink({
  app,
  children,
}: {
  app: AppsListItem;
  className?: string;
  children: ReactNode;
}) {
  return <a href={app.app_url}>{children}</a>;
}

describe("data-list barrel — formatApiKeyDate", () => {
  it("formats ISO dates deterministically through the barrel", () => {
    expect(formatApiKeyDate("2026-03-05T12:00:00Z")).toBe("Mar 5, 2026");
  });

  it("dashes out missing, empty, and unparseable values", () => {
    expect(formatApiKeyDate(null)).toBe("-");
    expect(formatApiKeyDate(undefined)).toBe("-");
    expect(formatApiKeyDate("")).toBe("-");
    expect(formatApiKeyDate("not-a-date")).toBe("-");
  });
});

describe("data-list barrel — ApiKeysTable", () => {
  it("renders the key row with prefix chip and Never for unused keys", () => {
    render(<ApiKeysTable keys={[makeKey()]} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Production API")).toBeTruthy();
    expect(within(table).getByText("sk_live_8f2a…")).toBeTruthy();
    expect(within(table).getByText("Never")).toBeTruthy();
  });

  it("renders nothing for an empty key list", () => {
    const { container } = render(<ApiKeysTable keys={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("fires onRevokeKey with the clicked row's id", async () => {
    const revoked: string[] = [];
    render(
      <ApiKeysTable
        keys={[makeKey({ id: "key-a" }), makeKey({ id: "key-b" })]}
        onRevokeKey={(id) => revoked.push(id)}
      />,
    );
    await userEvent.click(
      within(screen.getByRole("table")).getAllByRole("button", {
        name: "Revoke",
      })[1],
    );
    expect(revoked).toEqual(["key-b"]);
  });
});

describe("data-list barrel — dashboard list containers", () => {
  it("lands children inside the documented data-slot containers", () => {
    const { container } = render(
      <DashboardDataList>
        <DashboardDataListCard>
          <DashboardDataListDesktop>
            <p data-testid="desktop-row">desktop</p>
          </DashboardDataListDesktop>
          <DashboardDataListMobile>
            <p data-testid="mobile-card">mobile</p>
          </DashboardDataListMobile>
        </DashboardDataListCard>
      </DashboardDataList>,
    );
    expect(
      container.querySelector('[data-slot="dashboard-data-list"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-slot="dashboard-data-list-card"]'),
    ).toBeTruthy();
    const desktop = container.querySelector(
      '[data-slot="dashboard-data-list-desktop"]',
    );
    const mobile = container.querySelector(
      '[data-slot="dashboard-data-list-mobile"]',
    );
    expect(desktop?.contains(screen.getByTestId("desktop-row"))).toBe(true);
    expect(mobile?.contains(screen.getByTestId("mobile-card"))).toBe(true);
  });

  it("renders the filtered count line consumers show above tables", () => {
    render(
      <DashboardDataListFilteredCount filtered={7} total={42} label="agents" />,
    );
    expect(screen.getByText("7 of 42 agents")).toBeTruthy();
  });
});

describe("data-list barrel — DashboardTableSkeleton", () => {
  const columns = [
    { key: "name", label: "Name" },
    { key: "status", label: "Status" },
  ];

  it("renders one header cell per column label", () => {
    render(<DashboardTableSkeleton columns={columns} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Name")).toBeTruthy();
    expect(within(table).getByText("Status")).toBeTruthy();
  });

  it("matches the skeleton row count to the rows prop", () => {
    const { container, rerender } = render(
      <DashboardTableSkeleton columns={columns} />,
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    rerender(<DashboardTableSkeleton columns={columns} rows={5} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
  });
});

describe("data-list barrel — DataListEmptyState", () => {
  it("renders title, description, action, and injected icon", () => {
    function SpyIcon() {
      return <svg data-testid="empty-icon" />;
    }
    render(
      <DataListEmptyState
        title="No keys yet"
        description="Create your first key"
        icon={SpyIcon}
        action={<button type="button">Create key</button>}
      />,
    );
    expect(screen.getByText("No keys yet")).toBeTruthy();
    expect(screen.getByText("Create your first key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create key" })).toBeTruthy();
    expect(screen.getByTestId("empty-icon")).toBeTruthy();
  });
});

describe("data-list barrel — ListActionMenu", () => {
  it("opens from the actions trigger, fires onSelect, and skips separators", async () => {
    const selected: string[] = [];
    render(
      <ListActionMenu
        label="Agent actions"
        items={[
          {
            key: "copy",
            label: "Copy URL",
            onSelect: () => selected.push("copy"),
          },
          { type: "separator" },
          { key: "del", label: "Delete App", destructive: true },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open actions" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Agent actions")).toBeTruthy();
    expect(within(menu).getByText("Delete App")).toBeTruthy();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Copy URL" }),
    );
    expect(selected).toEqual(["copy"]);
  });
});

describe("data-list barrel — AppsListView", () => {
  it("renders nothing for an empty apps list", () => {
    const { container } = render(
      <AppsListView apps={[]} renderAppLink={appLink} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders the app link, url, status badge, and usage counters", () => {
    render(
      <AppsListView
        apps={[
          makeApp({
            affiliate_code: "ref-9",
          }),
        ]}
        renderAppLink={appLink}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Trading bot" }).getAttribute("href"),
    ).toBe("https://trading.example.com");
    expect(screen.getByText("https://trading.example.com")).toBeTruthy();
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.getByText("Affiliate")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("340")).toBeTruthy();
  });

  it("reports fresh updates as Just now and unparseable stamps as Recently", () => {
    const { rerender } = render(
      <AppsListView
        apps={[makeApp({ updated_at: new Date(Date.now() - 30_000) })]}
        renderAppLink={appLink}
      />,
    );
    expect(screen.getByText("Just now")).toBeTruthy();
    rerender(
      <AppsListView
        apps={[makeApp({ updated_at: "not-a-date" })]}
        renderAppLink={appLink}
      />,
    );
    expect(screen.getByText("Recently")).toBeTruthy();
  });
});
