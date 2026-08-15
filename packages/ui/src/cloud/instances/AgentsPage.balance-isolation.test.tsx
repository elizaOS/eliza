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
  }: {
    creditBalance: number | null;
  }) => (
    <div>Balance: {creditBalance === null ? "unavailable" : creditBalance}</div>
  ),
}));
vi.mock("./components/eliza-agents-table", () => ({
  ElizaAgentsTable: ({
    sandboxes,
  }: {
    sandboxes: Array<{ agent_name: string }>;
  }) => <div>{sandboxes.map((sandbox) => sandbox.agent_name).join(", ")}</div>,
}));
vi.mock("./lib/data/eliza-agents", () => ({
  useAgents: () => ({
    data: [
      {
        id: "agent-1",
        agentName: "Persistent agent",
        status: "running",
        webUiUrl: null,
        dockerImage: null,
        executionTier: "shared",
        errorMessage: null,
        lastHeartbeatAt: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
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

    expect(screen.getByText("Persistent agent")).toBeTruthy();
    expect(screen.getByText("Balance: unavailable")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
