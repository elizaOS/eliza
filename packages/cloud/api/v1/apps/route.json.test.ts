/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const APP_ID = "00000000-0000-4000-8000-0000000000aa";
const created = {
  id: APP_ID,
  name: "demo",
  organization_id: "org-1",
};

const createApp = mock(async () => ({
  app: created,
  apiKey: { id: "key-1", key: "eliza_test" },
  githubRepo: null,
  githubRepoCreated: false,
  errors: [],
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/app-credits", () => ({
  appCreditsService: {
    updateMonetizationSettings: async () => undefined,
  },
}));

mock.module("@/lib/services/app-factory", () => ({
  appFactoryService: { createApp },
}));

mock.module("@/lib/services/apps", () => ({
  AppCreationLimitError: class AppCreationLimitError extends Error {},
  AppNameConflictError: class AppNameConflictError extends Error {},
  appsService: {
    getById: async () => created,
    withDatabaseState: async (row: unknown) => row,
    listByOrganizationWithDatabaseState: async () => [],
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/apps malformed JSON", () => {
  test("returns 400 instead of 500 and never creates an app", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(createApp).not.toHaveBeenCalled();
  });

  test("canonical JSON still creates an app", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "demo",
        app_url: "https://app.example.test",
      }),
    });
    expect(response.status).toBe(200);
    expect(createApp).toHaveBeenCalled();
  });
});
