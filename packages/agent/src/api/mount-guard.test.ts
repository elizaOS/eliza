/**
 * Behavioral regression for W11-CLOUD-01 mount guard (agent) + walk clone
 * drops function values. Calls real functions with real Hono app + real route.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { cloneWithoutBlockedObjectKeys } from "./blocked-object-keys";
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

describe("agent mount guard — capability ref not URL", () => {
  it("legit capability ref → pass-through, same URL with attacker ref → 403", async () => {
    const legitRef = { id: "legit-agent-mount" } as unknown as object;
    registerMountCapability(legitRef);

    const legitApp = new Hono();
    legitApp.use("*", mountGuardMiddleware(legitRef));
    legitApp.get("/api/test", (c) => c.json({ ok: true }));
    const legitRes = await legitApp.fetch(new Request("https://local.test/api/test"));
    expect(await guardVerdict(legitRes)).toBeNull();
    expect(legitRes.status).toBe(200);

    // Same URL string, different capability ref object (not registered) → 403
    const attackerRef = { id: "legit-agent-mount" } as unknown as object; // same string content, different object identity
    const attackerApp = new Hono();
    attackerApp.use("*", mountGuardMiddleware(attackerRef));
    attackerApp.get("/api/test", (c) => c.json({ ok: true }));
    const attackerRes = await attackerApp.fetch(new Request("https://local.test/api/test"));
    expect(await guardVerdict(attackerRes)).toBe(MOUNT_GUARD_REJECT_CODE);
    expect(attackerRes.status).toBe(403);

    // URL string itself never passes
    expect(checkMountGuard("/api/test").ok).toBe(false);
  });

  it("hono-adapter bootstrap guard uses runtime capability ref, not URL", async () => {
    // Simulate bootstrap mount capability as runtime object identity
    const fakeRuntime = { routes: [] } as unknown as object;
    registerMountCapability(fakeRuntime);
    expect(checkMountGuard(fakeRuntime).ok).toBe(true);
    // Different runtime object with same shape → not same ref → fails
    const otherRuntime = { routes: [] } as unknown as object;
    expect(checkMountGuard(otherRuntime).ok).toBe(false);
  });
});

describe("walk clone drops function values", () => {
  it("drops function-typed property values at top level and nested", () => {
    const fn = () => "evil";
    const payload: any = {
      keep: "yes",
      fn,
      nested: { keep: 1, fn, deep: { fn, keep2: 2 } },
      arr: [1, fn, { keep: 3, fn }],
    };
    const clean: any = cloneWithoutBlockedObjectKeys(payload);
    // Function properties must be dropped, not retained
    expect(clean).toEqual({
      keep: "yes",
      nested: { keep: 1, deep: { keep2: 2 } },
      arr: [1, , { keep: 3 }], // sparse hole where function was
    });
    expect("fn" in clean).toBe(false);
    expect("fn" in clean.nested).toBe(false);
    expect("fn" in clean.nested.deep).toBe(false);
    expect(clean.arr[1]).toBeUndefined();
    expect("fn" in clean.arr[2]).toBe(false);
    // Ensure blocked keys still dropped
    const hostile: any = { safe: 1, __proto__: { polluted: true }, fn };
    const cleanHostile: any = cloneWithoutBlockedObjectKeys(hostile);
    expect(cleanHostile).toEqual({ safe: 1 });
    expect(({} as any).polluted).toBeUndefined();
  });

  it("top-level function returns undefined (dropped)", () => {
    const fn: any = () => {};
    const result: any = cloneWithoutBlockedObjectKeys(fn);
    expect(result).toBeUndefined();
  });

  it("array function entries are dropped (sparse)", () => {
    const fn = () => 1;
    const arr: any = [fn, "keep", fn];
    const clean: any = cloneWithoutBlockedObjectKeys(arr);
    expect(clean.length).toBe(3);
    expect(clean[0]).toBeUndefined();
    expect(clean[1]).toBe("keep");
    expect(clean[2]).toBeUndefined();
    // Holes remain sparse where functions were
    expect(0 in clean).toBe(false);
    expect(2 in clean).toBe(false);
    expect(1 in clean).toBe(true);
  });
});
