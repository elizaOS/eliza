// @vitest-environment jsdom

/**
 * `AppMonetizationSettings` review gate: a draft app must be submitted for
 * review before monetization can be enabled, an approved app renders an enabled
 * toggle with no submit button, and a rejected/pending app stays gated (with
 * resubmission offered). A legacy enabled-but-unapproved app can always be
 * turned OFF — never trapped ON. The api-client, `sonner`, i18n provider, and
 * native nav are doubled; the component renders for real.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../lib/apps";
import { AppMonetizationSettings } from "./app-monetization-settings";

const apiMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api-client")>(
    "../../lib/api-client",
  );
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("../../shell/CloudI18nProvider", () => {
  const t = (
    _key: string,
    options?: Record<string, unknown> & { defaultValue?: string },
  ) => {
    let value = options?.defaultValue ?? _key;
    for (const [key, replacement] of Object.entries(options ?? {})) {
      if (key !== "defaultValue") {
        value = value.replace(
          new RegExp(`\\{\\{${key}\\}\\}`, "g"),
          String(replacement),
        );
      }
    }
    return value;
  };
  return { useCloudT: () => t };
});

vi.mock("../lib/native-cloud-nav", () => ({
  openCloudConsoleRouteExternally: () => false,
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;

function makeApp(overrides: Partial<App> = {}): App {
  return {
    id: "app_1",
    name: "Draft App",
    description: "Draft monetization app",
    slug: "draft-app",
    organization_id: "org_1",
    created_by_user_id: "user_1",
    app_url: "https://draft.example.com",
    allowed_origins: ["https://draft.example.com"],
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
    review_status: "draft",
    review_content_hash: null,
    reviewed_at: null,
    created_at: "2026-07-03T12:00:00.000Z",
    updated_at: "2026-07-03T12:00:00.000Z",
    last_used_at: null,
    ...overrides,
  };
}

function renderMonetization(app: App) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AppMonetizationSettings app={app} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
});

describe("AppMonetizationSettings review gate", () => {
  it("submits a draft app for review before enabling monetization", async () => {
    apiMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === "/api/v1/apps/app_1/monetization" && !init) {
        return Promise.resolve({
          success: true,
          monetization: {
            monetizationEnabled: false,
            inferenceMarkupPercentage: 25,
            purchaseSharePercentage: 10,
            platformOffsetAmount: 1,
            totalCreatorEarnings: 0,
          },
        });
      }
      if (path === "/api/v1/apps/app_1/review" && init?.method === "POST") {
        return Promise.resolve({
          success: true,
          review: {
            review_status: "approved",
            rationale: "Allowed for monetization.",
          },
        });
      }
      if (
        path === "/api/v1/apps/app_1/monetization" &&
        init?.method === "PUT"
      ) {
        return Promise.resolve({ success: true });
      }
      return Promise.reject(new Error(`Unexpected API call: ${path}`));
    });

    const user = userEvent.setup({ delay: null });
    renderMonetization(makeApp());

    expect(await screen.findByText("Review required")).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.click(screen.getByRole("button", { name: "Submit for review" }));

    expect(await screen.findByText("Review approved")).toBeTruthy();
    expect(screen.getByText("Allowed for monetization.")).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app_1/review", {
      method: "POST",
    });

    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: "Start Earning" }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app_1/monetization", {
        method: "PUT",
        json: {
          monetizationEnabled: true,
          inferenceMarkupPercentage: 25,
          purchaseSharePercentage: 10,
        },
      }),
    );
  });

  it("lets a legacy enabled-but-unapproved app be turned OFF (never traps it ON)", async () => {
    apiMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === "/api/v1/apps/app_1/monetization" && !init) {
        // Legacy row: monetization is ON server-side even though the app has
        // not passed review. The server always allows DISABLING.
        return Promise.resolve({
          success: true,
          monetization: {
            monetizationEnabled: true,
            inferenceMarkupPercentage: 25,
            purchaseSharePercentage: 10,
            platformOffsetAmount: 1,
            totalCreatorEarnings: 0,
          },
        });
      }
      if (
        path === "/api/v1/apps/app_1/monetization" &&
        init?.method === "PUT"
      ) {
        return Promise.resolve({ success: true });
      }
      return Promise.reject(new Error(`Unexpected API call: ${path}`));
    });

    const user = userEvent.setup({ delay: null });
    // review_status stays unapproved (draft) despite monetization being on.
    renderMonetization(makeApp({ monetization_enabled: true }));

    // The switch must render ENABLED (interactive) so the user can turn it off —
    // the old `disabled={!reviewApproved}` trapped it ON.
    const switchEl = (await screen.findByRole("switch")) as HTMLButtonElement;
    expect(switchEl.disabled).toBe(false);
    expect(switchEl.getAttribute("aria-checked")).toBe("true");

    // Turning it OFF hits the update path directly (no enable dialog, no block).
    await user.click(switchEl);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app_1/monetization", {
        method: "PUT",
        json: {
          monetizationEnabled: false,
          inferenceMarkupPercentage: 25,
          purchaseSharePercentage: 10,
        },
      }),
    );
    // It must NOT have been blocked with the review-required error.
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("renders an already-approved app with an enabled toggle and no submit button", async () => {
    apiMock.mockResolvedValue({
      success: true,
      monetization: {
        monetizationEnabled: false,
        inferenceMarkupPercentage: 25,
        purchaseSharePercentage: 10,
        platformOffsetAmount: 1,
        totalCreatorEarnings: 0,
      },
    });

    renderMonetization(makeApp({ review_status: "approved" }));

    expect(await screen.findByText("Review approved")).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      screen.queryByRole("button", { name: "Submit for review" }),
    ).toBeNull();
  });

  it("keeps the toggle gated on a rejected app and offers resubmission", async () => {
    apiMock.mockResolvedValue({
      success: true,
      monetization: {
        monetizationEnabled: false,
        inferenceMarkupPercentage: 25,
        purchaseSharePercentage: 10,
        platformOffsetAmount: 1,
        totalCreatorEarnings: 0,
      },
    });

    renderMonetization(makeApp({ review_status: "rejected" }));

    expect(await screen.findByText("Review rejected")).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      screen.getByRole("button", { name: "Submit for review" }),
    ).toBeTruthy();
  });

  it("keeps the toggle gated while a review is pending", async () => {
    apiMock.mockResolvedValue({
      success: true,
      monetization: {
        monetizationEnabled: false,
        inferenceMarkupPercentage: 25,
        purchaseSharePercentage: 10,
        platformOffsetAmount: 1,
        totalCreatorEarnings: 0,
      },
    });

    renderMonetization(makeApp({ review_status: "under_review" }));

    expect(await screen.findByText("Review in progress")).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      screen.queryByRole("button", { name: "Submit for review" }),
    ).toBeNull();
  });
});
