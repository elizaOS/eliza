/**
 * W11-CLOUD-01: buildHonoAppForRuntime 403s an unregistered runtime.
 * The host (hono-mount) registers the runtime; the adapter does not.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { cloneWithoutBlockedObjectKeys } from "./blocked-object-keys";
import { buildHonoAppForRuntime } from "./hono-adapter.ts";
import {
  checkMountGuard,
  MOUNT_GUARD_REJECT_CODE,
  mountGuardMiddleware,
  registerMountCapability,
} from "./mount-guard";

function emptyRuntime(): IAgentRuntime {
  return { routes: [] } as unknown as IAgentRuntime;
}

async function guardVerdict(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown };
  return res.status === 403 && body.code === MOUNT_GUARD_REJECT_CODE
    ? (body.code as string)
    : null;
}

describe("agent mount guard — capability ref not URL", () => {
  it("buildHonoAppForRuntime 403s when the runtime was not registered", async () => {
    const runtime = emptyRuntime();
    const app = buildHonoAppForRuntime(runtime, { isAuthorized: () => true });
    const res = await app.request("/api/anything");
    expect(await guardVerdict(res)).toBe(MOUNT_GUARD_REJECT_CODE);
    expect(res.status).toBe(403);
  });

  it("buildHonoAppForRuntime passes when the host registered the runtime", async () => {
    const runtime = emptyRuntime();
    registerMountCapability(runtime as unknown as object);
    const app = buildHonoAppForRuntime(runtime, { isAuthorized: () => true });
    const res = await app.request("/api/anything");
    expect(await guardVerdict(res)).toBeNull();
    expect(res.status).toBe(404);
  });

  it("same-shape runtime objects do not share capability identity", () => {
    const a = emptyRuntime();
    registerMountCapability(a as unknown as object);
    expect(checkMountGuard(a).ok).toBe(true);
    expect(checkMountGuard(emptyRuntime()).ok).toBe(false);
    expect(checkMountGuard("/api/test").ok).toBe(false);
  });

  it("unregistered middleware ref is 403 even on an identical URL", async () => {
    const attackerRef = { id: "legit-agent-mount" };
    const attackerApp = new Hono();
    attackerApp.use("*", mountGuardMiddleware(attackerRef));
    attackerApp.get("/api/test", (c) => c.json({ ok: true }));
    const attackerRes = await attackerApp.fetch(
      new Request("https://local.test/api/test"),
    );
    expect(await guardVerdict(attackerRes)).toBe(MOUNT_GUARD_REJECT_CODE);
  });
});

describe("walk clone drops function values", () => {
  it("drops function-typed property values at top level and nested", () => {
    const fn = () => "evil";
    const payload: Record<string, unknown> = {
      keep: "yes",
      fn,
      nested: { keep: 1, fn, deep: { fn, keep2: 2 } },
      arr: [1, fn, { keep: 3, fn }],
    };
    const clean = cloneWithoutBlockedObjectKeys(payload) as Record<
      string,
      unknown
    >;
    expect(clean.keep).toBe("yes");
    expect("fn" in clean).toBe(false);
    const nested = clean.nested as Record<string, unknown>;
    expect(nested.keep).toBe(1);
    expect("fn" in nested).toBe(false);
    const deep = nested.deep as Record<string, unknown>;
    expect(deep.keep2).toBe(2);
    expect("fn" in deep).toBe(false);
    const arr = clean.arr as unknown[];
    expect(arr[1]).toBeUndefined();
  });
});
