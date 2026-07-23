// @vitest-environment jsdom

/**
 * Project-mode publication settings prove unpublish is a confirmed,
 * non-destructive operation and the generic active switch is not exposed.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { App } from "../lib/apps";

const updateMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
const deleteMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
const regenerateMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => "eliza_new"),
);
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/apps", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/apps")>("../lib/apps");
  return {
    ...actual,
    updateApp: (...args: unknown[]) => updateMock(...args),
    deleteApp: (...args: unknown[]) => deleteMock(...args),
    regenerateAppApiKey: (...args: unknown[]) => regenerateMock(...args),
  };
});
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
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
vi.mock("../lib/one-time-app-api-key", () => ({
  storeOneTimeAppApiKey: vi.fn(),
}));

import { AppSettings } from "./app-settings";

function makeApp(): App {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Published Project",
    description: "Description",
    slug: "published-project",
    organization_id: "org-1",
    created_by_user_id: "user-1",
    app_url: "https://published-project.sites.elizacloud.ai",
    allowed_origins: ["https://published-project.sites.elizacloud.ai"],
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
    inference_markup_percentage: 0,
    purchase_share_percentage: 0,
    platform_offset_amount: 0,
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
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
    last_used_at: null,
  };
}

function renderSettings(props: {
  onUnpublish: () => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AppSettings
          app={makeApp()}
          projectPublication
          onUnpublish={props.onUnpublish}
          {...(props.onDelete ? { onDelete: props.onDelete } : {})}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppSettings project publication mode", () => {
  it("requires confirmation before unpublishing and never deletes", async () => {
    const onUnpublish = vi.fn(async () => undefined);
    const onDelete = vi.fn(async () => undefined);
    renderSettings({ onUnpublish, onDelete });

    expect(screen.queryByText("Active Status")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Unpublish project" }));
    expect(onUnpublish).not.toHaveBeenCalled();
    expect(screen.getByText("Unpublish this project?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Yes, unpublish" }));
    await waitFor(() => expect(onUnpublish).toHaveBeenCalledOnce());
    expect(onDelete).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
