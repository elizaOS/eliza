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

import { useSetPageHeader } from "../../cloud-ui/components/layout";
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
});
