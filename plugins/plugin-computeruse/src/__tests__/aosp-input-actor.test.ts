/**
 * WS7 — AospInputActor stub tests.
 *
 * Exercises the privileged-build adapter that maps cascade-resolved
 * `ProposedAction`s into `injectMotionEvent` calls. We don't have a real
 * AOSP build on this Linux host, so this is pure-JS — a fake
 * `AospPrivilegedInputBridge` records the calls and we assert the call
 * sequence + the `ActionResult` envelope shape (matching `dispatch.ts`).
 */

import { describe, expect, it } from "vitest";
import {
  AospInputActor,
  MOTION_EVENT_ACTION_DOWN,
  MOTION_EVENT_ACTION_MOVE,
  MOTION_EVENT_ACTION_UP,
  type AospPrivilegedInputBridge,
} from "../actor/aosp-input-actor.js";
import type { ProposedAction } from "../actor/types.js";

interface BridgeCall {
  x: number;
  y: number;
  action: number;
  downTimeMs: number;
}

function fakeBridge(opts: { failAt?: number } = {}): {
  bridge: AospPrivilegedInputBridge;
  calls: BridgeCall[];
} {
  const calls: BridgeCall[] = [];
  let i = 0;
  const bridge: AospPrivilegedInputBridge = {
    async injectMotionEvent(args) {
      calls.push(args);
      i += 1;
      if (opts.failAt !== undefined && i === opts.failAt) {
        return { ok: false };
      }
      return { ok: true };
    },
  };
  return { bridge, calls };
}

describe("AospInputActor — happy paths", () => {
  it("click → DOWN then UP at the same point", async () => {
    const { bridge, calls } = fakeBridge();
    const actor = new AospInputActor({ getBridge: () => bridge, now: () => 1000 });
    const action: ProposedAction = {
      kind: "click",
      displayId: 0,
      x: 100,
      y: 200,
      rationale: "tap save",
    };
    const result = await actor.execute(action);
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ x: 100, y: 200, action: MOTION_EVENT_ACTION_DOWN, downTimeMs: 1000 });
    expect(calls[1]).toMatchObject({ x: 100, y: 200, action: MOTION_EVENT_ACTION_UP });
    expect(calls[1]?.downTimeMs).toBeGreaterThan(1000);
  });

  it("double_click → two DOWN/UP pairs", async () => {
    const { bridge, calls } = fakeBridge();
    const actor = new AospInputActor({ getBridge: () => bridge });
    await actor.execute({
      kind: "double_click",
      displayId: 0,
      x: 50,
      y: 60,
      rationale: "",
    });
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.action)).toEqual([
      MOTION_EVENT_ACTION_DOWN,
      MOTION_EVENT_ACTION_UP,
      MOTION_EVENT_ACTION_DOWN,
      MOTION_EVENT_ACTION_UP,
    ]);
  });

  it("drag → DOWN/MOVE/UP across path endpoints", async () => {
    const { bridge, calls } = fakeBridge();
    const actor = new AospInputActor({ getBridge: () => bridge, now: () => 5_000 });
    const action: ProposedAction = {
      kind: "drag",
      displayId: 0,
      startX: 10,
      startY: 20,
      x: 500,
      y: 800,
      rationale: "drag",
    };
    const result = await actor.execute(action);
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.action).toBe(MOTION_EVENT_ACTION_DOWN);
    expect(calls[1]?.action).toBe(MOTION_EVENT_ACTION_MOVE);
    expect(calls[2]?.action).toBe(MOTION_EVENT_ACTION_UP);
    expect(calls[2]?.x).toBe(500);
    expect(calls[2]?.y).toBe(800);
  });

  it("scroll → DOWN/MOVE/UP with inverted sign convention", async () => {
    const { bridge, calls } = fakeBridge();
    const actor = new AospInputActor({ getBridge: () => bridge, now: () => 5_000 });
    await actor.execute({
      kind: "scroll",
      displayId: 0,
      x: 540,
      y: 960,
      dx: 0,
      dy: 2,
      rationale: "scroll",
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.y).toBe(960);
    // dy=2 → endY = 960 - 2*200 = 560 (swipe upward)
    expect(calls[2]?.y).toBe(560);
  });

  it("wait / finish are no-ops with success:true", async () => {
    const { bridge, calls } = fakeBridge();
    const actor = new AospInputActor({ getBridge: () => bridge });
    const r1 = await actor.execute({ kind: "wait", displayId: 0, rationale: "" });
    const r2 = await actor.execute({ kind: "finish", displayId: 0, rationale: "" });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("AospInputActor — invalid args + driver_error", () => {
  it("type/key/hotkey return invalid_args (privileged-input doesn't handle text)", async () => {
    const { bridge } = fakeBridge();
    const actor = new AospInputActor({ getBridge: () => bridge });
    for (const kind of ["type", "key", "hotkey"] as const) {
      const r = await actor.execute({ kind, displayId: 0, rationale: "" } as ProposedAction);
      expect(r.success).toBe(false);
      expect(r.error?.code).toBe("invalid_args");
    }
  });

  it("returns driver_error when the bridge is null (consumer build)", async () => {
    const actor = new AospInputActor({ getBridge: () => null });
    const r = await actor.execute({
      kind: "click",
      displayId: 0,
      x: 10,
      y: 10,
      rationale: "",
    });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("driver_error");
    expect(r.error?.message).toMatch(/not available/);
  });

  it("missing click coords → invalid_args", async () => {
    const { bridge } = fakeBridge();
    const actor = new AospInputActor({ getBridge: () => bridge });
    const r = await actor.execute({ kind: "click", displayId: 0, rationale: "" });
    expect(r.error?.code).toBe("invalid_args");
  });

  it("missing scroll dx/dy → invalid_args", async () => {
    const { bridge } = fakeBridge();
    const actor = new AospInputActor({ getBridge: () => bridge });
    const r = await actor.execute({
      kind: "scroll",
      displayId: 0,
      x: 10,
      y: 10,
      rationale: "",
    });
    expect(r.error?.code).toBe("invalid_args");
  });

  it("bridge throwing → driver_error, action message surfaces", async () => {
    const bridge: AospPrivilegedInputBridge = {
      injectMotionEvent: async () => {
        throw new Error("INJECT_EVENTS denied");
      },
    };
    const actor = new AospInputActor({ getBridge: () => bridge });
    const r = await actor.execute({
      kind: "click",
      displayId: 0,
      x: 10,
      y: 10,
      rationale: "",
    });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("driver_error");
    expect(r.error?.message).toContain("INJECT_EVENTS denied");
  });

  it("bridge returning ok:false partway through tap → driver_error", async () => {
    const { bridge } = fakeBridge({ failAt: 2 });
    const actor = new AospInputActor({ getBridge: () => bridge });
    const r = await actor.execute({
      kind: "click",
      displayId: 0,
      x: 10,
      y: 10,
      rationale: "",
    });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("driver_error");
    expect(r.error?.message).toContain("UP");
  });
});
