// @vitest-environment jsdom

/**
 * Console-home rendering: the balance hero honors the three-state rule
 * (loading em dash / designed error / live dollar amount — never a fabricated
 * $0), and every standalone console surface is reachable from the directory
 * grid. Credits + session hooks are stubbed; router links are real.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

const sessionState = {
  ready: true,
  authenticated: true,
  user: { id: "u1", email: "a@b.test" },
};
vi.mock("../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionState,
}));

const creditsState: {
  data: { balance: number } | undefined;
  isError: boolean;
} = { data: { balance: 86.72 }, isError: false };
vi.mock("../instances/lib/data/credits", () => ({
  useCreditsBalance: () => creditsState,
}));

import { PageHeaderProvider } from "../../cloud-ui/components/layout";
import { DashboardHomePage } from "./DashboardHomePage";

function renderHome(): void {
  render(
    <MemoryRouter>
      {/* The real mount is inside ConsoleShell, which provides the header
          context useSetPageHeader writes to. */}
      <PageHeaderProvider>
        <DashboardHomePage />
      </PageHeaderProvider>
    </MemoryRouter>,
  );
}

/** The launch-core directory (mirrors the sidebar cut exactly). */
const EXPECTED_LINKS = [
  "/dashboard/agents",
  "/dashboard/billing",
  "/dashboard/api-keys",
  "/dashboard/account",
];

describe("DashboardHomePage", () => {
  afterEach(() => {
    cleanup();
    sessionState.ready = true;
    sessionState.authenticated = true;
    creditsState.data = { balance: 86.72 };
    creditsState.isError = false;
  });

  it("renders the live balance and a directory card for every console surface", () => {
    renderHome();
    expect(screen.getByText("$86.72")).toBeTruthy();
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    for (const to of EXPECTED_LINKS) {
      expect(hrefs, `missing console link ${to}`).toContain(to);
    }
    expect(hrefs).not.toContain("/dashboard/organization");
  });

  it("links Add funds to the billing console page", () => {
    renderHome();
    const addFunds = screen.getByRole("link", { name: "Add funds" });
    expect(addFunds.getAttribute("href")).toBe("/dashboard/billing");
  });

  it("shows a busy em dash while the balance loads — never a fabricated amount", () => {
    creditsState.data = undefined;
    renderHome();
    const value = screen.getByText("—");
    expect(value.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("shows the designed error state when the balance read fails", () => {
    creditsState.data = undefined;
    creditsState.isError = true;
    renderHome();
    expect(screen.getByText(/Balance unavailable/)).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("renders the loading skeleton until the session is readable", () => {
    sessionState.ready = false;
    renderHome();
    // DashboardLoadingState is a silhouette skeleton — the label is its
    // accessible name, not visible text.
    expect(
      screen.getByRole("status", { name: "Loading dashboard" }),
    ).toBeTruthy();
    expect(screen.queryByText("$86.72")).toBeNull();
  });
});
