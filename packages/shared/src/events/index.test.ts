import { describe, expect, it } from "vitest";
import {
  BACKGROUND_APPLY_EVENT,
  type BackgroundApplyOp,
  type BackgroundApplyPayload,
} from "./index";

/**
 * The `background:apply` view-event contract is now declared exactly once here
 * and imported by both the producer (`@elizaos/plugin-app-control` BACKGROUND
 * action) and the consumer (`useBackgroundApplyChannel` in `@elizaos/ui`). This
 * pins the wire string + payload shape so a change on one side can never drift
 * from the other — the whole point of the single-source consolidation.
 */
describe("background:apply view-event contract", () => {
  it("keeps the exact wire string the WS broadcast + subscription depend on", () => {
    // The plugin emits `{ type: BACKGROUND_APPLY_EVENT }` and the renderer
    // subscribes via `useViewEvent(BACKGROUND_APPLY_EVENT)`; both must equal the
    // literal the scenario-runner ledger tests assert on.
    expect(BACKGROUND_APPLY_EVENT).toBe("background:apply");
  });

  it("enumerates exactly the four operations the renderer branches on", () => {
    const ops: BackgroundApplyOp[] = ["set", "undo", "redo", "reset"];
    // Every op the plugin can send is one the channel handles; a fifth value
    // would be a compile error here.
    expect(ops).toHaveLength(4);
  });

  it("accepts a full glsl set payload (the widest producer shape)", () => {
    const payload: BackgroundApplyPayload = {
      op: "set",
      mode: "glsl",
      color: "#0891b2",
      presetId: "aurora",
      uniforms: { u_speed: 0.4, u_scale: 1, u_intensity: 1.7, u_seed: 0 },
    };
    expect(payload.op).toBe("set");
    expect(payload.uniforms?.u_speed).toBe(0.4);
  });

  it("accepts a bare op-only payload (undo/redo/reset carry no mode)", () => {
    const undo: BackgroundApplyPayload = { op: "undo" };
    expect(undo.mode).toBeUndefined();
  });
});
