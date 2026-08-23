/**
 * W11-CLOUD-01: createInferenceApp must 403 an unregistered route object.
 * Official modules are registered by the trusted loader, not by the factory.
 */

import { describe, expect, test } from "bun:test";
import { Hono, type ExecutionContext as HonoExecutionContext } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import chatCompletionsRoute from "../../v1/chat/completions/route";
import { createInferenceApp, registerMountCapability } from "../inference-app";
import { checkMountGuard, MOUNT_GUARD_REJECT_CODE } from "./mount-guard";

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

const MOUNT_URL = "https://api.elizacloud.ai/api/v1/chat/completions";

async function guardVerdict(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown };
  return res.status === 403 && body.code === MOUNT_GUARD_REJECT_CODE
    ? (body.code as string)
    : null;
}

describe("W11-CLOUD-01 mount guard — capability ref not URL", () => {
  test("createInferenceApp with a registered official route is not 403", async () => {
    registerMountCapability(chatCompletionsRoute);
    const app = createInferenceApp(
      "/api/v1/chat/completions",
      chatCompletionsRoute,
    );
    const res = await app.fetch(
      new Request(MOUNT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "x",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      env,
      executionCtx,
    );
    expect(await guardVerdict(res)).toBeNull();
    expect(res.status).toBe(401);
  });

  test("createInferenceApp with an unregistered attacker Hono is 403", async () => {
    const attackerRoute = new Hono<AppEnv>();
    attackerRoute.post("/", (c) => c.json({ ok: true }));
    const app = createInferenceApp("/api/v1/chat/completions", attackerRoute);
    const res = await app.fetch(
      new Request(MOUNT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "x",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      env,
      executionCtx,
    );
    expect(await guardVerdict(res)).toBe(MOUNT_GUARD_REJECT_CODE);
    expect(res.status).toBe(403);
  });

  test("checkMountGuard uses object identity, not URL strings", () => {
    const legitRef = { id: "legit-capability" };
    const attackerSameShape = { id: "legit-capability" };
    registerMountCapability(legitRef);
    expect(checkMountGuard(legitRef).ok).toBe(true);
    expect(checkMountGuard(attackerSameShape).ok).toBe(false);
    expect(checkMountGuard("/api/v1/chat/completions").ok).toBe(false);
    expect(checkMountGuard(new URL(MOUNT_URL).pathname).ok).toBe(false);
  });
});
