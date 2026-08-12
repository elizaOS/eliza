/** Verifies the Agents page renders malformed or absent query data as error, never empty. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentsPage from "./AgentsPage";

const { mockUseAgents } = vi.hoisted(() => ({ mockUseAgents: vi.fn() }));

vi.mock("@elizaos/ui/cloud-ui", () => ({
  ContainersSkeleton: () => <div>Loading agents</div>,
  DashboardErrorState: ({ message }: { message: string }) => (
    <div role="alert">{message}</div>
  ),
  DashboardLoadingState: ({ label }: { label: string }) => <div>{label}</div>,
  DashboardPageContainer: ({ children }: { children: ReactNode }) => children,
  ElizaAgentsPageWrapper: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/use-document-title", () => ({ useDocumentTitle: vi.fn() }));
vi.mock("../lib/use-session-auth", () => ({
  useSessionAuth: () => ({ ready: true, authenticated: true }),
}));
vi.mock("./components/eliza-agent-pricing-banner", () => ({
  ElizaAgentPricingBanner: () => <div>Pricing banner</div>,
}));
vi.mock("./components/eliza-agents-table", () => ({
  ElizaAgentsTable: () => <div>Agents table</div>,
}));
vi.mock("./lib/data/eliza-agents", () => ({ useAgents: mockUseAgents }));
vi.mock("./lib/i18n", () => ({
  useT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentsPage response states", () => {
  it("shows the query validation failure instead of an empty table", () => {
    mockUseAgents.mockReturnValue({
      // Background refetch errors retain the last successful query data. The
      // page must still hide both halves of that stale healthy presentation.
      data: { agents: [{ agentName: "Stale agent" }], hostingSummary: {} },
      error: new Error("Invalid hosted-agent API response"),
      isError: true,
      isLoading: false,
    });

    render(<AgentsPage />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Invalid hosted-agent API response",
    );
    expect(screen.queryByText("Agents table")).toBeNull();
    expect(screen.queryByText("Pricing banner")).toBeNull();
  });

  it("fails visibly when a query resolves without its required data", () => {
    mockUseAgents.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: false,
    });

    render(<AgentsPage />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Agent data is unavailable",
    );
    expect(screen.queryByText("Agents table")).toBeNull();
  });
});
