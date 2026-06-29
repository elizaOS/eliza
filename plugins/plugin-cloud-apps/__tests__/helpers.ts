/**
 * Shared test helpers for plugin-cloud-apps.
 *
 * Only the SDK client is mocked: {@link FakeElizaCloudClient} stands in for
 * `@elizaos/cloud-sdk`'s `ElizaCloudClient`, and its `listApps` / `getApp`
 * methods delegate to per-test functions installed via {@link setListApps} /
 * {@link setGetApp}. The actions/provider/formatters under test all run for real.
 */

import { mock } from "bun:test";
import type { AppDto, AppResponse, ListAppsResponse } from "@elizaos/cloud-sdk";
import type { IAgentRuntime, Memory } from "@elizaos/core";

type ListAppsFn = () => Promise<ListAppsResponse>;
type GetAppFn = (id: string) => Promise<AppResponse>;

const state: { listApps: ListAppsFn; getApp: GetAppFn } = {
  listApps: () => Promise.resolve({ success: true, apps: [] }),
  getApp: () =>
    Promise.resolve({ success: true, app: undefined as unknown as AppDto }),
};

export function setListApps(fn: ListAppsFn): void {
  state.listApps = fn;
}

export function setGetApp(fn: GetAppFn): void {
  state.getApp = fn;
}

/** Restore default (empty / no-op) behavior between tests. */
export function resetSdk(): void {
  state.listApps = () => Promise.resolve({ success: true, apps: [] });
  state.getApp = () =>
    Promise.resolve({ success: true, app: undefined as unknown as AppDto });
}

/** Stand-in for `ElizaCloudClient` — only the methods the read-core calls. */
export class FakeElizaCloudClient {
  listApps(): Promise<ListAppsResponse> {
    return state.listApps();
  }
  getApp(id: string): Promise<AppResponse> {
    return state.getApp(id);
  }
}

/** Build a minimal runtime exposing just `getSetting`. */
export function makeRuntime(
  settings: Record<string, string | undefined> = {},
): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] as unknown,
  } as unknown as IAgentRuntime;
}

/** A runtime with a valid Cloud API key configured. */
export function keyedRuntime(): IAgentRuntime {
  return makeRuntime({ ELIZAOS_CLOUD_API_KEY: "eliza_test_key" });
}

/** A runtime with no Cloud API key. */
export function unkeyedRuntime(): IAgentRuntime {
  return makeRuntime({});
}

/** Build a message Memory with the given text. */
export function makeMessage(text: string): Memory {
  return {
    content: { text },
  } as unknown as Memory;
}

/** A callback that records the content it was called with. */
export function captureCallback(): {
  fn: (content: { text?: string; actions?: string[] }) => Promise<Memory[]>;
  calls: Array<{ text?: string; actions?: string[] }>;
} {
  const calls: Array<{ text?: string; actions?: string[] }> = [];
  const fn = mock((content: { text?: string; actions?: string[] }) => {
    calls.push(content);
    return Promise.resolve([] as Memory[]);
  });
  return { fn, calls };
}

/** Minimal AppDto factory — fills only the fields the read-core reads. */
export function makeApp(overrides: Partial<AppDto> = {}): AppDto {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Test App",
    description: null,
    slug: "test-app",
    organization_id: "org-1",
    created_by_user_id: "user-1",
    app_url: "https://test-app.example.com",
    allowed_origins: [],
    api_key_id: null,
    affiliate_code: null,
    referral_bonus_credits: null,
    total_requests: 0,
    total_users: 0,
    total_credits_used: null,
    logo_url: null,
    website_url: null,
    contact_email: null,
    metadata: {},
    deployment_status: "draft",
    production_url: null,
    last_deployed_at: null,
    github_repo: null,
    linked_character_ids: null,
    monetization_enabled: false,
    inference_markup_percentage: null,
    purchase_share_percentage: null,
    platform_offset_amount: null,
    custom_pricing_enabled: null,
    total_creator_earnings: null,
    total_platform_revenue: null,
    discord_automation: null,
    telegram_automation: null,
    twitter_automation: null,
    promotional_assets: null,
    email_notifications: null,
    response_notifications: null,
    is_active: true,
    is_approved: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
    ...overrides,
  };
}
