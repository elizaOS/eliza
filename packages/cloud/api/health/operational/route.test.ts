/**
 * Exercises /api/health/operational route behavior against mocked OAuth
 * diagnostics. bun-test does not resolve `@/lib/*` path aliases, so all
 * dependencies are mocked; the `getProviderEnvDiagnostics` return value
 * is controlled to verify the route serializes it correctly.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const isStewardPlatformConfigured = mock(() => true);

const defaultDiagnostics = [
  {
    id: "google",
    name: "Google",
    type: "oauth2",
    configured: true,
    missingEnvVars: [],
    requiredForDeployment: true,
  },
  {
    id: "microsoft",
    name: "Microsoft",
    type: "oauth2",
    configured: false,
    missingEnvVars: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    requiredForDeployment: false,
  },
];

let mockDiagnostics = defaultDiagnostics.map((entry) => ({ ...entry }));
const getProviderEnvDiagnostics = mock(() => mockDiagnostics);

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: unknown, error: unknown) => {
    const ctx = c as { json: (body: unknown, status?: number) => Response };
    return ctx.json({ error: String(error) }, 500);
  },
}));

mock.module("@/lib/runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({
    EVM_PAYOUT_PRIVATE_KEY: "configured",
    CRON_SECRET: "configured",
  }),
}));

mock.module("@/lib/services/steward-platform-users", () => ({
  isStewardPlatformConfigured,
}));

mock.module("@/lib/services/oauth/provider-registry", () => ({
  getProviderEnvDiagnostics,
}));

const { default: operationalHealth } = await import("./route");

function buildApp() {
  const app = new Hono();
  app.route("/", operationalHealth);
  return app;
}

describe("GET /api/health/operational — OAuth providers", () => {
  beforeEach(() => {
    mockDiagnostics = defaultDiagnostics.map((entry) => ({ ...entry }));
  });

  test("response includes oauth_providers array with per-provider status", async () => {
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");

    const providers = body.oauth_providers as Array<Record<string, unknown>>;
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBe(2);

    const google = providers[0] as Record<string, unknown>;
    expect(google.id).toBe("google");
    expect(google.configured).toBe(true);
    expect(google.missingEnvVars).toEqual([]);

    const ms = providers[1] as Record<string, unknown>;
    expect(ms.id).toBe("microsoft");
    expect(ms.configured).toBe(false);
    expect(ms.missingEnvVars).toEqual([
      "MICROSOFT_CLIENT_ID",
      "MICROSOFT_CLIENT_SECRET",
    ]);
  });

  test("checks.oauth_providers summary is present and matches the array", async () => {
    const res = await buildApp().request("/");
    const body = (await res.json()) as Record<string, unknown>;

    const checks = body.checks as Record<string, unknown>;
    expect(checks.oauth_providers).toBeDefined();
    const summary = checks.oauth_providers as {
      configured: boolean;
      message: string;
    };
    expect(summary.configured).toBe(true);
    expect(summary.message).toContain(
      "All 1 deployment-required OAuth providers configured",
    );
  });

  test("a missing deployment-required provider degrades health", async () => {
    mockDiagnostics = defaultDiagnostics.map((entry) =>
      entry.id === "google"
        ? {
            ...entry,
            configured: false,
            missingEnvVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
          }
        : { ...entry },
    );

    const res = await buildApp().request("/");
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, { configured: boolean; message: string }>;
    };

    expect(body.status).toBe("degraded");
    expect(body.checks.oauth_providers).toEqual({
      configured: false,
      message: "Missing deployment-required OAuth providers: google",
    });
  });

  test("response is never cached", async () => {
    const res = await buildApp().request("/");
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
  });
});
