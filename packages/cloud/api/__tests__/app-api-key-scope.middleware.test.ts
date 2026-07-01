import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { ApiKey } from "@/db/repositories";
import type { App } from "@/db/repositories/apps";
import type { AppEnv } from "@/types/cloud-worker-env";

const APP_A = "11111111-1111-4111-8111-111111111111";
const APP_B = "22222222-2222-4222-8222-222222222222";
const ORG_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_A = "bbbbbbbb-1111-4111-8111-111111111111";
const KEY_ID = "cccccccc-1111-4111-8111-111111111111";
const KEY_TOKEN = "eliza_test_app_key";

const validateApiKey = mock<(key: string) => Promise<ApiKey | null>>();
const getByApiKeyId = mock<(apiKeyId: string) => Promise<App | undefined>>();

mock.module("@/lib/services/api-keys", () => ({
  apiKeysService: {
    validateApiKey,
  },
}));

mock.module("@/lib/services/apps", () => ({
  appsService: {
    getByApiKeyId,
  },
}));

const { appApiKeyScopeMiddleware, appIdFromAppsRoute } = await import(
  "../src/middleware/app-api-key-scope"
);

beforeEach(() => {
  validateApiKey.mockReset();
  getByApiKeyId.mockReset();
});

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: KEY_ID,
    user_id: USER_A,
    organization_id: ORG_A,
    key_hash: "hash",
    key_prefix: "eliza_",
    name: "App key",
    is_active: true,
    last_used_at: null,
    expires_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as ApiKey;
}

function appRow(overrides: Partial<App> = {}): App {
  return {
    id: APP_A,
    organization_id: ORG_A,
    api_key_id: KEY_ID,
    name: "Scoped App",
    ...overrides,
  } as App;
}

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });
  app.use("*", appApiKeyScopeMiddleware);
  app.all("*", (c) => c.json({ success: true }));
  return app;
}

describe("app API key scope middleware", () => {
  test("extracts only UUID app detail routes", () => {
    expect(appIdFromAppsRoute(`/api/v1/apps/${APP_A}`)).toBe(APP_A);
    expect(appIdFromAppsRoute(`/api/v1/apps/${APP_A}/deploy`)).toBe(APP_A);
    expect(appIdFromAppsRoute("/api/v1/apps/check-name")).toBeNull();
    expect(appIdFromAppsRoute("/api/v1/apps/not-a-uuid/deploy")).toBeNull();
  });

  test("lets no-key requests pass through without service lookups", async () => {
    const res = await buildApp().request(`/api/v1/apps/${APP_A}/deploy`);

    expect(res.status).toBe(200);
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(getByApiKeyId).not.toHaveBeenCalled();
  });

  test("leaves invalid API keys to the route auth layer", async () => {
    validateApiKey.mockResolvedValue(null);

    const res = await buildApp().request(`/api/v1/apps/${APP_A}/deploy`, {
      headers: { "X-API-Key": KEY_TOKEN },
    });

    expect(res.status).toBe(200);
    expect(validateApiKey).toHaveBeenCalledWith(KEY_TOKEN);
    expect(getByApiKeyId).not.toHaveBeenCalled();
  });

  test("allows unbound organization API keys", async () => {
    validateApiKey.mockResolvedValue(apiKey());
    getByApiKeyId.mockResolvedValue(undefined);

    const res = await buildApp().request(`/api/v1/apps/${APP_A}/deploy`, {
      headers: { Authorization: `Bearer ${KEY_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(getByApiKeyId).toHaveBeenCalledWith(KEY_ID);
  });

  test("allows the app's own API key", async () => {
    validateApiKey.mockResolvedValue(apiKey());
    getByApiKeyId.mockResolvedValue(appRow({ id: APP_A }));

    const res = await buildApp().request(`/api/v1/apps/${APP_A}/deploy`, {
      headers: { "X-API-Key": KEY_TOKEN },
    });

    expect(res.status).toBe(200);
  });

  test("rejects an app API key bound to a sibling app", async () => {
    validateApiKey.mockResolvedValue(apiKey());
    getByApiKeyId.mockResolvedValue(appRow({ id: APP_A }));

    const res = await buildApp().request(`/api/v1/apps/${APP_B}/deploy`, {
      headers: { "X-API-Key": KEY_TOKEN },
    });
    const json = (await res.json()) as { success: boolean; error: string };

    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.error).toBe("Invalid API key for this app");
  });
});
