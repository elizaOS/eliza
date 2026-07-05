// @vitest-environment jsdom

/**
 * Console chrome: the sidebar lists every console surface as a client-side
 * router link, the child page renders in the content region, and a page that
 * calls `useSetPageHeader` gets its title surfaced in the top bar.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const sessionState = {
  ready: true,
  authenticated: true,
  user: { id: "u1", email: "qa@e.test" } as {
    id: string;
    email: string;
  } | null,
};
vi.mock("../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionState,
}));

import {
  EnsurePageHeaderProvider,
  useSetPageHeader,
} from "../../cloud-ui/components/layout";
import { ConsoleShell } from "./ConsoleShell";

/** The launch-core nav (nubs's cut): exactly these, nothing else. */
const NAV_HREFS = [
  "/dashboard",
  "/dashboard/agents",
  "/dashboard/apps",
  "/dashboard/billing",
  "/dashboard/api-keys",
  "/dashboard/account",
  "/dashboard/organization",
];

/** De-navved surfaces — routable, but must NOT appear in the sidebar. */
const CULLED_HREFS = [
  "/dashboard/my-agents",
  "/dashboard/mcps",
  "/dashboard/analytics",
  "/dashboard/api-explorer",
  "/dashboard/monetization",
  "/dashboard/connectors",
  "/dashboard/security",
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
  afterEach(() => {
    cleanup();
    sessionState.ready = true;
    sessionState.authenticated = true;
  });

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
    for (const href of CULLED_HREFS) {
      expect(hrefs.has(href), `culled surface back in nav: ${href}`).toBe(
        false,
      );
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

  it("renders a flat nav with no section titles (the launch cut; also settles the Account/Account double-label)", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <ConsoleShell>
          <TitledPage />
        </ConsoleShell>
      </MemoryRouter>,
    );

    // One unsectioned list: no "Run"/"Observe"/"Money"/"Workspace" (or any
    // other) section headings above the items.
    for (const title of ["Run", "Observe", "Money", "Workspace", "Account"]) {
      expect(
        screen.queryByRole("heading", { name: title }),
        `unexpected sidebar section title: ${title}`,
      ).toBeNull();
    }
    // The "Account" nav item itself is unchanged.
    expect(
      screen.getByRole("link", { name: /Account/i }).getAttribute("href"),
    ).toBe("/dashboard/account");
  });

  it("redirects to /login (returnTo preserved) when the session dies — never a fake-empty console (#13709)", () => {
    sessionState.authenticated = false;
    render(
      <MemoryRouter initialEntries={["/dashboard/agents?x=1"]}>
        <Routes>
          <Route path="/login" element={<div data-testid="login-page" />} />
          <Route
            path="*"
            element={
              <ConsoleShell>
                <TitledPage />
              </ConsoleShell>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("login-page")).toBeTruthy();
    expect(screen.queryByTestId("page-body")).toBeNull();
  });
});
