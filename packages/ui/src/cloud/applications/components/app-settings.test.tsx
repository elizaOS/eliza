/** Verifies AppSettings active-status Switch through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * `AppSettings` active-status Switch: no custom green ON-track override, the
 * visible "Active Status" label is the accessible name, and toggling updates
 * the save payload. Query client, i18n, and app mutations are doubled; the
 * form renders for real.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../lib/apps";
import { AppSettings } from "./app-settings";

const updateAppMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/apps", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/apps")>("../lib/apps");
  return {
    ...actual,
    updateApp: (...args: unknown[]) => updateAppMock(...args),
    deleteApp: vi.fn(),
    regenerateAppApiKey: vi.fn(),
  };
});

vi.mock("../lib/one-time-app-api-key", () => ({
  storeOneTimeAppApiKey: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      key: string,
      options?: Record<string, unknown> & { defaultValue?: string },
    ) =>
      (options?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(options?.[name] ?? ""),
      ),
}));

function makeApp(overrides: Partial<App> = {}): App {
  return {
    id: "app_1",
    name: "Draft App",
    description: "Settings fixture",
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
    contact_email: "ops@example.com",
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
    created_at: "2026-07-03T12:00:00.000Z",
    updated_at: "2026-07-03T12:00:00.000Z",
    last_used_at: null,
    ...overrides,
  };
}

function renderSettings(app: App) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AppSettings app={app} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  updateAppMock.mockReset();
});

describe("AppSettings active-status Switch", () => {
  it("uses the default accent ON / input OFF track and the Active Status name", () => {
    renderSettings(makeApp());

    const toggle = screen.getByRole("switch", { name: "Active Status" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-describedby")).toBe("is_active-hint");
    expect(toggle.className).not.toMatch(/bg-green-500/);
    expect(toggle.className).not.toMatch(/bg-neutral-700/);
    expect(toggle.className).toMatch(/data-\[state=checked\]:bg-accent/);
    expect(toggle.className).toMatch(/data-\[state=unchecked\]:bg-input/);
  });

  it("writes the toggled is_active value on save", async () => {
    updateAppMock.mockResolvedValue(undefined);
    const user = userEvent.setup({ delay: null });
    renderSettings(makeApp({ is_active: true }));

    await user.click(screen.getByRole("switch", { name: "Active Status" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(updateAppMock).toHaveBeenCalledWith(
      "app_1",
      expect.objectContaining({ is_active: false }),
    );
  });
});
