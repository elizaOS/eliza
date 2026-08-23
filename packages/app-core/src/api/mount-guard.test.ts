/**
 * Behavioral regression for W11-CLOUD-01 mount guard (app-core) —
 * real Hono app + real route, guardVerdict 403 vs pass-through,
 * capability ref not URL.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  checkMountGuard,
  mountGuardMiddleware,
  registerMountCapability,
  MOUNT_GUARD_REJECT_CODE,
} from "./mount-guard";

async function guardVerdict(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown };
  return res.status === 403 && body.code === MOUNT_GUARD_REJECT_CODE ? (body.code as string) : null;
}

describe("app-core mount guard — capability ref not URL", () => {
  it("bootstrap: same URL, legit ref passes, attacker same-string ref 403", async () => {
    const legitRef = { id: "app-core:bootstrap" } as unknown as object;
    registerMountCapability(legitRef);
    const legitApp = new Hono();
    legitApp.use("*", mountGuardMiddleware(legitRef));
    legitApp.get("/api/test", (c) => c.json({ ok: true }));
    const legitRes = await legitApp.fetch(new Request("https://local.test/api/test"));
    expect(await guardVerdict(legitRes)).toBeNull();
    expect(legitRes.status).toBe(200);

    const attackerRef = { id: "app-core:bootstrap" } as unknown as object; // same string, different object
    const attackerApp = new Hono();
    attackerApp.use("*", mountGuardMiddleware(attackerRef));
    attackerApp.get("/api/test", (c) => c.json({ ok: true }));
    const attackerRes = await attackerApp.fetch(new Request("https://local.test/api/test"));
    expect(await guardVerdict(attackerRes)).toBe(MOUNT_GUARD_REJECT_CODE);
    expect(attackerRes.status).toBe(403);
  });

  it("inference: same URL, different capability ref object → different verdict (ref not URL)", async () => {
    const inferenceLegit = { id: "app-core:inference" } as unknown as object;
    registerMountCapability(inferenceLegit);
    const legitApp = new Hono();
    legitApp.use("*", mountGuardMiddleware(inferenceLegit));
    legitApp.post("/api/v1/chat", (c) => c.json({ ok: true }));
    const legitRes = await legitApp.fetch(new Request("https://local.test/api/v1/chat", { method: "POST" }));
    expect(await guardVerdict(legitRes)).toBeNull();
    expect(legitRes.status).toBe(200);

    const inferenceAttacker = { id: "app-core:inference" } as unknown as object;
    const attackerApp = new Hono();
    attackerApp.use("*", mountGuardMiddleware(inferenceAttacker));
    attackerApp.post("/api/v1/chat", (c) => c.json({ ok: true }));
    const attackerRes = await attackerApp.fetch(new Request("https://local.test/api/v1/chat", { method: "POST" }));
    expect(await guardVerdict(attackerRes)).toBe(MOUNT_GUARD_REJECT_CODE);
  });

  it("checkMountGuard uses object identity, not URL string", () => {
    const ref = { id: "test-ref" } as unknown as object;
    registerMountCapability(ref);
    expect(checkMountGuard(ref).ok).toBe(true);
    expect(checkMountGuard({ id: "test-ref" } as unknown as object).ok).toBe(false);
    expect(checkMountGuard("/api/test").ok).toBe(false);
    expect(checkMountGuard("https://local.test/api/test").ok).toBe(false);
  });
});
