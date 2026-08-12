/** Proves hosted-agent query reads reject rolling-old and malformed wire contracts. */
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));

vi.mock("../../../lib/api-client", () => ({ api: mockApi }));
vi.mock("../../../lib/auth-query", () => ({
  authenticatedQueryKey: (parts: readonly unknown[]) => parts,
  useAuthenticatedQueryGate: () => ({ enabled: true, userId: "user-1" }),
}));

import {
  AGENTS_QUERY_KEY,
  fetchAgent,
  fetchAgents,
  useAgents,
} from "./eliza-agents";

const validAgent = {
  id: "00000000-1111-4222-8333-444444444444",
  agentName: "Ada",
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
  hostingCost: {
    pricingState: "known",
    rateClass: "shared-usage",
    hourlyRateUsd: 0,
    monthlyEstimateUsd: 0,
  },
  webUiUrl: null,
} as const;

const validSummary = {
  pricingState: "complete",
  sharedCount: 1,
  dedicatedRunningCount: 0,
  dedicatedIdleCount: 0,
  dedicatedDeactivatedCount: 0,
  unavailableDedicatedCount: 0,
  hasAgents: true,
  hasDedicatedHosting: false,
  hourlyHostingCostUsd: 0,
  monthlyHostingCostUsd: 0,
  creditBalanceUsd: 5,
  hoursRemaining: null,
  lowBalance: false,
  dedicatedRunningHourlyRateUsd: 0.01,
  dedicatedRunningMonthlyEstimateUsd: 7.2,
  dedicatedIdleHourlyRateUsd: 0.0025,
  dedicatedIdleMonthlyEstimateUsd: 1.8,
  minimumDepositUsd: 2,
  lowCreditWarningUsd: 1,
} as const;

beforeEach(() => {
  mockApi.mockReset();
});

describe("hosted-agent query boundary", () => {
  it("accepts the complete canonical response", async () => {
    mockApi.mockResolvedValueOnce({
      success: true,
      data: [validAgent],
      hostingSummary: validSummary,
    });

    await expect(fetchAgents()).resolves.toEqual({
      agents: [validAgent],
      hostingSummary: validSummary,
    });
  });

  it("rejects a rolling-old list response without hostingSummary", async () => {
    mockApi.mockResolvedValueOnce({ success: true, data: [validAgent] });

    await expect(fetchAgents()).rejects.toThrow();
  });

  it("rejects a rolling-old row without hostingCost", async () => {
    const { hostingCost: _hostingCost, ...oldAgent } = validAgent;
    mockApi.mockResolvedValueOnce({
      success: true,
      data: [oldAgent],
      hostingSummary: validSummary,
    });

    await expect(fetchAgents()).rejects.toThrow();
  });

  it("rejects a fabricated zero price marked unavailable", async () => {
    mockApi.mockResolvedValueOnce({
      success: true,
      data: [
        {
          ...validAgent,
          executionTier: "dedicated-lazy",
          hostingCost: {
            pricingState: "unavailable",
            rateClass: "unavailable",
            hourlyRateUsd: 0,
            monthlyEstimateUsd: 0,
          },
        },
      ],
      hostingSummary: validSummary,
    });

    await expect(fetchAgents()).rejects.toThrow();
  });

  it("rejects unknown execution tiers and lifecycle statuses", async () => {
    for (const invalidAgent of [
      { ...validAgent, executionTier: "legacy-sandbox" },
      { ...validAgent, status: "healthy" },
    ]) {
      mockApi.mockResolvedValueOnce({
        success: true,
        data: [invalidAgent],
        hostingSummary: validSummary,
      });
      await expect(fetchAgents()).rejects.toThrow();
    }
  });

  it("rejects a detail response without the required hostingCost", async () => {
    const { hostingCost: _hostingCost, ...oldAgent } = validAgent;
    mockApi.mockResolvedValueOnce({
      success: true,
      data: {
        ...oldAgent,
        bridgeUrl: null,
        errorCount: 0,
        walletAddress: null,
        walletProvider: null,
        walletStatus: "none",
        adminDetails: null,
      },
    });

    await expect(fetchAgent(validAgent.id)).rejects.toThrow();
  });
});

function queryWrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

function useObservedAgents() {
  const query = useAgents();
  return {
    data: query.data,
    error: query.error,
    isError: query.isError,
    isSuccess: query.isSuccess,
  };
}

describe("hosted-agent canonical query refresh", () => {
  it("updates rows and hosting summary from one validated result", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockApi.mockResolvedValueOnce({
      success: true,
      data: [validAgent],
      hostingSummary: validSummary,
    });
    const { result } = renderHook(useObservedAgents, {
      wrapper: queryWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const updatedAgent = {
      ...validAgent,
      agentName: "Grace",
      executionTier: "dedicated-always",
      hostingCost: {
        pricingState: "known",
        rateClass: "running",
        hourlyRateUsd: 0.02,
        monthlyEstimateUsd: 14.4,
      },
    } as const;
    const updatedSummary = {
      ...validSummary,
      sharedCount: 0,
      dedicatedRunningCount: 1,
      hasDedicatedHosting: true,
      hourlyHostingCostUsd: 0.02,
      monthlyHostingCostUsd: 14.4,
      hoursRemaining: 250,
    } as const;
    mockApi.mockResolvedValueOnce({
      success: true,
      data: [updatedAgent],
      hostingSummary: updatedSummary,
    });

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: AGENTS_QUERY_KEY });
    });

    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    await waitFor(() =>
      expect(result.current.data).toEqual({
        agents: [updatedAgent],
        hostingSummary: updatedSummary,
      }),
    );
  });

  it("exposes a malformed active refresh as error even with retained cache data", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const activeAgent = { ...validAgent, status: "provisioning" } as const;
    mockApi.mockResolvedValueOnce({
      success: true,
      data: [activeAgent],
      hostingSummary: validSummary,
    });
    const { result } = renderHook(useObservedAgents, {
      wrapper: queryWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    mockApi.mockResolvedValueOnce({ success: true, data: [activeAgent] });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: AGENTS_QUERY_KEY });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
    // React Query retains prior data for recovery, so the page must prioritize
    // this error state before rendering either the rows or their summary.
    expect(result.current.data).toEqual({
      agents: [activeAgent],
      hostingSummary: validSummary,
    });
  });
});
