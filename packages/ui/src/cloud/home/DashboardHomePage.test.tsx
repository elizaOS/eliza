/**
 * Console-home rendering: the balance hero honors the three-state rule
 * (loading em dash / designed error / live dollar amount — never a fabricated
 * $0), and every standalone console surface is reachable from the directory
 * grid. Credits + session hooks are stubbed; router links are real.
 */
// @vitest-environment jsdom

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

const personalState: {
  data:
    | {
        id: string;
        displayName: string;
        runtime: "shared" | "dedicated";
        activeAgentId?: string;
        apiBase?: string;
      }
    | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: ReturnType<typeof vi.fn>;
} = {
  data: {
    id: "personal-1",
    displayName: "Eliza",
    runtime: "shared",
  },
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
};
vi.mock("../instances/lib/data/personal-eliza", () => ({
  usePersonalEliza: () => personalState,
}));
vi.mock("../instances/components/agent-actions", () => ({
  ElizaAgentActions: ({ personalRowless }: { personalRowless?: boolean }) => (
    <div data-testid="personal-eliza-actions">
      {personalRowless ? "Activate Dedicated" : "Agent actions"}
    </div>
  ),
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
  "/cloud/agents",
  "/cloud/billing",
  "/cloud/api-keys",
  "/cloud/account",
];

describe("DashboardHomePage", () => {
  afterEach(() => {
    cleanup();
    sessionState.ready = true;
    sessionState.authenticated = true;
    creditsState.data = { balance: 86.72 };
    creditsState.isError = false;
    personalState.data = {
      id: "personal-1",
      displayName: "Eliza",
      runtime: "shared",
    };
    personalState.isLoading = false;
    personalState.isError = false;
    personalState.refetch.mockClear();
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
    expect(hrefs).not.toContain("/cloud/organization");
  });

  it("links Add funds to the billing console page", () => {
    renderHome();
    const addFunds = screen.getByRole("link", { name: "Add funds" });
    expect(addFunds.getAttribute("href")).toBe("/cloud/billing");
  });

  it("presents one rowless Shared personal Eliza with explicit Dedicated activation", () => {
    renderHome();
    expect(screen.getByRole("heading", { name: "Eliza" })).toBeTruthy();
    expect(screen.getByText("Shared")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Chat with Eliza" })).toBeTruthy();
    expect(screen.getByTestId("personal-eliza-actions")).toBeTruthy();
  });

  it("links the active Dedicated identity to its one management surface", () => {
    personalState.data = {
      id: "personal-1",
      displayName: "Eliza",
      runtime: "dedicated",
      activeAgentId: "dedicated-1",
      apiBase: "https://dedicated-1.cloud.test",
    };
    renderHome();
    expect(screen.getByText("Dedicated")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Manage Dedicated" })
        .getAttribute("href"),
    ).toBe("/cloud/agents/dedicated-1");
    expect(screen.queryByTestId("personal-eliza-actions")).toBeNull();
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
