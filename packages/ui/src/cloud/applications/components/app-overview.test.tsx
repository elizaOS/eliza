// @vitest-environment jsdom

/**
 * Container deployment controls expose the Cloud capability gate before any
 * mutation is possible, including loading, unavailable, and failed reads.
 * The adjacent monetization summary also renders transport failure explicitly.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../lib/apps";
import { AppOverview } from "./app-overview";

const apiMock = vi.hoisted(() => vi.fn());
const capabilityMock = vi.hoisted(() => vi.fn());
const deployMock = vi.hoisted(() => vi.fn());
const latestDeploymentMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      key: string,
      options?: Record<string, unknown> & { defaultValue?: string },
    ) =>
      options?.defaultValue ?? key,
}));

vi.mock("../lib/apps", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/apps")>("../lib/apps");
  return {
    ...actual,
    deployApp: (...args: unknown[]) => deployMock(...args),
    getAppDeployCapability: (...args: unknown[]) => capabilityMock(...args),
    getLatestAppDeployment: (...args: unknown[]) =>
      latestDeploymentMock(...args),
  };
});

vi.mock("../lib/native-cloud-nav", () => ({
  openExternalUrlOnNative: () => false,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const APP: App = {
  id: "app_1",
  name: "Habit Tracker",
  description: "Build better habits",
  slug: "habit-tracker",
  organization_id: "org_1",
  created_by_user_id: "user_1",
  app_url: "https://habit-tracker.sites.elizacloud.ai",
  allowed_origins: ["https://habit-tracker.sites.elizacloud.ai"],
  api_key_id: null,
  affiliate_code: null,
  referral_bonus_credits: "0.00",
  total_requests: 0,
  total_users: 0,
  total_credits_used: "0.00",
  logo_url: null,
  website_url: null,
  contact_email: null,
  metadata: {},
  deployment_status: "draft",
  production_url: null,
  last_deployed_at: null,
  github_repo: null,
  linked_character_ids: [],
  monetization_enabled: false,
  inference_markup_percentage: 25,
  purchase_share_percentage: 10,
  platform_offset_amount: 1,
  custom_pricing_enabled: false,
  total_creator_earnings: "0.00",
  total_platform_revenue: "0.00",
  discord_automation: null,
  telegram_automation: null,
  twitter_automation: null,
  promotional_assets: null,
  user_database_status: "none",
  user_database_uri: null,
  user_database_region: null,
  user_database_error: null,
  email_notifications: true,
  response_notifications: true,
  is_active: true,
  is_approved: true,
  review_status: "approved",
  review_content_hash: null,
  reviewed_at: null,
  created_at: "2026-07-23T00:00:00.000Z",
  updated_at: "2026-07-23T00:00:00.000Z",
  last_used_at: null,
};

function renderOverview() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AppOverview app={APP} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockResolvedValue({
    success: true,
    monetization: {
      monetizationEnabled: false,
      totalCreatorEarnings: 0,
    },
  });
  deployMock.mockResolvedValue(undefined);
  latestDeploymentMock.mockResolvedValue({
    deploymentId: null,
    status: "DRAFT",
    vercelUrl: null,
    error: null,
    startedAt: null,
    completedAt: null,
  });
});

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  capabilityMock.mockReset();
  deployMock.mockReset();
  latestDeploymentMock.mockReset();
});

describe("AppOverview container deployment capability", () => {
  it("shows a loading state without rendering the mutation form", async () => {
    capabilityMock.mockReturnValue(new Promise(() => undefined));
    renderOverview();

    expect(screen.getByText("Checking container availability…")).toBeTruthy();
    expect(await screen.findByText("Disabled")).toBeTruthy();
    expect(screen.queryByLabelText("Repository URL")).toBeNull();
    expect(deployMock).not.toHaveBeenCalled();
  });

  it("shows an organization-gated unavailable state without deployment controls", async () => {
    capabilityMock.mockResolvedValue({
      enabled: false,
      reason: "organization_not_allowlisted",
    });
    renderOverview();

    expect(
      await screen.findByText("Available when enabled for your organization."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Repository URL")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
    expect(deployMock).not.toHaveBeenCalled();
  });

  it("shows a retryable error without deployment controls", async () => {
    capabilityMock.mockRejectedValue(new Error("Cloud capability unavailable"));
    renderOverview();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Container availability could not be checked",
    );
    expect(alert.textContent).toContain("Cloud capability unavailable");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByLabelText("Repository URL")).toBeNull();
    expect(deployMock).not.toHaveBeenCalled();
  });

  it("renders and submits the deployment form only when capability is enabled", async () => {
    capabilityMock.mockResolvedValue({ enabled: true });
    renderOverview();

    const repoInput = await screen.findByLabelText("Repository URL");
    const refInput = screen.getByLabelText("Commit SHA");
    await userEvent.type(repoInput, "https://github.com/eliza/habit-tracker");
    await userEvent.type(refInput, "a".repeat(40));
    await userEvent.click(screen.getByRole("button", { name: "Deploy" }));

    await waitFor(() =>
      expect(deployMock).toHaveBeenCalledWith("app_1", {
        repoUrl: "https://github.com/eliza/habit-tracker",
        ref: "a".repeat(40),
      }),
    );
  });

  it("renders a retryable monetization-summary error instead of hiding the card", async () => {
    capabilityMock.mockResolvedValue({ enabled: true });
    apiMock.mockRejectedValue(new Error("Monetization service unavailable"));
    renderOverview();

    expect(
      await screen.findByText("Monetization service unavailable"),
    ).toBeTruthy();
    expect(
      screen.getByText("Monetization service unavailable").getAttribute("role"),
    ).toBe("alert");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
