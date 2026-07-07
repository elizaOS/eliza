// @vitest-environment jsdom
/**
 * Rail-gesture present-throttle contract (#15282): while the home↔launcher rail
 * is mid-gesture the loop must keep the rAF ticking but cap the GL present to
 * RAIL_GESTURE_FRAME_INTERVAL_MS, resume full rate within one frame of settle
 * with monotonic wall-clock u_time, and never let the throttle feed the
 * gpu-stall watchdog. THREE is mocked so `renderer.render` (the present) is a
 * countable side effect; rAF is a manually-drained queue and performance.now is
 * a driven clock, so frame timing is fully deterministic under jsdom.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginRailGesture,
  endRailGesture,
  resetRailGestureForTests,
} from "../state/rail-gesture-store";
import { ProgrammableShaderBackground } from "./ProgrammableShaderBackground";
import { getShaderPreset } from "./shader-presets";
import { DEFAULT_SHADER_UNIFORMS } from "./shader-schema";

const state = vi.hoisted(() => ({
  renderCalls: 0,
  uniformSets: [] as Array<Record<string, { value: unknown }>>,
}));

vi.mock("three", () => {
  const compilingGl = {
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader: () => {},
  };
  class WebGLRenderer {
    domElement = document.createElement("canvas");
    getContext() {
      return compilingGl;
    }
    setPixelRatio() {}
    setSize() {}
    render() {
      state.renderCalls += 1;
    }
    dispose() {}
  }
  class Vector2 {
    set() {}
  }
  class Vector3 {
    constructor(
      public x = 0,
      public y = 0,
      public z = 0,
    ) {}
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  }
  class Scene {
    add() {}
  }
  class Camera {}
  class BufferGeometry {
    setAttribute() {}
    dispose() {}
  }
  class BufferAttribute {}
  class RawShaderMaterial {
    uniforms: Record<string, { value: unknown }>;
    constructor(params: { uniforms: Record<string, { value: unknown }> }) {
      this.uniforms = params.uniforms;
      state.uniformSets.push(params.uniforms);
    }
    dispose() {}
  }
  class Mesh {}
  return {
    WebGLRenderer,
    Vector2,
    Vector3,
    Scene,
    Camera,
    BufferGeometry,
    BufferAttribute,
    RawShaderMaterial,
    Mesh,
  };
});

const SOURCE = getShaderPreset("aurora")?.source ?? "";

// The wallpaper loop reads performance.now() (not the rAF callback arg) for its
// clock, so a driven clock + a manually-drained rAF queue make one "vsync" a
// single `tick(ms)` call: advance the clock, then run exactly one queued frame.
let fakeNow = 0;
let rafQueue: Array<FrameRequestCallback>;
let nextRafId: number;

function tick(ms: number): void {
  fakeNow += ms;
  const cb = rafQueue.shift();
  if (!cb) throw new Error("no rAF scheduled — the loop stopped ticking");
  cb(fakeNow);
}

const MOUNT_TIME = 1_000;

beforeEach(() => {
  state.renderCalls = 0;
  state.uniformSets.length = 0;
  resetRailGestureForTests();
  fakeNow = MOUNT_TIME;
  rafQueue = [];
  nextRafId = 0;
  vi.spyOn(performance, "now").mockImplementation(() => fakeNow);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    nextRafId += 1;
    return nextRafId;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  resetRailGestureForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  return render(
    <ProgrammableShaderBackground
      source={SOURCE}
      uniforms={DEFAULT_SHADER_UNIFORMS}
      color="#ef5a1f"
    />,
  );
}

describe("ProgrammableShaderBackground — rail-gesture present throttle (#15282)", () => {
  it("presents every tick at full rate when no gesture is active", () => {
    mount();
    // Mount schedules the loop but does not present; each vsync presents once.
    expect(state.renderCalls).toBe(0);
    for (let i = 1; i <= 5; i += 1) {
      tick(16);
      expect(state.renderCalls).toBe(i);
    }
  });

  it("caps presents to the throttle interval while the rail gesture is active", () => {
    mount();
    beginRailGesture();
    const before = state.renderCalls;
    // 8 vsyncs at 16ms = 128ms of gesture: with a 66ms cap only the first tick
    // (seeded to present) and the one crossing the next 66ms boundary present.
    for (let i = 0; i < 8; i += 1) tick(16);
    expect(state.renderCalls - before).toBe(2);
    // The rAF kept ticking the whole time — the loop is still scheduled.
    expect(rafQueue).toHaveLength(1);
  });

  it("resumes full-rate within one frame of settle with monotonic u_time and no reset", () => {
    mount();
    beginRailGesture();
    for (let i = 0; i < 4; i += 1) tick(16); // throttled window
    const throttledPresents = state.renderCalls;
    const uTimeBefore = state.uniformSets[0].u_time.value as number;

    endRailGesture();
    tick(16); // first vsync after settle MUST present

    expect(state.renderCalls).toBe(throttledPresents + 1);
    const uTimeAfter = state.uniformSets[0].u_time.value as number;
    // Wall-clock continuity: u_time strictly advances and equals (now-start)/s,
    // proving skipped presents never reset or rewind shader time on resume.
    expect(uTimeAfter).toBeGreaterThan(uTimeBefore);
    expect(uTimeAfter).toBeCloseTo((fakeNow - MOUNT_TIME) / 1000, 10);
  });

  it("throttled ticks never feed the gpu-stall watchdog (no false fallback)", () => {
    const onFallback = vi.fn();
    render(
      <ProgrammableShaderBackground
        source={SOURCE}
        uniforms={DEFAULT_SHADER_UNIFORMS}
        color="#ef5a1f"
        onFallback={onFallback}
      />,
    );
    beginRailGesture();
    // 10 healthy 16ms vsyncs while throttled: dt stays 16ms per tick, so the
    // watchdog's slow-frame counter never climbs — the regression a pause-based
    // design would trip (a >120ms resume dt fabricating a gpu-stall).
    for (let i = 0; i < 10; i += 1) tick(16);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("reduced-motion renders one static frame and schedules no loop, gesture or not", () => {
    vi.stubGlobal(
      "matchMedia",
      () => ({ matches: true }) as unknown as MediaQueryList,
    );
    mount();
    beginRailGesture();
    // Reduced motion paints exactly one static frame and never starts a rAF, so
    // the throttle path is unreachable — behavior is unchanged by the gesture.
    expect(state.renderCalls).toBe(1);
    expect(rafQueue).toHaveLength(0);
  });

  it("gesture already active at mount still presents the first frame", () => {
    beginRailGesture();
    mount();
    expect(state.renderCalls).toBe(0);
    tick(16);
    // lastPresented is seeded one interval in the past, so an in-flight gesture
    // cannot suppress the first paint — the wallpaper is never blank on arrival.
    expect(state.renderCalls).toBe(1);
  });

  it("self-heals to full rate after the park-max window if a release edge is missed", () => {
    mount();
    beginRailGesture();
    // Age the gesture past the 5s park-max in healthy 100ms steps (dt < 120ms so
    // the watchdog stays quiet); throttling caps presents across this window.
    while (fakeNow - MOUNT_TIME < 5_000) tick(100);
    const before = state.renderCalls;
    // Valve is now open: consecutive 16ms vsyncs each present despite the
    // never-released gesture, so a stuck signal can't wedge the wallpaper.
    for (let i = 0; i < 3; i += 1) tick(16);
    expect(state.renderCalls - before).toBe(3);
  });
});
