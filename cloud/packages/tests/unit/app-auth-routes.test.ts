import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Hono } from "hono";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_APP_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

type CodeRecord = { appId: string; userId: string };

interface Harness {
  allowedOrigins: string[];
  codes: Map<string, CodeRecord>;
  connectedUsers: Array<{ appId: string; userId: string }>;
  nextCode: string;
}

function makeHarness(): Harness {
  return {
    allowedOrigins: ["http://localhost:2138"],
    codes: new Map(),
    connectedUsers: [],
    nextCode: "eac_route_code_1",
  };
}

function installMocks(harness: Harness): void {
  mock.module("drizzle-orm", () => ({
    eq: () => ({}),
  }));

  mock.module("@/db/schemas/apps", () => ({
    apps: {
      id: "id",
      name: "name",
    },
  }));

  mock.module("@/db/client", () => ({
    dbRead: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: APP_ID, name: "Test App" }],
          }),
        }),
      }),
    },
  }));

  mock.module("@/db/repositories/apps", () => ({
    appsRepository: {
      connectUser: async (input: { appId: string; userId: string }) => {
        harness.connectedUsers.push(input);
        return "created";
      },
      findPublicInfoById: async (id: string) =>
        id === APP_ID
          ? {
              allowed_origins: harness.allowedOrigins,
              app_url: "http://localhost:2138/app",
              description: "Test app",
              id: APP_ID,
              is_active: true,
              is_approved: true,
              logo_url: null,
              name: "Test App",
              website_url: null,
            }
          : undefined,
    },
  }));

  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKey: async () => ({
      email: "user@example.com",
      id: USER_ID,
    }),
  }));

  mock.module("@/lib/services/apps", () => ({
    appsService: {
      getAllowedOrigins: async () => harness.allowedOrigins,
    },
  }));

  mock.module("@/lib/services/app-auth-codes", () => ({
    consumeAppAuthCode: async (code: string) => {
      const record = harness.codes.get(code) ?? null;
      harness.codes.delete(code);
      return record;
    },
    issueAppAuthCode: async (input: CodeRecord) => {
      harness.codes.set(harness.nextCode, input);
      return {
        code: harness.nextCode,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        expiresIn: 300,
      };
    },
    looksLikeAppAuthCode: (value: string | null | undefined) =>
      typeof value === "string" && value.startsWith("eac_"),
  }));

  mock.module("@/lib/services/users", () => ({
    usersService: {
      getById: async (id: string) => ({
        avatar: "https://example.com/avatar.png",
        created_at: "2026-01-01T00:00:00.000Z",
        email: `${id}@example.com`,
        id,
        name: "Test User",
      }),
    },
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: {
      debug() {},
      error() {},
      info() {},
      warn() {},
    },
  }));
}

interface RouteApp {
  fetch: (req: Request) => Response | Promise<Response>;
}

async function loadRoutes(): Promise<RouteApp> {
  const { Hono } = await import("hono");
  const [connect, session] = await Promise.all([
    import(
      new URL(
        `../../../apps/api/v1/app-auth/connect/route.ts?test=${Date.now()}-${Math.random()}`,
        import.meta.url,
      ).href
    ),
    import(
      new URL(
        `../../../apps/api/v1/app-auth/session/route.ts?test=${Date.now()}-${Math.random()}`,
        import.meta.url,
      ).href
    ),
  ]);
  const parent = new Hono();
  parent.route("/api/v1/app-auth/connect", connect.default as Hono);
  parent.route("/api/v1/app-auth/session", session.default as Hono);
  return parent;
}

describe("app auth routes", () => {
  let harness: Harness;

  beforeEach(() => {
    mock.restore();
    harness = makeHarness();
    installMocks(harness);
  });

  afterEach(() => {
    mock.restore();
  });

  test("connect rejects redirect URIs outside the app allowlist", async () => {
    const routes = await loadRoutes();
    const response = await routes.fetch(
      new Request("https://api.test/api/v1/app-auth/connect", {
        body: JSON.stringify({
          appId: APP_ID,
          redirectUri: "https://evil.example/callback",
        }),
        headers: {
          authorization: "Bearer steward",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    const body = (await response.json()) as { code?: string; error?: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_error");
    expect(body.error).toContain("redirect_uri");
    expect(harness.connectedUsers).toHaveLength(0);
  });

  test("connect issues an app-auth code, not a session token", async () => {
    const routes = await loadRoutes();
    const response = await routes.fetch(
      new Request("https://api.test/api/v1/app-auth/connect", {
        body: JSON.stringify({
          appId: APP_ID,
          redirectUri: "http://localhost:2138/callback?state=old",
        }),
        headers: {
          authorization: "Bearer steward",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    const body = (await response.json()) as {
      code?: string;
      codeType?: string;
      token?: string;
    };

    expect(response.status).toBe(200);
    expect(body.code).toBe("eac_route_code_1");
    expect(body.codeType).toBe("app_auth_code");
    expect(body.token).toBeUndefined();
    expect(harness.codes.get("eac_route_code_1")).toEqual({
      appId: APP_ID,
      userId: USER_ID,
    });
  });

  test("session consumes app-auth codes once and rejects replay", async () => {
    const routes = await loadRoutes();
    harness.codes.set("eac_once", { appId: APP_ID, userId: USER_ID });

    const first = await routes.fetch(
      new Request("https://api.test/api/v1/app-auth/session", {
        headers: {
          authorization: "Bearer eac_once",
          "x-app-id": APP_ID,
        },
      }),
    );
    const firstBody = (await first.json()) as {
      app?: { id: string };
      success?: boolean;
      user?: { id: string };
    };

    expect(first.status).toBe(200);
    expect(firstBody.success).toBe(true);
    expect(firstBody.user?.id).toBe(USER_ID);
    expect(firstBody.app?.id).toBe(APP_ID);

    const replay = await routes.fetch(
      new Request("https://api.test/api/v1/app-auth/session", {
        headers: { authorization: "Bearer eac_once" },
      }),
    );
    const replayBody = (await replay.json()) as { code?: string };
    expect(replay.status).toBe(401);
    expect(replayBody.code).toBe("authentication_required");
  });

  test("session rejects app-auth codes for the wrong requested app", async () => {
    const routes = await loadRoutes();
    harness.codes.set("eac_wrong_app", { appId: APP_ID, userId: USER_ID });

    const response = await routes.fetch(
      new Request("https://api.test/api/v1/app-auth/session", {
        headers: {
          authorization: "Bearer eac_wrong_app",
          "x-app-id": OTHER_APP_ID,
        },
      }),
    );
    const body = (await response.json()) as { code?: string; error?: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe("access_denied");
    expect(body.error).toContain("different app");
  });
});
