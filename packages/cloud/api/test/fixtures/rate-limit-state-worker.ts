import { createHash } from "node:crypto";
import { rateLimit } from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { runWithCloudBindings } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  checkRateLimitRedis,
  clearRateLimit,
  getRateLimitStatus,
} from "../../../shared/src/lib/middleware/rate-limit-redis";

export { RateLimitState } from "../../src/rate-limit-state";

const app = new Hono<AppEnv>();
app.use("*", (c, next) => runWithCloudBindings(c.env, next));
app.use(
  "/fixed",
  rateLimit({
    windowMs: 10000,
    maxRequests: 3,
    keyGenerator: (c) => c.req.header("x-test-key") ?? "fixed",
    redisUnavailableFallback: { namespace: "fixture" },
  }),
);
app.get("/fixed", (c) => c.json({ served: true }));
app.post("/sliding", async (c) => {
  const {
    key,
    operation,
    carriedCount = 0,
  } = await c.req.json<{
    key: string;
    operation: string;
    carriedCount?: number;
  }>();
  if (operation === "clear") {
    await clearRateLimit(key);
    return c.json({ cleared: true });
  }
  return c.json(
    operation === "status"
      ? await getRateLimitStatus(key, 10000, 3)
      : await checkRateLimitRedis(key, 10000, 3, { carriedCount }),
  );
});
app.post("/import", async (c) => {
  const body = await c.req.json<{ key: string }>();
  const shard = createHash("sha256").update(body.key).digest("hex").slice(0, 2);
  if (!c.env.RATE_LIMIT_STATE) throw new Error("Missing test binding");
  return c.env.RATE_LIMIT_STATE.getByName(`rate-v1:${shard}`).fetch(
    "https://rate-state.internal/",
    {
      method: "POST",
      body: JSON.stringify({
        ...body,
        operation: "import",
        sourceQuiesced: true,
      }),
    },
  );
});
export default app;
