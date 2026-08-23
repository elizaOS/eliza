/**
 * Behavioral regression for W11-CLOUD-01 mount guard — calls real
 * createInferenceApp + real bootstrap createApp + real mountGuardMiddleware
 * with real Hono routes. Guard is capability-ref-based (WeakSet object
 * identity), not URL string equality: same URL with different capability
 * refs yields 403 vs pass-through.
 */

import { describe, expect, test } from "bun:test";
import { Hono, type ExecutionContext as HonoExecutionContext } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { createInferenceApp } from "../inference-app";
import { createApp } from "../bootstrap-app";
import {
  checkMountGuard,
  mountGuardMiddleware,
  registerMountCapability,
  MOUNT_GUARD_REJECT_CODE,
} from "./mount-guard";
import chatCompletionsRoute from "../../v1/chat/completions/route";

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
const BOOTSTRAP_URL = "https://api.elizacloud.ai/api/v1/agents";

async function guardVerdict(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown };
  return res.status === 403 && body.code === MOUNT_GUARD_REJECT_CODE ? (body.code as string) : null;
}

describe("W11-CLOUD-01 mount guard — capability ref not URL", () => {
  test("createInferenceApp with real route (legit capability ref) → pass-through to route auth, not 403", async () => {
    const app = createInferenceApp("/api/v1/chat/completions", chatCompletionsRoute);
    const res = await app.fetch(
      new Request(MOUNT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      executionCtx,
    );
    // Guard must not 403 legit mount; route's own auth (401) proves pass-through.
    expect(await guardVerdict(res)).toBeNull();
    expect(res.status).toBe(401);
  });

  test("same URL, attacker Hono instance (different capability ref) → 403 mount_guard_rejected", async () => {
    // Attacker creates a different Hono instance with identical mountPath URL
    // but its object identity is not the registered capability ref.
    const attackerRoute = new Hono<AppEnv>();
    attackerRoute.get("/", (c) => c.json({ ok: true }));

    // Build a shell that mounts the attacker route WITHOUT registering it as
    // a known capability. We bypass createInferenceApp's auto-register by
    // using the raw guard directly with an unregistered ref.
    const attackerRef = attackerRoute as unknown as object;
    // Ensure it's not registered (if prior test registered a similar object, create a fresh one)
    const freshAttackerRoute = new Hono<AppEnv>();
    freshAttackerRoute.get("/", (c) => c.json({ ok: true }));
    const freshRef = freshAttackerRoute as unknown as object;

    const app = new Hono<AppEnv>();
    // Use mount guard with unregistered freshRef — same URL conceptually, but
    // capability ref identity differs → 403, not URL equality.
    app.use("*", mountGuardMiddleware(freshRef));
    app.route("/api/v1/chat/completions", freshAttackerRoute);

    const res = await app.fetch(
      new Request(MOUNT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      executionCtx,
    );
    expect(await guardVerdict(res)).toBe(MOUNT_GUARD_REJECT_CODE);
    expect(res.status).toBe(403);
  });

  test("createApp bootstrap mount guard allows legit bootstrap, rejects unknown capability ref via direct middleware", async () => {
    // Legit bootstrap app via createApp uses its internal registered bootstrap ref → pass-through (not 403)
    const app = await createApp();
    const res = await app.fetch(new Request(BOOTSTRAP_URL, { method: "GET" }), env, executionCtx);
    // Bootstrap app's guard is built-in and uses registered ref, so it must not 403 on a normal GET
    // (may be 401/404 depending on auth, but not mount guard 403)
    const verdict = await guardVerdict(res);
    // If the bootstrap guard ever fires, it would be 403 with mount_guard_rejected; legit must not be that.
    expect(verdict).toBeNull();

    // Attacker bootstrap: same URL, different capability ref → 403
    const attackerBootstrapRef = { id: "attacker-bootstrap" } as unknown as object;
    const attackerApp = new Hono<AppEnv>();
    attackerApp.use("*", mountGuardMiddleware(attackerBootstrapRef));
    attackerApp.get("/api/v1/agents", (c) => c.json({ ok: true }));
    const attackerRes = await attackerApp.fetch(new Request(BOOTSTRAP_URL, { method: "GET" }), env, executionCtx);
    expect(await guardVerdict(attackerRes)).toBe(MOUNT_GUARD_REJECT_CODE);
  });

  test("checkMountGuard differentiates capability ref object identity, not URL string", async () => {
    const legitRef = { id: "legit-capability" } as unknown as object;
    const attackerRefSameUrl = { id: "legit-capability" } as unknown as object; // same string content, different object
    registerMountCapability(legitRef);
    expect(checkMountGuard(legitRef).ok).toBe(true);
    expect(checkMountGuard(attackerRefSameUrl).ok).toBe(false);
    // URL string itself is never a valid capability ref
    expect(checkMountGuard("/api/v1/chat/completions").ok).toBe(false);
    expect(checkMountGuard(new URL(MOUNT_URL).pathname).ok).toBe(false);
  });
});
