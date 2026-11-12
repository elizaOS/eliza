/** A rejected product deployment cannot consume an OAuth code before redirect validation. */
import { beforeEach, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
let providerCalls = 0;
mock.module("@elizaos/cloud-shared/lib/cache/client", () => ({
  cache: { get: async () => null, del: async () => {} },
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/oauth/provider-registry",
  () => ({
    getProvider: () => ({ id: "github", useGenericRoutes: true }),
    isProviderConfigured: () => true,
    getAllProviderIds: () => ["github"],
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/oauth/providers", () => ({
  handleOAuth2Callback: async () => {
    providerCalls++;
    return {
      connectionId: "connection-1",
      organizationId: "org-1",
      userId: "user-1",
      platformUserId: "provider-user-1",
      redirectUrl: "/cloud/connectors",
    };
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/eliza-app", () => ({
  connectionEnforcementService: {
    invalidateRequiredConnectionCache: async () => {},
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/oauth/invalidation", () => ({
  invalidateOAuthState: async () => {},
}));
const { runWithCloudBindingsAsync } = await import(
  "@elizaos/cloud-shared/lib/runtime/cloud-bindings"
);
const { handleGenericOAuthCallback } = await import("./generic-callback");
const request = (host: string) =>
  runWithCloudBindingsAsync(
    {
      CLOUD_DEPLOYMENT_ID: "probe-product",
      CLOUD_WEB_ORIGIN: "https://example.test",
      NEXT_PUBLIC_APP_URL: "https://cloud.example.test",
      NEXT_PUBLIC_API_URL: "https://api.example.test",
      STEWARD_TENANT_ID: "probe-product",
      CLOUD_PUBLIC_SERVICE_NAME: "Probe Product",
      R2_PUBLIC_HOST: host,
      NEXT_PUBLIC_ASSETS_CDN_URL: "https://assets.example.test",
      SENDGRID_FROM_EMAIL: "noreply@example.test",
      CLOUD_BILLING_URL: "https://cloud.example.test/cloud/billing",
    },
    () =>
      handleGenericOAuthCallback(
        new Request(
          "https://api.example.test/api/v1/oauth/github/callback?code=synthetic-code&state=11111111-1111-4111-8111-111111111111",
        ),
        { params: Promise.resolve({ platform: "github" }) },
      ),
  );
beforeEach(() => {
  providerCalls = 0;
});
for (const host of ["", "blob.example.test:65536"]) {
  test(`invalid product host ${host || "missing"} redirects to failure before OAuth code exchange`, async () => {
    const response = await request(host);
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.origin).toBe("https://cloud.example.test");
    expect(target.searchParams.has("github_error")).toBe(true);
    expect(target.searchParams.has("github_connected")).toBe(false);
    expect(providerCalls).toBe(0);
  });
}
test("valid product callback exchanges once and returns a connected receipt", async () => {
  const response = await request("blob.example.test:8443");
  expect(response.status).toBe(302);
  const target = new URL(response.headers.get("location") ?? "");
  expect(target.origin).toBe("https://cloud.example.test");
  expect(target.searchParams.get("github_connected")).toBe("true");
  expect(target.searchParams.get("connection_id")).toBe("connection-1");
  expect(target.searchParams.has("github_error")).toBe(false);
  expect(providerCalls).toBe(1);
});
