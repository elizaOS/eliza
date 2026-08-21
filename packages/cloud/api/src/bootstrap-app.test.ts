/**
 * Application-shell contracts for middleware that must wrap every generated
 * route. These tests use the real generated router so they leave no
 * process-global Bun module mock behind for sibling files.
 */

import { expect, test } from "bun:test";
import type { Bindings } from "@/types/cloud-worker-env";

const {
  createApp,
  isRedisIndependentInferencePath,
  resetProcessGlobalWiringForTests,
} = await import("./bootstrap-app");
const { getAuditDispatcher, setAuditDispatcher } = await import(
  "./services/audit-dispatcher-singleton"
);

function environment(limiter: {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}): Bindings {
  return {
    ENVIRONMENT: "staging",
    NODE_ENV: "production",
    REDIS_RATE_LIMITING: "false",
    GOOGLE_CLIENT_ID: "configured",
    GOOGLE_CLIENT_SECRET: "configured",
    GLOBAL_RATE_LIMITER: limiter,
  } as unknown as Bindings;
}

test("missing required OAuth credentials are logged once per app isolate", async () => {
  const app = await createApp({ requestPath: "/api/i18n/locale" });
  const calls: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => calls.push(args);

  try {
    const env = {
      ...environment({
        async limit() {
          return { success: true };
        },
      }),
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    } as never;
    for (let index = 0; index < 2; index += 1) {
      const response = await app.fetch(
        new Request("https://api.example.test/api/i18n/locale"),
        env,
      );
      expect(response.status).toBe(200);
    }
  } finally {
    console.error = originalConsoleError;
  }

  const diagnostics = calls.filter(
    (args) =>
      args[0] === "[bootstrap-app] Required OAuth provider is not configured",
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.[1]).toMatchObject({
    providerId: "google",
    missingEnvVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  });
});

test("the global native limiter rejects before auth and generated routes", async () => {
  const keys: string[] = [];
  const app = await createApp({ requestPath: "/private/generated-route" });
  const response = await app.fetch(
    new Request("https://api.example.test/private/generated-route", {
      headers: { "cf-connecting-ip": "203.0.113.8" },
    }),
    environment({
      async limit({ key }) {
        keys.push(key);
        return { success: false };
      },
    }),
  );

  expect(keys).toEqual(["global:ip:203.0.113.8"]);
  expect(response.status).toBe(429);
  expect(response.headers.get("X-RateLimit-Policy")).toBe("cloudflare-native");
  expect(await response.json()).toMatchObject({
    code: "rate_limit_exceeded",
    retryAfter: 60,
  });
});

test("an allowed native decision preserves public locale routing", async () => {
  const keys: string[] = [];
  const app = await createApp({ requestPath: "/api/i18n/locale" });
  const response = await app.fetch(
    new Request("https://api.example.test/api/i18n/locale", {
      headers: {
        "accept-language": "fr;q=0.8, ja;q=0.9",
        "cf-connecting-ip": "203.0.113.9",
      },
    }),
    environment({
      async limit({ key }) {
        keys.push(key);
        return { success: true };
      },
    }),
  );

  expect(keys).toEqual(["global:ip:203.0.113.9"]);
  expect(response.status).toBe(200);
  expect(response.headers.get("X-RateLimit-Policy")).toBe("cloudflare-native");
  const body = (await response.json()) as { language: string | null };
  expect(body).toEqual({ language: "ja" });
});

test("only model-dispatch surfaces bypass the legacy Railway Redis guard", () => {
  for (const path of [
    "/api/v1/chat",
    "/api/v1/chat/completions",
    "/api/v1/messages",
    "/api/v1/embeddings",
    "/api/v1/responses",
    "/api/v1/eliza/agents/agent-a/bridge",
    "/api/v1/eliza/agents/agent-a/stream",
    "/api/v1/eliza/agents/agent-a/api/conversations/room-a/messages",
    "/api/v1/eliza/agents/agent-a/api/conversations/room-a/messages/stream",
  ]) {
    expect(isRedisIndependentInferencePath(path)).toBe(true);
  }
  for (const path of [
    "/api/v1/chatty",
    "/api/v1/eliza/agents/agent-a/provision",
    "/api/v1/eliza/agents/agent-a/api/conversations/room-a",
    "/api/i18n/locale",
  ]) {
    expect(isRedisIndependentInferencePath(path)).toBe(false);
  }
});

test("production inference remains reachable when Railway Redis is unavailable", async () => {
  const app = await createApp({ requestPath: "/api/v1/embeddings" });
  const response = await app.fetch(
    new Request("https://api.example.test/api/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify({ model: "embedding-model", input: "hi" }),
    }),
    {
      ENVIRONMENT: "production",
      NODE_ENV: "production",
      REDIS_RATE_LIMITING: "true",
      GOOGLE_CLIENT_ID: "configured",
      GOOGLE_CLIENT_SECRET: "configured",
      GLOBAL_RATE_LIMITER: {
        async limit() {
          return { success: true };
        },
      },
      CHAT_ROUTE_RATE_LIMITER: {
        async limit() {
          return { success: true };
        },
      },
    } as never,
  );

  expect(response.status).toBe(401);
  expect(await response.json()).not.toMatchObject({
    code: "RATE_LIMIT_UNAVAILABLE",
  });
});

test("a shard-scoped app mounts only the request path's route family", async () => {
  const [authApp, fullApp] = await Promise.all([
    createApp({
      requestPath: "/api/auth/cli-session/00000000-0000-4000-8000-000000000000",
    }),
    createApp(),
  ]);

  const mountedPaths = (app: { routes: ReadonlyArray<{ path: string }> }) =>
    new Set(app.routes.map((route) => route.path));

  const authPaths = mountedPaths(authApp);
  const fullPaths = mountedPaths(fullApp);
  const hasPrefix = (paths: Set<string>, prefix: string) =>
    [...paths].some((path) => path.startsWith(prefix));

  expect(hasPrefix(authPaths, "/api/auth/cli-session/:sessionId")).toBe(true);
  expect(hasPrefix(fullPaths, "/api/auth/cli-session/:sessionId")).toBe(true);
  expect(hasPrefix(fullPaths, "/api/credits/balance")).toBe(true);
  expect(hasPrefix(authPaths, "/api/credits/balance")).toBe(false);

  // Manually registered special-case routes stay present in every shard app.
  expect(hasPrefix(authPaths, "/api/i18n/locale")).toBe(true);
  expect(hasPrefix(authPaths, "/.well-known/openid-configuration")).toBe(true);
});

test("process-global wiring is installed once per isolate, not once per shard", async () => {
  // Building the first app of an isolate installs the audit dispatcher.
  resetProcessGlobalWiringForTests();
  await createApp({ requestPath: "/api/auth/logout" });
  const installed = getAuditDispatcher();
  expect(installed).toBeDefined();

  // A later shard must not clobber the dispatcher that in-flight requests
  // (or a test substitution) already hold.
  const substitute = {
    dispatch: async () => undefined,
  } as unknown as ReturnType<typeof getAuditDispatcher>;
  setAuditDispatcher(substitute);
  try {
    await createApp({ requestPath: "/api/credits/balance" });
    expect(getAuditDispatcher()).toBe(substitute);
  } finally {
    // Leave no process-global substitution behind for sibling tests.
    setAuditDispatcher(installed);
  }
});
