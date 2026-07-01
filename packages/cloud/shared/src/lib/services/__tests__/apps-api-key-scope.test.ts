/**
 * Guard test for #10852 — per-app API keys must not act on sibling apps.
 *
 * A per-app API key (`apps.api_key_id`) is minted as a plain org credential, so
 * on its own it authorizes every org-scoped `/apps/:id/*` route. `appsService.
 * isApiKeyScopedToOtherApp` is the shared guard the app routes now call to
 * reject a key owned by a DIFFERENT app while leaving org-level keys and session
 * auth untouched. These tests drive the real guard (only its repo + cache
 * boundaries are stubbed), covering both the allowed and denied paths.
 */
import { describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const APP_A = "aaaaaaaa-0000-4000-8000-000000000001";
const APP_B = "bbbbbbbb-0000-4000-8000-000000000002";
const KEY_A = "key-owned-by-app-a";
const ORG_KEY = "org-level-key-owned-by-no-app";

// Force a cache miss so getByApiKeyId resolves through the (mocked) repository.
mock.module("../../cache/client", () => ({
  cache: {
    get: mock(async () => null),
    set: mock(async () => undefined),
    del: mock(async () => undefined),
  },
}));

// Only KEY_A belongs to an app (APP_A). ORG_KEY / anything else belongs to no app.
mock.module("../../../db/repositories/apps", () => ({
  appsRepository: {
    findByApiKeyId: mock(async (apiKeyId: string) =>
      apiKeyId === KEY_A ? { id: APP_A, api_key_id: KEY_A } : undefined,
    ),
  },
}));

const { appsService } = await import("../apps");

describe("appsService.isApiKeyScopedToOtherApp (#10852)", () => {
  test("session auth (no apiKeyId) is never treated as cross-app", async () => {
    expect(await appsService.isApiKeyScopedToOtherApp(undefined, APP_B)).toBe(false);
    expect(await appsService.isApiKeyScopedToOtherApp(null, APP_B)).toBe(false);
    expect(await appsService.isApiKeyScopedToOtherApp("", APP_B)).toBe(false);
  });

  test("an app's key acting on a DIFFERENT app is rejected (the exploit)", async () => {
    expect(await appsService.isApiKeyScopedToOtherApp(KEY_A, APP_B)).toBe(true);
  });

  test("an app's key acting on its OWN app is allowed", async () => {
    expect(await appsService.isApiKeyScopedToOtherApp(KEY_A, APP_A)).toBe(false);
  });

  test("an org-level key (owned by no app) is allowed on any app", async () => {
    expect(await appsService.isApiKeyScopedToOtherApp(ORG_KEY, APP_B)).toBe(false);
    expect(await appsService.isApiKeyScopedToOtherApp(ORG_KEY, APP_A)).toBe(false);
  });
});
