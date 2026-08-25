/**
 * W11-CLOUD-01 contract on the named endpoint: POST /api/v1/chat through the
 * REAL createInferenceApp thin-shell middleware chain into the REAL chat route
 * module — the exact pairing index.ts dispatches in production. A
 * cookie-authenticated cross-site simple POST must die at the shell's
 * cookie-mutation CSRF guard (403) before route auth or billing; programmatic
 * Bearer/API-key callers and first-party browser mutations with a non-simple
 * marker must pass the guard to the route's own auth.
 *
 * Harness: real shell + real route; only the drizzle schema edges are stubbed
 * (`@/db/schemas` pulls @elizaos/plugin-sql, which is wrangler-aliased to a
 * build stub and not importable in the unit lane). Guard rejections fire
 * pre-route; pass-through cases reach route auth, which rejects the
 * replayed/invalid credential (the api_keys lookup against the unreachable
 * test DATABASE_URL included) before any billing or provider work.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ExecutionContext as HonoExecutionContext } from "hono";

process.env.NODE_ENV ||= "test";

mock.module("@/db/schemas", () => ({ organizations: {} }));
mock.module("@/db/schemas/eliza", () => ({}));

import { stewardCookieNames } from "@/lib/auth/steward-cookies";
import type { AppEnv } from "@/types/cloud-worker-env";
import chatRoute from "../v1/chat/route";
import { createInferenceApp } from "./inference-app";

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: undefined,
} satisfies HonoExecutionContext;

const env = {
  ENVIRONMENT: "test",
  NODE_ENV: "test",
  REDIS_RATE_LIMITING: "false",
  CACHE_ENABLED: "false",
  DATABASE_URL: "postgres://test.invalid/eliza",
  BLOB: {},
} as AppEnv["Bindings"];

const SESSION_COOKIE = `${stewardCookieNames(env.ENVIRONMENT).token}=attacker-replayed`;
const CHAT_URL = "https://api.elizacloud.ai/api/v1/chat";
const FIRST_PARTY_ORIGIN = "https://cloud.eliza.app";
const HOSTED_USER_CONTENT_ORIGIN = "https://evil.sites.eliza.app";

const GUARD_REJECTION_CODES = new Set([
  "forbidden_origin",
  "csrf_marker_required",
]);

function postChat(headers: Record<string, string>) {
  return createInferenceApp("/api/v1/chat", chatRoute).fetch(
    new Request(CHAT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
    env,
    executionCtx,
  );
}

/** The guard's verdict code, or null when the guard let the request run. */
async function guardVerdict(res: Response): Promise<string | null> {
  const body = (await res.json()) as { code?: unknown };
  return res.status === 403 &&
    typeof body.code === "string" &&
    GUARD_REJECTION_CODES.has(body.code)
    ? body.code
    : null;
}

describe("W11-CLOUD-01: /api/v1/chat thin-shell CSRF guard", () => {
  test("cookie-authed cross-site simple POST → 403 before route auth or billing", async () => {
    // The finding's attack shape: same-site hosted user content
    // (<slug>.sites.eliza.app) fires a preflight-less text/plain POST and the
    // browser attaches the victim's SameSite=Lax steward cookie.
    const res = await postChat({
      cookie: SESSION_COOKIE,
      origin: HOSTED_USER_CONTENT_ORIGIN,
      "content-type": "text/plain",
    });
    expect(res.status).toBe(403);
    expect(await guardVerdict(res)).toBe("forbidden_origin");
  });

  test("Bearer and X-API-Key callers pass the guard lane", async () => {
    const programmaticHeaders: Record<string, string>[] = [
      { authorization: "Bearer eliza_invalid_key" },
      { "x-api-key": "eliza_invalid_key" },
    ];
    for (const headers of programmaticHeaders) {
      const res = await postChat({ ...headers, "content-type": "text/plain" });
      expect(await guardVerdict(res)).toBeNull();
      expect(res.status).not.toBe(403);
    }
  });

  test("first-party Origin + non-simple marker passes the guard to route auth", async () => {
    const markerHeaders: Record<string, string>[] = [
      { "content-type": "application/json" },
      { "content-type": "text/plain", "x-eliza-csrf": "1" },
    ];
    for (const headers of markerHeaders) {
      const res = await postChat({
        cookie: SESSION_COOKIE,
        origin: FIRST_PARTY_ORIGIN,
        ...headers,
      });
      expect(await guardVerdict(res)).toBeNull();
      // The replayed cookie is invalid, so the route's own auth — which the
      // guard must neither bypass nor short-circuit — answers, not the guard.
      expect(res.status).not.toBe(403);
    }
  });
});
