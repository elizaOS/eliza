/** Verifies that Dedicated activation renders and confirms only the server quote. */
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaAgentActions } from "./agent-actions";

const apiWithStatus = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiWithStatus,
  readCloudBearerToken: () => "cloud-token",
}));

vi.mock("sonner", () => ({ toast }));

vi.mock("../lib/i18n", () => ({
  useT: () => (_key: string, options?: Record<string, unknown>) => {
    let text = String(options?.defaultValue ?? _key);
    for (const [name, value] of Object.entries(options ?? {})) {
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
    return text;
  },
}));

vi.mock("../lib/use-job-poller", () => ({
  useJobPoller: () => ({
    getStatus: () => null,
    isActive: () => false,
    track: vi.fn(),
  }),
}));

vi.mock("../lib/open-web-ui", () => ({
  openWebUIWithPairing: vi.fn(),
}));

vi.mock("../../handoff/start-tier-upgrade", () => ({
  runSharedToDedicatedUpgradeHandoff: vi.fn(),
}));

vi.mock("../../../api", () => ({
  ElizaClient: class {},
}));

const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
const QUOTE = {
  quoteId: "a".repeat(64),
  sourceAgentId: PERSONAL_ID,
  hourlyRateUsd: 0.01,
  dailyRateUsd: 0.24,
  minimumBalanceUsd: 0.72,
  minimumRunwayDays: 3,
  balanceUsd: 1.25,
  deficitUsd: 0,
  canActivate: true,
  requiresConfirmation: true as const,
  action: "activate_dedicated" as const,
  activation: { state: "available" as const },
};

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

function renderActions() {
  renderWithQueryClient(
    <MemoryRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ElizaAgentActions
              agentId={PERSONAL_ID}
              executionTier="shared"
              status="running"
              webUiUrl={null}
            />
          }
        />
        <Route path="/cloud/billing" element={<p>Billing destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Dedicated activation quote", () => {
  beforeEach(() => {
    apiWithStatus.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads and renders the server-owned quote before offering activation", async () => {
    apiWithStatus.mockResolvedValueOnce({
      status: 200,
      data: { success: true, data: QUOTE },
    });
    renderActions();

    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));

    expect(
      await screen.findByText(
        "Current balance: $1.25 · Required before activation: $0.72 (3 days)",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your Shared Agent becomes a private, always-on Dedicated Agent. Dedicated hosting uses $0.24 per day ($0.01/hr) while running.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Activate Dedicated" }),
    ).toBeTruthy();
    expect(apiWithStatus).toHaveBeenCalledWith(
      `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}/upgrade-tier`,
      { method: "GET" },
    );
  });

  it("keeps lifecycle controls while removing the manual snapshot action", () => {
    renderWithQueryClient(
      <MemoryRouter>
        <ElizaAgentActions
          agentId="dedicated-agent"
          executionTier="dedicated-always"
          status="running"
          webUiUrl="https://agent.example"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Open Web UI" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Suspend Agent" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Deactivate Agent" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete Agent" })).toBeTruthy();
    expect(screen.queryByText("Agent Actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Snapshot" })).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /backup|snapshot|container|runtime|compute/i,
    );
  });

  it("keeps shared agents persistent while offering explicit Dedicated activation", () => {
    renderActions();

    expect(
      screen.getByRole("button", { name: "Upgrade to Dedicated" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Suspend Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Agent" })).toBeNull();
    expect(screen.queryByText("Agent Actions")).toBeNull();
  });

  it("posts the exact quote and explicit action instead of client-computed terms", async () => {
    apiWithStatus
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValueOnce({
        status: 402,
        data: { error: "Add credits before activating Dedicated." },
      });
    renderActions();

    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Activate Dedicated" }),
    );

    await waitFor(() => expect(apiWithStatus).toHaveBeenCalledTimes(2));
    expect(apiWithStatus).toHaveBeenLastCalledWith(
      `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}/upgrade-tier`,
      {
        method: "POST",
        json: {
          action: "activate_dedicated",
          quoteId: QUOTE.quoteId,
        },
      },
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Add credits before activating Dedicated.",
    );
  });

  it("shows a credit action instead of an activation button when the server denies the quote", async () => {
    apiWithStatus.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: {
          ...QUOTE,
          balanceUsd: 0,
          deficitUsd: 0.72,
          canActivate: false,
          unavailableReason: "Add credits to activate Dedicated.",
        },
      },
    });
    renderActions();

    await userEvent.click(
      await screen.findByRole("button", { name: "Add funds to upgrade" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Add credits to activate Dedicated.",
    );
    expect(
      screen.getByRole("button", { name: "Add funds to upgrade" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Add funds to upgrade" }),
    );
    expect(screen.getByText("Billing destination")).toBeTruthy();
  });
});
