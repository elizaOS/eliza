/** Verifies the agent detail page keeps shared usage separate from hosting cost. */
// @vitest-environment jsdom

import type { AgentDetailDto } from "@elizaos/cloud-shared/lib/types/cloud-api";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetailPage from "./AgentDetailPage";

const { mockUseAgent } = vi.hoisted(() => ({ mockUseAgent: vi.fn() }));

vi.mock("../lib/use-document-title", () => ({ useDocumentTitle: vi.fn() }));
vi.mock("../lib/use-session-auth", () => ({
  useSessionAuth: () => ({ ready: true, authenticated: true }),
}));
vi.mock("./lib/data/eliza-agents", () => ({ useAgent: mockUseAgent }));
vi.mock("./lib/i18n", () => ({
  useT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));
vi.mock("./components/agent-actions", () => ({
  ElizaAgentActions: () => null,
}));
vi.mock("./components/docker-logs-viewer", () => ({
  DockerLogsViewer: () => null,
}));
vi.mock("./components/eliza-agent-backups-panel", () => ({
  ElizaAgentBackupsPanel: () => null,
}));
vi.mock("./components/eliza-agent-logs-viewer", () => ({
  ElizaAgentLogsViewer: () => null,
}));
vi.mock("./components/eliza-agent-tabs", () => ({
  ElizaAgentTabs: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/eliza-connect-button", () => ({
  ElizaConnectButton: () => null,
}));

const sharedAgent: AgentDetailDto = {
  id: "00000000-1111-2222-3333-444444444444",
  agentName: "Ada",
  status: "running",
  databaseStatus: "ready",
  lastBackupAt: null,
  lastHeartbeatAt: null,
  errorMessage: null,
  createdAt: "2026-07-04T00:00:00.000Z",
  updatedAt: "2026-07-04T00:00:00.000Z",
  token_address: null,
  token_chain: null,
  token_name: null,
  token_ticker: null,
  dockerImage: null,
  executionTier: "shared",
  hostingCost: {
    pricingState: "known",
    rateClass: "shared-usage",
    hourlyRateUsd: 0,
    monthlyEstimateUsd: 0,
  },
  webUiUrl: null,
  bridgeUrl: null,
  errorCount: 0,
  walletAddress: null,
  walletProvider: null,
  walletStatus: "none",
  adminDetails: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentDetailPage hosting cost", () => {
  it("shows shared runtime as usage-based without a dedicated hourly rate", () => {
    mockUseAgent.mockReturnValue({
      data: sharedAgent,
      error: null,
      isLoading: false,
    });

    render(
      <MemoryRouter initialEntries={[`/dashboard/agents/${sharedAgent.id}`]}>
        <Routes>
          <Route path="/dashboard/agents/:id" element={<AgentDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Usage-based")).toBeTruthy();
    expect(
      screen.getByText(
        "No continuous hosting charge — model usage billed separately based on usage",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("$0.01/hr")).toBeNull();
    const sharedStatuses = screen.getAllByText("Shared ready");
    expect(sharedStatuses.length).toBeGreaterThanOrEqual(2);
    expect(sharedStatuses[0]?.querySelector("span")?.className).toContain(
      "bg-muted-strong",
    );
    expect(screen.queryByText("running")).toBeNull();
  });

  it("keeps dedicated running status green and labels unavailable pricing", () => {
    mockUseAgent.mockReturnValue({
      data: {
        ...sharedAgent,
        executionTier: "dedicated-lazy",
        hostingCost: {
          pricingState: "unavailable",
          rateClass: "unavailable",
          hourlyRateUsd: null,
          monthlyEstimateUsd: null,
        },
      },
      error: null,
      isLoading: false,
    });

    render(
      <MemoryRouter initialEntries={[`/dashboard/agents/${sharedAgent.id}`]}>
        <Routes>
          <Route path="/dashboard/agents/:id" element={<AgentDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const runningStatuses = screen.getAllByText("running");
    expect(runningStatuses.length).toBeGreaterThanOrEqual(2);
    expect(runningStatuses[0]?.querySelector("span")?.className).toContain(
      "bg-status-success",
    );
    expect(screen.getByText("Pricing unavailable")).toBeTruthy();
    expect(
      screen.getByText(
        "A continuous hosting estimate is not available for this dedicated agent state.",
      ),
    ).toBeTruthy();
  });
});
