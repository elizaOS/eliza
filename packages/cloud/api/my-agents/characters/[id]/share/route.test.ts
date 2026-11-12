/** Product configuration rejection must precede character visibility changes. */
import { beforeEach, expect, mock, test } from "bun:test";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const authPath = "@elizaos/cloud-shared/auth";
const auth = { ...(await import(authPath)) };
const user = { id: "user-1", organization_id: "org-1", is_active: true };
mock.module(authPath, () => ({
  ...auth,
  requireUserOrApiKeyWithOrg: async () => user,
}));
let isPublic = false;
let updates = 0;
let cacheInvalidations = 0;
mock.module("@elizaos/cloud-shared/lib/services/characters", () => ({
  charactersService: {
    getByIdForUser: async () => ({
      id: "character-1",
      organization_id: user.organization_id,
      name: "Example",
      is_public: isPublic,
    }),
    update: async (_id: string, change: { is_public: boolean }) => {
      updates++;
      isPublic = change.is_public;
      return {
        id: "character-1",
        organization_id: user.organization_id,
        name: "Example",
        is_public: isPublic,
      };
    },
  },
}));
mock.module("@elizaos/cloud-shared/lib/cache/client", () => ({
  cache: {
    del: async () => {
      cacheInvalidations++;
    },
    delPattern: async () => {
      cacheInvalidations++;
    },
  },
}));
const { Hono } = await import("hono");
const { runWithCloudBindingsAsync } = await import(
  "@elizaos/cloud-shared/lib/runtime/cloud-bindings"
);
const { corsMiddleware } = await import(
  "@elizaos/cloud-shared/lib/cors/cloud-api-hono-cors"
);
const { default: route } = await import("./route");
const app = new Hono<AppEnv>();
app.use("*", (c, next) => runWithCloudBindingsAsync(c.env, next));
app.use("*", corsMiddleware);
app.route("/api/my-agents/characters/:id/share", route);

beforeEach(() => {
  updates = 0;
  cacheInvalidations = 0;
});
const request = (nextIsPublic: boolean, appOrigin = "") =>
  app.request(
    "/api/my-agents/characters/character-1/share",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isPublic: nextIsPublic }),
    },
    {
      CLOUD_DEPLOYMENT_ID: "probe-product",
      CLOUD_WEB_ORIGIN: "https://example.test",
      NEXT_PUBLIC_APP_URL: appOrigin,
    },
  );

for (const nextIsPublic of [true, false]) {
  test(`missing product app origin ${nextIsPublic ? "refuses publishing before effects" : "still permits a private visibility receipt"}`, async () => {
    isPublic = !nextIsPublic;
    const response = await request(nextIsPublic);
    const body = await response.json();
    if (nextIsPublic) {
      expect(response.status).toBe(500);
      expect(body).toMatchObject({ success: false, error: expect.any(String) });
      expect(updates).toBe(0);
      expect(cacheInvalidations).toBe(0);
      expect(isPublic).toBe(false);
    } else {
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        data: { isPublic: false, shareUrl: null, shareInfo: null },
      });
      expect(updates).toBe(1);
      expect(cacheInvalidations).toBe(2);
      expect(isPublic).toBe(false);
    }
  });
  test(`configured product returns the visibility ${nextIsPublic} receipt`, async () => {
    isPublic = !nextIsPublic;
    const response = await request(nextIsPublic, "https://cloud.example.test");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        isPublic: nextIsPublic,
        shareUrl: nextIsPublic
          ? "https://cloud.example.test/chat/character-1"
          : null,
      },
    });
    expect(updates).toBe(1);
    expect(cacheInvalidations).toBe(2);
    expect(isPublic).toBe(nextIsPublic);
  });
}
