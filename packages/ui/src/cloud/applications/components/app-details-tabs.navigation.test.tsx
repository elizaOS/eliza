// @vitest-environment jsdom

/**
 * Cross-tab application-detail calls to action stay inside the controlled
 * Projects embed while the standalone Cloud console continues to route by URL.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { type Location, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../lib/apps";
import { AppDetailsTabs, type AppDetailsTabValue } from "./app-details-tabs";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api-client")>(
    "../../lib/api-client",
  );
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

vi.mock("../../shell/CloudI18nProvider", () => {
  const t = (
    key: string,
    options?: Record<string, unknown> & { defaultValue?: string },
  ) => {
    let value = options?.defaultValue ?? key;
    for (const [name, replacement] of Object.entries(options ?? {})) {
      if (name !== "defaultValue") {
        value = value.replaceAll(`{{${name}}}`, String(replacement));
      }
    }
    return value;
  };
  return { useCloudT: () => t };
});

vi.mock("../lib/native-cloud-nav", () => ({
  openCloudConsoleRouteExternally: () => false,
  openExternalUrlOnNative: () => false,
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;

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
  total_creator_earnings: "12.50",
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

const MONETIZATION_RESPONSE = {
  success: true,
  monetization: {
    monetizationEnabled: false,
    inferenceMarkupPercentage: 25,
    purchaseSharePercentage: 10,
    platformOffsetAmount: 1,
    totalCreatorEarnings: 12.5,
  },
};

const EMPTY_EARNINGS_RESPONSE = {
  success: true,
  monetization: { enabled: false },
  earnings: {
    summary: null,
    breakdown: null,
    chartData: [],
    recentTransactions: [],
  },
};

function LocationProbe() {
  const location: Location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function EmbeddedHarness({ initialTab }: { initialTab: AppDetailsTabValue }) {
  const [activeTab, setActiveTab] = useState<AppDetailsTabValue>(initialTab);
  return (
    <>
      <AppDetailsTabs
        app={APP}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      <output data-testid="active-tab">{activeTab}</output>
      <LocationProbe />
    </>
  );
}

function renderDetails(
  children: React.ReactNode,
  initialEntry = "/projects/project-1?tab=publish",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockApplicationApis() {
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/v1/apps/app_1/monetization") {
      return Promise.resolve(MONETIZATION_RESPONSE);
    }
    if (path.startsWith("/api/v1/apps/app_1/earnings?")) {
      return Promise.resolve(EMPTY_EARNINGS_RESPONSE);
    }
    return Promise.reject(new Error(`Unexpected API call: ${path}`));
  });
}

async function findOverviewMonetizeCta(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", {
    name: "Monetization",
  });
  const card = heading.closest(".bg-card");
  if (!(card instanceof HTMLElement)) {
    throw new Error("Monetization overview card was not rendered");
  }
  return within(card).getByRole("button", { name: "Monetize" });
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("AppDetailsTabs cross-tab navigation", () => {
  it("opens Monetize from Overview inside the controlled embed", async () => {
    mockApplicationApis();
    renderDetails(<EmbeddedHarness initialTab="overview" />);

    await userEvent.click(await findOverviewMonetizeCta());

    expect(screen.getByTestId("active-tab").textContent).toBe("monetization");
    expect(screen.getByTestId("location").textContent).toBe(
      "/projects/project-1?tab=publish",
    );
  });

  it("opens Settings from Overview inside the controlled embed", async () => {
    mockApplicationApis();
    renderDetails(<EmbeddedHarness initialTab="overview" />);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByTestId("active-tab").textContent).toBe("settings");
    expect(screen.getByTestId("location").textContent).toBe(
      "/projects/project-1?tab=publish",
    );
  });

  it("opens Earnings from Monetize inside the controlled embed", async () => {
    mockApplicationApis();
    renderDetails(<EmbeddedHarness initialTab="monetization" />);

    await userEvent.click(
      await screen.findByRole("button", { name: "$12.50 earned" }),
    );

    expect(screen.getByTestId("active-tab").textContent).toBe("earnings");
    expect(screen.getByTestId("location").textContent).toBe(
      "/projects/project-1?tab=publish",
    );
  });

  it("opens Monetize from an empty Earnings tab inside the controlled embed", async () => {
    mockApplicationApis();
    renderDetails(<EmbeddedHarness initialTab="earnings" />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Enable Monetization" }),
    );

    expect(screen.getByTestId("active-tab").textContent).toBe("monetization");
    expect(screen.getByTestId("location").textContent).toBe(
      "/projects/project-1?tab=publish",
    );
  });

  it("preserves URL-backed tab routing in the standalone Cloud console", async () => {
    mockApplicationApis();
    renderDetails(
      <>
        <AppDetailsTabs app={APP} />
        <LocationProbe />
      </>,
      "/dashboard/apps/app_1?tab=overview&showApiKey=eliza_once",
    );

    await userEvent.click(await findOverviewMonetizeCta());

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/dashboard/apps/app_1?tab=monetization",
      ),
    );
  });
});
