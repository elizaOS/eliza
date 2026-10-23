import { beforeEach, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { HTTPException } from "hono/http-exception";

let authenticated = true;
const rateLimited: unknown[] = [];
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
    RateLimitPresets: { STANDARD: { windowMs: 60_000, maxRequests: 60 } },
    rateLimit:
      (preset: unknown) => async (_c: unknown, next: () => Promise<void>) => {
        rateLimited.push(preset);
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
  expect(rateLimited).toEqual([{ windowMs: 60_000, maxRequests: 60 }]);
  expect(runs).toHaveLength(0);
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
    expect(await response.json()).toEqual({
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
  expect(await response.json()).toEqual({
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
  expect(await response.json()).toEqual({
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
  expect(await response.json()).toEqual({
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
  }
});
