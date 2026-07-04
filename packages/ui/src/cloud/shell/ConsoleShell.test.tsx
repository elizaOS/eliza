// @vitest-environment jsdom

/**
 * Console chrome: the sidebar lists every console surface as a client-side
 * router link, the child page renders in the content region, and a page that
 * calls `useSetPageHeader` gets its title surfaced in the top bar.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/use-session-auth", () => ({
  useRequireAuth: () => ({
    ready: true,
    authenticated: true,
    user: { id: "u1", email: "qa@e.test" },
  }),
  useSessionAuth: () => ({
    ready: true,
    authenticated: true,
    user: { id: "u1", email: "qa@e.test" },
  }),
}));

import {
  EnsurePageHeaderProvider,
  useSetPageHeader,
} from "../../cloud-ui/components/layout";
import { ConsoleShell } from "./ConsoleShell";

const NAV_HREFS = [
  "/dashboard",
  "/dashboard/agents",
  "/dashboard/my-agents",
  "/dashboard/apps",
  "/dashboard/mcps",
  "/dashboard/analytics",
  "/dashboard/api-explorer",
  "/dashboard/billing",
  "/dashboard/api-keys",
  "/dashboard/monetization",
  "/dashboard/connectors",
  "/dashboard/account",
  "/dashboard/security",
  "/dashboard/organization",
];

function TitledPage() {
  useSetPageHeader({ title: "Overview QA" });
  return <div data-testid="page-body">body</div>;
}

/**
 * A standalone-route body: it publishes its own header inside
 * EnsurePageHeaderProvider (the pattern MyAgentsPage / AnalyticsPage use so
 * they also work mounted directly by CloudRouterShell). Inside ConsoleShell the
 * provider must DEFER to the shell so the title reaches the top bar rather than
 * a shadowed inner provider.
 */
function StandaloneTitledPage() {
  return (
    <EnsurePageHeaderProvider>
      <TitledInner />
    </EnsurePageHeaderProvider>
  );
}

function TitledInner() {
  useSetPageHeader({ title: "Standalone QA" });
  return <div data-testid="page-body">body</div>;
}

describe("ConsoleShell", () => {
  afterEach(cleanup);

  it("renders the sidebar directory, the page body, and the captured page title", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <ConsoleShell>
          <TitledPage />
        </ConsoleShell>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("page-body")).toBeTruthy();
    // Title captured from the page via useSetPageHeader → top bar.
    expect(screen.getByRole("heading", { name: "Overview QA" })).toBeTruthy();
    // Signed-in identity in the header.
    expect(screen.getByText("qa@e.test")).toBeTruthy();

    const hrefs = new Set(
      screen.getAllByRole("link").map((a) => a.getAttribute("href")),
    );
    for (const href of NAV_HREFS) {
      expect(hrefs.has(href), `missing sidebar link ${href}`).toBe(true);
    }
  });

  it("surfaces a standalone route's title in the top bar (EnsurePageHeaderProvider defers to the shell, no shadowed provider)", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard/my-agents"]}>
        <ConsoleShell>
          <StandaloneTitledPage />
        </ConsoleShell>
      </MemoryRouter>,
    );

    // The page's own EnsurePageHeaderProvider defers to the shell provider, so
    // useSetPageHeader writes to the context the top bar reads. Exactly one
    // page-level heading with the title — no shadowed/dead inner provider.
    expect(screen.getByRole("heading", { name: "Standalone QA" })).toBeTruthy();
  });

  it("names the account-plumbing section 'Workspace', not 'Account' (no section title duplicating an item label)", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <ConsoleShell>
          <TitledPage />
        </ConsoleShell>
      </MemoryRouter>,
    );

    // The section that holds Connectors/Account/Security/Organization is
    // titled "Workspace" so it doesn't repeat the "Account" item label below
    // it (the sidebar half of the double-title fix).
    expect(screen.getByText("Workspace")).toBeTruthy();
    // The "Account" nav item itself is unchanged.
    expect(
      screen.getByRole("link", { name: /Account/i }).getAttribute("href"),
    ).toBe("/dashboard/account");
  });
});
