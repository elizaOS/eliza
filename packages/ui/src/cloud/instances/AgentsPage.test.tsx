import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentsPage from "./AgentsPage";

const agentsState = vi.hoisted(() => ({
  query: {
    data: undefined as unknown,
    error: null as unknown,
    isError: false,
    isLoading: false,
  },
  credits: {
    data: { balance: 12.5 },
  },
}));

vi.mock("@elizaos/ui/cloud-ui", () => ({
  ContainersSkeleton: () => <div data-testid="agents-skeleton" />,
  DashboardErrorState: ({ message }: { message: string }) => (
    <div role="alert">{message}</div>
  ),
  DashboardLoadingState: ({ label }: { label: string }) => <div>{label}</div>,
  DashboardPageContainer: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  ElizaAgentsPageWrapper: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));

vi.mock("../lib/use-document-title", () => ({
  useDocumentTitle: () => {},
}));

vi.mock("../lib/use-session-auth", () => ({
  useRequireAuth: () => ({ authenticated: true, ready: true }),
}));

vi.mock("./components/eliza-agent-pricing-banner", () => ({
  ElizaAgentPricingBanner: ({
    runningCount,
    idleCount,
  }: {
    runningCount: number;
    idleCount: number;
  }) => (
    <div data-testid="pricing-banner">
      running {runningCount} idle {idleCount}
    </div>
  ),
}));

vi.mock("./components/eliza-agents-table", () => ({
  ElizaAgentsTable: ({ sandboxes }: { sandboxes: unknown[] }) => (
    <div data-testid="agents-table">{sandboxes.length} rows</div>
  ),
}));

vi.mock("./lib/data/credits", () => ({
  useCreditsBalance: () => agentsState.credits,
}));

vi.mock("./lib/data/eliza-agents", () => ({
  useAgents: () => agentsState.query,
}));

vi.mock("./lib/i18n", () => ({
  useT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? "",
}));

afterEach(() => {
  cleanup();
  agentsState.query = {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  };
});

describe("AgentsPage", () => {
  it("does not render pricing or empty table semantics while agents are loading", () => {
    agentsState.query = {
      data: undefined,
      error: null,
      isError: false,
      isLoading: true,
    };

    render(<AgentsPage />);

    expect(screen.getByTestId("agents-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("pricing-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agents-table")).not.toBeInTheDocument();
  });

  it("renders an explicit error state instead of an empty table on query failure", () => {
    agentsState.query = {
      data: undefined,
      error: new Error("instances unavailable"),
      isError: true,
      isLoading: false,
    };

    render(<AgentsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "instances unavailable",
    );
    expect(screen.queryByTestId("pricing-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agents-table")).not.toBeInTheDocument();
  });

  it("renders pricing and table after agents resolve", () => {
    agentsState.query = {
      data: [
        {
          agentName: "Launch Agent",
          createdAt: "2026-07-04T00:00:00Z",
          dockerImage: "eliza:test",
          errorMessage: null,
          executionTier: "shared",
          id: "agent-1",
          lastHeartbeatAt: null,
          status: "running",
          updatedAt: "2026-07-04T00:00:00Z",
          webUiUrl: "https://example.test",
        },
      ],
      error: null,
      isError: false,
      isLoading: false,
    };

    render(<AgentsPage />);

    expect(screen.getByTestId("pricing-banner")).toHaveTextContent(
      "running 1 idle 0",
    );
    expect(screen.getByTestId("agents-table")).toHaveTextContent("1 rows");
  });
});
