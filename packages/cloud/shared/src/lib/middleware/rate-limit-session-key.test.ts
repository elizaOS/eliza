/**
 * The default rate-limit key must not come from an API-key header that a
 * session request carries but nothing checks. A signed-in caller sending a new
 * random X-API-Key per request used to get a fresh window each time. Requests
 * run in production order: no auth middleware validates the key before the
 * route limiter, so `apiKeyId` is never set here.
 */
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/cloud-worker-env";
import { LEGACY_STEWARD_COOKIES } from "../auth/steward-cookies";
import { rateLimit } from "./rate-limit-hono-cloudflare";

/** A Cloudflare rate-limit binding that allows two requests per key. */
function bindingAllowingTwo() {
  const counts = new Map<string, number>();
  return {
    keys: counts,
    limit: async ({ key }: { key: string }) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: (counts.get(key) ?? 0) <= 2 };
    },
  };
}

async function statuses(requests: Array<Record<string, string>>): Promise<number[]> {
  const binding = bindingAllowingTwo();
  const app = new Hono<AppEnv>()
    .use("*", rateLimit({ windowMs: 60_000, maxRequests: 2 }, { bindingName: "TEST_LIMIT" }))
    .post("*", (c) => c.json({ ok: true }));
  const result: number[] = [];
  for (const headers of requests) {
    const response = await app.request(
      "/api/signup-code/redeem",
      { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7", ...headers } },
      { TEST_LIMIT: binding, NODE_ENV: "test" },
    );
    result.push(response.status);
  }
  return result;
}

const session = { cookie: `${LEGACY_STEWARD_COOKIES.token}=session-token-of-one-user` };

test("a session request that varies X-API-Key stays in one window", async () => {
  const requests = [1, 2, 3].map(() => ({
    ...session,
    "X-API-Key": `random-${crypto.randomUUID()}`,
  }));
  expect(await statuses(requests)).toEqual([200, 200, 429]);
});

test("a caller that varies an unchecked session Bearer stays in one window", async () => {
  const requests = [1, 2, 3].map(() => ({ authorization: `Bearer random-${crypto.randomUUID()}` }));
  expect(await statuses(requests)).toEqual([200, 200, 429]);
});

test("API-key clients behind one IP keep separate windows", async () => {
  const a = { "X-API-Key": "eliza_customer_a" };
  const b = { "X-API-Key": "eliza_customer_b" };
  expect(await statuses([a, a, b, b])).toEqual([200, 200, 200, 200]);
});
