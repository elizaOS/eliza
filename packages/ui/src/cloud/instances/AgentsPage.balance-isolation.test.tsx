/** Verifies agent rows remain available when the independent credit-balance read fails. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentsPage from "./AgentsPage";

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
  ElizaAgentPricingBanner: ({
    creditBalance,
    sharedCount,
    runningCount,
    idleCount,
  }: {
    creditBalance: number | null;
    sharedCount: number;
    runningCount: number;
    idleCount: number;
  }) => (
    <div>
      Balance: {creditBalance === null ? "unavailable" : creditBalance} ·
      Shared: {sharedCount} · Paid running: {runningCount} · Paid idle:{" "}
      {idleCount}
    </div>
  ),
}));
vi.mock("./components/eliza-agents-table", () => ({
  ElizaAgentsTable: ({ agents }: { agents: Array<{ agentName: string }> }) => (
    <div>{agents.map((agent) => agent.agentName).join(", ")}</div>
  ),
}));
vi.mock("./lib/data/eliza-agents", () => ({
  useAgents: () => ({
    data: [
      {
        id: "agent-1",
        agentName: "Free shared agent",
        status: "running",
        databaseStatus: "ready",
        lastBackupAt: null,
        lastHeartbeatAt: null,
        errorMessage: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        token_address: null,
        token_chain: null,
        token_name: null,
        token_ticker: null,
        dockerImage: null,
        executionTier: "shared",
        webUiUrl: null,
      },
      {
        id: "agent-2",
        agentName: "Dedicated agent",
        status: "running",
        databaseStatus: "ready",
        lastBackupAt: null,
        lastHeartbeatAt: null,
        errorMessage: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        token_address: null,
        token_chain: null,
        token_name: null,
        token_ticker: null,
        dockerImage: null,
        executionTier: "dedicated-always",
        webUiUrl: null,
      },
    ],
    error: null,
    isError: false,
    isLoading: false,
  }),
}));
vi.mock("./lib/data/credits", () => ({
  useCreditsBalance: () => ({
    data: undefined,
    error: new Error("balance service unavailable"),
    isError: true,
    isLoading: false,
  }),
}));
vi.mock("./lib/i18n", () => ({
  useT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

afterEach(cleanup);

describe("AgentsPage balance isolation", () => {
  it("renders authoritative agent rows and marks only balance unavailable", () => {
    render(<AgentsPage />);

    expect(screen.getByText("Dedicated agent")).toBeTruthy();
    expect(screen.queryByText("Free shared agent")).toBeNull();
    expect(
      screen.getByText(
        "Balance: unavailable · Shared: 0 · Paid running: 1 · Paid idle: 0",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
