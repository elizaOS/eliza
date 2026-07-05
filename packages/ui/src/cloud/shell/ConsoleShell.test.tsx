// @vitest-environment jsdom

/**
 * Console chrome: the sidebar lists every console surface as a client-side
 * router link, the child page renders in the content region, and a page that
 * calls `useSetPageHeader` gets its title surfaced in the top bar.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
let storedToken = false;
const stewardSessionMock = vi.hoisted(() => ({
  clearStaleStewardSession: vi.fn(),
}));
vi.mock("../lib/steward-session", () => ({
  hasHydratableStewardToken: () => storedToken,
}));
vi.mock("./StewardProviderShared", () => ({
  clearStaleStewardSession: stewardSessionMock.clearStaleStewardSession,
}));

vi.mock("../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionState,
}));

// The header's account menu reads the credit balance; give it a stubbed value
// so the console renders without a live QueryClient.
vi.mock("../instances/lib/data/credits", () => ({
  useCreditsBalance: () => ({ data: { balance: 12.5 } }),
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
  "/dashboard/billing",
  "/dashboard/api-keys",
  "/dashboard/account",
];

/** De-navved surfaces — routable, but must NOT appear in the sidebar. */
const CULLED_HREFS = [
  // Apps moved into the Eliza app; the console route now redirects.
  "/dashboard/apps",
  // Organization is de-surfaced (console presents as plain user accounts); the
  // route stays registered for invite deep-links but is not in the sidebar.
  "/dashboard/organization",
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
    storedToken = false;
    stewardSessionMock.clearStaleStewardSession.mockReset();
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

  it("uses the hardened Steward cleanup path when signing out from the header menu", async () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
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

    const accountMenu = screen.getByRole("button", { name: /qa@e\.test/i });
    expect(accountMenu.getAttribute("aria-label")).toBe(
      "Account menu for qa@e.test",
    );
    fireEvent.pointerDown(accountMenu, { button: 0, pointerId: 1 });
    fireEvent.click(await screen.findByRole("menuitem", { name: /sign out/i }));

    expect(stewardSessionMock.clearStaleStewardSession).toHaveBeenCalledTimes(
      1,
    );
    await waitFor(() => expect(screen.getByTestId("login-page")).toBeTruthy());
  });

  it("keeps a visible keyboard focus treatment on the account menu trigger", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <ConsoleShell>
          <TitledPage />
        </ConsoleShell>
      </MemoryRouter>,
    );

    const accountMenu = screen.getByRole("button", { name: /qa@e\.test/i });
    expect(accountMenu.className).toContain("focus-visible:ring-2");
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

  it("holds a signing-in fallback (no login bounce) while a stored token awaits hydration", () => {
    sessionState.authenticated = false;
    storedToken = true;
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
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
    expect(screen.queryByTestId("login-page")).toBeNull();
    expect(screen.queryByTestId("page-body")).toBeNull();
    expect(screen.getByText("Signing you in…")).toBeTruthy();
  });

  it("redirects once the hydratable token is cleared during the signing-in hold", async () => {
    sessionState.authenticated = false;
    storedToken = true;
    render(
      <MemoryRouter initialEntries={["/dashboard/agents"]}>
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
    expect(screen.getByText("Signing you in…")).toBeTruthy();

    storedToken = false;
    window.dispatchEvent(new CustomEvent("steward-token-sync"));

    await waitFor(() => expect(screen.getByTestId("login-page")).toBeTruthy());
    expect(screen.queryByText("Signing you in…")).toBeNull();
    expect(screen.queryByTestId("page-body")).toBeNull();
  });
});
