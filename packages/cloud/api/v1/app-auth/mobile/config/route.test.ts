/** Ensures mobile client metadata exposes consent branding but never its server-owned app UUID. */
import { describe, expect, mock, test } from "bun:test";

const INTERNAL_APP_ID = "11111111-1111-4111-8111-111111111111";
const registration = {
  appId: INTERNAL_APP_ID,
  clientId: "ai.elizaos.app" as const,
  environment: "staging" as const,
  redirectUri: "https://eliza.app/auth/callback" as const,
  scopes: ["cloud:user"] as const,
};

mock.module("../_registration", () => ({
  requireRegisteredMobileApp: mock(async () => ({
    registration,
    app: {
      id: INTERNAL_APP_ID,
      name: "Eliza mobile",
      description: "First-party native app",
      logo_url: "https://eliza.app/logo.png",
      website_url: "https://eliza.app",
    },
  })),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  getIpKey: mock(() => "ip:test"),
  RateLimitPresets: {
    STANDARD: { maxRequests: 60, windowMs: 60_000 },
    STRICT: { maxRequests: 10, windowMs: 60_000 },
  },
  rateLimit:
    () =>
    async (_context: unknown, next: () => Promise<void>): Promise<void> =>
      await next(),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

function query(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    clientId: registration.clientId,
    environment: registration.environment,
    redirectUri: registration.redirectUri,
    ...overrides,
  }).toString();
}

describe("GET /api/v1/app-auth/mobile/config", () => {
  test("returns the fixed public contract without the internal registration ID", async () => {
    const response = await app.request(`/?${query()}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: true,
      clientId: "ai.elizaos.app",
      environment: "staging",
      redirectUri: "https://eliza.app/auth/callback",
      codeChallengeMethod: "S256",
      scopes: ["cloud:user"],
      app: { name: "Eliza mobile" },
    });
    expect(JSON.stringify(body)).not.toContain(INTERNAL_APP_ID);
  });

  test("rejects a different native client before returning metadata", async () => {
    const response = await app.request(
      `/?${query({ clientId: "attacker.client" })}`,
    );
    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      success: false,
      error: "invalid_client",
      retryable: false,
    });
  });
});
