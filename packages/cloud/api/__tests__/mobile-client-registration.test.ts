/** Exercise the actual metadata route and registration binding without external account effects. */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../shared/src/types/cloud-worker-env";

mock.module("../../shared/src/db/crypto/api-keys", () => ({
  decryptApiKey: mock(),
  encryptApiKey: mock(),
}));
mock.module("../../shared/src/db/repositories/mobile-app-auth-grants", () => ({
  mobileAppAuthGrantsRepository: {},
}));
mock.module("../../shared/src/lib/services/api-keys", () => ({
  apiKeysService: {},
  isMobileApiKeySecret: () => false,
}));
const rows = new Map<string, Record<string, unknown>>();
mock.module("../../shared/src/db/repositories/apps", () => ({
  appsRepository: { findPublicInfoById: async (id: string) => rows.get(id) },
}));
mock.module("../../shared/src/lib/services/apps", () => ({
  appsService: {
    getAllowedOrigins: async (app: { allowed_origins: string[] }) =>
      app.allowed_origins,
  },
}));
mock.module("../v1/app-auth/mobile/_rate-limit", () => ({
  MOBILE_APP_AUTH_CONFIG_RATE_LIMIT: {},
  mobileAppAuthRateLimitMiddleware:
    () => async (_c: unknown, next: () => Promise<void>) =>
      next(),
}));
const { default: route } = await import("../v1/app-auth/mobile/config/route");
const { resolveMobileAppAuthRegistration, validateMobileAppAuthClientBinding } =
  await import("../../shared/src/lib/services/mobile-app-auth");
const legacy = {
  clientId: "ai.elizaos.app",
  appId: "11111111-1111-4111-8111-111111111111",
  redirectUri: "https://eliza.app/auth/callback",
};
const independent = {
  clientId: "ai.elizaresearch.seniorcare",
  appId: "22222222-2222-4222-8222-222222222222",
  redirectUri: "https://cloud.eliza.app/auth/senior-care/callback",
  enabled: true,
};
const env = {
  ENVIRONMENT: "production",
  ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
  ELIZA_MOBILE_APP_AUTH_APP_ID: legacy.appId,
  ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: JSON.stringify([independent]),
};
const app = new Hono<AppEnv>().route("/", route);
for (const client of [legacy, independent])
  rows.set(client.appId, {
    name: client.clientId,
    description: null,
    logo_url: null,
    website_url: null,
    allowed_origins: [client.redirectUri],
  });
afterAll(() => mock.restore());
describe("independent native registration", () => {
  test("actual metadata route selects independent registration and hides internal app IDs", async () => {
    for (const client of [legacy, independent]) {
      const response = await app.request(
        "/?" +
          new URLSearchParams({
            clientId: client.clientId,
            redirectUri: client.redirectUri,
            environment: "production",
          }),
        {},
        env as AppEnv["Bindings"],
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        clientId: client.clientId,
        app: { name: client.clientId },
      });
      expect(JSON.stringify(body)).not.toContain(client.appId);
    }
  });
  test("rejects cross-client redirect or environment substitutions", () => {
    const registration = resolveMobileAppAuthRegistration(
      env,
      independent.clientId,
    );
    expect(registration.appId).toBe(independent.appId);
    for (const input of [
      { ...registration, redirectUri: legacy.redirectUri },
      { ...registration, clientId: legacy.clientId },
      { ...registration, environment: "staging" },
    ])
      expect(() =>
        validateMobileAppAuthClientBinding(registration, input),
      ).toThrow();
  });
  test("unknown clients and disabled registry entries cannot select the legacy app", () => {
    expect(() =>
      resolveMobileAppAuthRegistration(env, "ai.unknown.app"),
    ).toThrow();
    expect(() =>
      resolveMobileAppAuthRegistration(
        {
          ...env,
          ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: JSON.stringify([
            { ...independent, enabled: false },
          ]),
        },
        independent.clientId,
      ),
    ).toThrow();
    expect(
      resolveMobileAppAuthRegistration({
        ...env,
        ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: "malformed",
      }).appId,
    ).toBe(legacy.appId);
  });
  test("configured app must actually allow its registered redirect", async () => {
    rows.set(independent.appId, {
      name: "Senior",
      allowed_origins: [legacy.redirectUri],
    });
    const response = await app.request(
      "/?" +
        new URLSearchParams({
          clientId: independent.clientId,
          redirectUri: independent.redirectUri,
          environment: "production",
        }),
      {},
      env as AppEnv["Bindings"],
    );
    expect(response.status).toBe(503);
  });
});
