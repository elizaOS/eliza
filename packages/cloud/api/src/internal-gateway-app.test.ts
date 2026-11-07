/** Gateway shells retain route authentication and Worker middleware after extraction. */
import { describe, expect, test } from "bun:test";
import {
  getClientIp,
  getRequestIdempotencyKey,
  getRequestTaskDefer,
} from "@elizaos/cloud-shared/lib/runtime/request-context";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { ExecutionContext } from "hono";
import { createDiscordGatewayApp } from "./discord-gateway-app";
import { createPersonalSharedApp } from "./personal-shared-app";

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: undefined,
} satisfies ExecutionContext;
const env = {
  ENVIRONMENT: "test",
  NODE_ENV: "test",
  REDIS_RATE_LIMITING: "false",
  CACHE_ENABLED: "false",
  DATABASE_URL: "postgres://test.invalid/eliza",
  BLOB: {},
} as AppEnv["Bindings"];

for (const [name, createApp, route, emptyKey] of [
  [
    "Discord",
    createDiscordGatewayApp,
    "/api/internal/discord/eliza-app/messages",
    "",
  ],
  [
    "Personal Shared",
    createPersonalSharedApp,
    "/api/internal/eliza-app/personal-shared/messages",
    "request-id",
  ],
] as const) {
  describe(`${name} gateway shell`, () => {
    test("preserves request context, deferred work and response headers", async () => {
      const app = createApp();
      const deferred: Promise<unknown>[] = [];
      app.get("/probe", (c) => {
        getRequestTaskDefer()?.(Promise.resolve("completed"));
        return c.json({ ip: getClientIp(), key: getRequestIdempotencyKey() });
      });
      const response = await app.fetch(
        new Request("https://api.elizacloud.ai/probe", {
          headers: {
            "cf-connecting-ip": "192.0.2.1",
            "idempotency-key": "",
            "x-request-id": "request-id",
          },
        }),
        env,
        { ...executionCtx, waitUntil: (task) => deferred.push(task) },
      );
      expect(response.status).toBe(200);
      const payload: { ip: string; key: string } = await response.json();
      expect(payload).toEqual({ ip: "192.0.2.1", key: emptyKey });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Server-Timing")).toContain("cloud_worker");
      expect(deferred).toHaveLength(1);
      await expect(deferred[0]).resolves.toBe("completed");
    });

    test("keeps internal authentication on the canonical route", async () => {
      const response = await createApp().fetch(
        new Request(`https://api.elizacloud.ai${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        env,
        executionCtx,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });

    test("rejects production traffic when the native limiter is missing or fails", async () => {
      for (const binding of [
        undefined,
        {
          limit: async () => {
            throw new Error("limiter unavailable");
          },
        },
      ]) {
        let reached = false;
        const app = createApp();
        app.get("/probe", (c) => {
          reached = true;
          return c.json({ ok: true });
        });
        const response = await app.fetch(
          new Request("https://api.elizacloud.ai/probe"),
          { ...env, NODE_ENV: "production", GLOBAL_RATE_LIMITER: binding },
          executionCtx,
        );
        expect(response.status).toBe(503);
        expect(reached).toBe(false);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
    });
  });
}
