/** Verifies voiceCaptureDebug breadcrumb ring (device HUD source) through the package's configured test harness. */
import { afterEach, describe, expect, it } from "vitest";
import {
  getVoiceCaptureBreadcrumbs,
  resetVoiceCaptureBreadcrumbs,
  subscribeVoiceCaptureBreadcrumbs,
  VOICE_HUD_RING_SIZE,
  voiceCaptureDebug,
} from "./voice-capture-debug";

/**
 * The on-screen voice HUD reads the breadcrumb ring these tests lock down: the
 * ring is populated UNCONDITIONALLY (no `eliza:voice:debug` gate), a fresh
 * `mic:tap` starts a clean trace, subscribers see each push, and the ring is
 * bounded so a long-lived session can't grow it without limit.
 */
describe("voiceCaptureDebug breadcrumb ring (device HUD source)", () => {
  afterEach(() => {
    resetVoiceCaptureBreadcrumbs();
  });

  it("records breadcrumbs even without the console-debug flag enabled", () => {
    // No localStorage / env flag set — the console sink is off, but the HUD
    // ring must still capture the trace (the whole point of the on-screen HUD).
    voiceCaptureDebug("gum:req");
    voiceCaptureDebug("gum:ok", { ms: 120 });
    const ring = getVoiceCaptureBreadcrumbs();
    expect(ring.map((b) => b.step)).toEqual(["gum:req", "gum:ok"]);
    expect(ring[1]?.detail).toEqual({ ms: 120 });
  });

  it("starts a fresh trace on mic:tap (clears the prior attempt)", () => {
    voiceCaptureDebug("gum:req");
    voiceCaptureDebug("gum:err", { name: "NotAllowedError" });
    // A new tap should reset so the HUD shows only THIS tap's lifecycle.
    voiceCaptureDebug("mic:tap", { surface: "composer" });
    voiceCaptureDebug("gum:req");
    const ring = getVoiceCaptureBreadcrumbs();
    expect(ring.map((b) => b.step)).toEqual(["mic:tap", "gum:req"]);
  });

  it("notifies subscribers on every push and on reset", () => {
    const snapshots: string[][] = [];
    const unsubscribe = subscribeVoiceCaptureBreadcrumbs((ring) => {
      snapshots.push(ring.map((b) => b.step));
    });
    // Immediate invoke gives an initial (empty) snapshot.
    expect(snapshots.at(-1)).toEqual([]);
    voiceCaptureDebug("mic:tap");
    voiceCaptureDebug("gum:req");
    expect(snapshots.at(-1)).toEqual(["mic:tap", "gum:req"]);
    unsubscribe();
    voiceCaptureDebug("gum:ok");
    // No further snapshots after unsubscribe.
    expect(snapshots.at(-1)).toEqual(["mic:tap", "gum:req"]);
  });

  it("bounds the ring to VOICE_HUD_RING_SIZE (drops oldest)", () => {
    voiceCaptureDebug("mic:tap");
    for (let i = 0; i < VOICE_HUD_RING_SIZE + 5; i += 1) {
      voiceCaptureDebug(`step:${i}`);
    }
    const ring = getVoiceCaptureBreadcrumbs();
    expect(ring.length).toBe(VOICE_HUD_RING_SIZE);
    // The oldest (mic:tap + earliest steps) were evicted; the newest remain.
    expect(ring.at(-1)?.step).toBe(`step:${VOICE_HUD_RING_SIZE + 4}`);
  });

  it("assigns monotonic sequence ids and wall-clock offsets", () => {
    voiceCaptureDebug("mic:tap");
    voiceCaptureDebug("gum:req");
    const ring = getVoiceCaptureBreadcrumbs();
    expect(ring[1]?.seq).toBeGreaterThan(ring[0]?.seq ?? 0);
    expect(typeof ring[0]?.atMs).toBe("number");
    expect(ring[1]?.atMs).toBeGreaterThanOrEqual(ring[0]?.atMs ?? 0);
  });
});
