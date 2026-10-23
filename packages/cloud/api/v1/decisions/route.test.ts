import { beforeEach, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { HTTPException } from "hono/http-exception";

let authenticated = true;
const rateLimited: { windowMs: number; maxRequests: number; key?: string }[] =
  [];
const blockedKeys = new Set<string>();
const logged: unknown[][] = [];
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => {
    if (!authenticated) throw new HTTPException(401);
    return { id: "user-1", organization_id: "org-1" };
  },
}));
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    // Records each limiter's window and key (fail-closed is the real
    // moneyRateLimit's job); a key in blockedKeys answers 429 like Redis would.
    moneyRateLimit:
      (config: {
        windowMs: number;
        maxRequests: number;
        keyGenerator?: (c: unknown) => string;
      }) =>
      async (
        c: { json: (body: unknown, status: number) => Response },
        next: () => Promise<void>,
      ) => {
        const key = config.keyGenerator?.(c);
        rateLimited.push({
          windowMs: config.windowMs,
          maxRequests: config.maxRequests,
          ...(key ? { key } : {}),
        });
        if (key && blockedKeys.has(key)) {
          return c.json({ code: "rate_limit_exceeded" }, 429);
        }
        await next();
      },
  }),
);
const record =
  (level: string) =>
  (...args: unknown[]) =>
    logged.push([level, ...args]);
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  },
}));
const { default: app } = await import("./route");

const SECRET = "pay the electric bill with card 4111";
const modeRequest = { kind: "mode", action: SECRET, context: SECRET };

function post(body: unknown, env: Record<string, unknown>) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  authenticated = true;
  rateLimited.length = 0;
  blockedKeys.clear();
  logged.length = 0;
});

test("route is rate limited and authenticated before any Clef call", async () => {
  const runs: unknown[] = [];
  const AI = { run: async (...args: unknown[]) => runs.push(args) };
  authenticated = false;
  const response = await post(modeRequest, {
    AI,
    CLEF_DECISIONS_ENABLED: "true",
  });
  expect(response.status).toBe(401);
  expect(rateLimited).toEqual([{ windowMs: 60_000, maxRequests: 30 }]);
  expect(runs).toHaveLength(0);
});

const ORG_DAILY = {
  windowMs: 86_400_000,
  maxRequests: 2_000,
  key: "clef-decisions:org:org-1",
};

test("each Clef call counts against the organization's daily cap", async () => {
  const AI = {
    run: async () => ({
      model: "clef-flash",
      answers: { ask: { type: "noul", noul: 0.1 } },
    }),
  };
  const response = await post(modeRequest, {
    AI,
    CLEF_DECISIONS_ENABLED: "true",
  });
  expect(response.status).toBe(200);
  expect(rateLimited).toEqual([
    { windowMs: 60_000, maxRequests: 30 },
    ORG_DAILY,
  ]);
});

test("an organization over its daily cap gets 429 and no Clef call", async () => {
  const runs: unknown[] = [];
  const AI = { run: async (...args: unknown[]) => runs.push(args) };
  blockedKeys.add(ORG_DAILY.key);
  const response = await post(modeRequest, {
    AI,
    CLEF_DECISIONS_ENABLED: "true",
  });
  expect(response.status).toBe(429);
  expect(runs).toHaveLength(0);
  expect(JSON.stringify(logged)).not.toContain(SECRET);
});

test("disabled and invalid requests do not spend the daily cap", async () => {
  await post(modeRequest, { CLEF_DECISIONS_ENABLED: "false" });
  await post({ kind: "mode", action: "" }, { CLEF_DECISIONS_ENABLED: "true" });
  expect(rateLimited.some((entry) => entry.key)).toBe(false);
});

test("route answers 503 unavailable while disabled or without the AI binding", async () => {
  const AI = { run: async () => ({}) };
  for (const env of [
    { AI },
    { AI, CLEF_DECISIONS_ENABLED: "false" },
    { CLEF_DECISIONS_ENABLED: "true" },
  ]) {
    const response = await post(modeRequest, env);
    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      status: "unavailable",
      reason: "disabled",
    });
  }
});

test("route asks Clef flash through the AI binding and returns the typed answer", async () => {
  const runs: unknown[][] = [];
  const AI = {
    run: async (...args: unknown[]) => {
      runs.push(args);
      return {
        model: "clef-flash",
        answers: { ask: { type: "noul", noul: 0.97 } },
      };
    },
  };
  const response = await post(modeRequest, {
    AI,
    CLEF_DECISIONS_ENABLED: "true",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()) as unknown).toEqual({
    status: "ok",
    kind: "mode",
    model: "clef-flash",
    suggestedMode: "ask",
    askProbability: 0.97,
  });
  expect(runs).toHaveLength(1);
  expect(runs[0]?.[0]).toBe("@cf/cloudflare/clef-flash");
});

test("provider failure answers 503 and never logs request text", async () => {
  const AI = {
    run: async () => {
      throw new Error(`upstream echoed ${SECRET}`);
    },
  };
  const response = await post(modeRequest, {
    AI,
    CLEF_DECISIONS_ENABLED: "true",
  });
  expect(response.status).toBe(503);
  expect((await response.json()) as unknown).toEqual({
    status: "unavailable",
    reason: "provider_error",
  });
  expect(logged).toEqual([
    ["warn", "[Decisions] Clef unavailable", { code: "CLEF_PROVIDER_FAILED" }],
  ]);
  expect(JSON.stringify(logged)).not.toContain(SECRET);
});

test("invalid requests are refused without echoing their text", async () => {
  const response = await post(
    { kind: "mode", action: "" },
    {
      CLEF_DECISIONS_ENABLED: "true",
    },
  );
  expect(response.status).toBe(400);
  expect((await response.json()) as unknown).toEqual({
    error: "Invalid decision request",
    field: "action",
  });
  expect(logged).toHaveLength(0);
});

test("staging and production enable decisions on the Workers AI binding", async () => {
  const config = Bun.TOML.parse(
    await readFile(new URL("../../wrangler.toml", import.meta.url), "utf8"),
  ) as {
    env: Record<
      string,
      { ai?: { binding?: string }; vars?: Record<string, string> }
    >;
  };
  for (const environment of ["staging", "production"]) {
    expect(config.env[environment]?.ai?.binding).toBe("AI");
    expect(config.env[environment]?.vars?.CLEF_DECISIONS_ENABLED).toBe("true");
    // The limits fail closed, so the route needs the shared Redis limiter.
    expect(config.env[environment]?.vars?.REDIS_RATE_LIMITING).toBe("true");
  }
});
