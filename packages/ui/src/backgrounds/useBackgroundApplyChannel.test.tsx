// @vitest-environment jsdom
import { BACKGROUND_APPLY_EVENT as SHARED_BACKGROUND_APPLY_EVENT } from "@elizaos/shared/events";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../state/app-store";
import type { BackgroundConfig } from "../state/ui-preferences";
import { emitViewEvent } from "../views/view-event-bus";
import { getShaderPreset } from "./shader-presets";
import { isPlausibleFragmentSource } from "./shader-schema";
import {
  BACKGROUND_APPLY_EVENT,
  useBackgroundApplyChannel,
} from "./useBackgroundApplyChannel";

function Channel(): null {
  useBackgroundApplyChannel();
  return null;
}

function mountChannel(backgroundConfig: BackgroundConfig) {
  const setBackgroundConfig = vi.fn();
  __setAppValueForTests({
    backgroundConfig,
    setBackgroundConfig,
    undoBackgroundConfig: () => {},
    redoBackgroundConfig: () => {},
    canUndoBackground: false,
    canRedoBackground: false,
  } as never);
  render(<Channel />);
  return setBackgroundConfig;
}

function apply(payload: Record<string, unknown>): void {
  act(() => {
    emitViewEvent(BACKGROUND_APPLY_EVENT, payload, "agent");
  });
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
});

/** A GPU bomb: a bounded `for` loop with a pathological literal bound. It
 * passes the static gate (writes gl_FragColor, no while/do, < 16KB) AND the
 * GL compile — one frame of it can stall the GPU long before the frame-time
 * watchdog's 5-slow-frame threshold. The channel must refuse raw GLSL text
 * outright; presets are the only source of shader code (#11088). */
const FOR_BOMB = `precision highp float;
void main(){
  float acc = 0.0;
  for (int i = 0; i < 200000; i++) { acc += sin(float(i) * 0.001); }
  gl_FragColor = vec4(acc, acc, acc, 1.0);
}`;

describe("useBackgroundApplyChannel — raw GLSL source is not a sink (#11088)", () => {
  it("uses the shared background apply event contract", () => {
    expect(BACKGROUND_APPLY_EVENT).toBe(SHARED_BACKGROUND_APPLY_EVENT);
  });

  it("sanity: the for-bomb slips past the static gate (why the channel must drop it)", () => {
    expect(isPlausibleFragmentSource(FOR_BOMB)).toBe(true);
  });

  it("ignores a payload carrying raw GLSL `source` text (glsl mode)", () => {
    const setBackgroundConfig = mountChannel({
      mode: "shader",
      color: "#101010",
    });
    apply({ op: "set", mode: "glsl", source: FOR_BOMB });
    expect(setBackgroundConfig).not.toHaveBeenCalled();
  });

  it("ignores a payload carrying only raw `source` (no mode/preset)", () => {
    const setBackgroundConfig = mountChannel({
      mode: "shader",
      color: "#101010",
    });
    apply({ op: "set", source: FOR_BOMB });
    expect(setBackgroundConfig).not.toHaveBeenCalled();
  });

  it("applies the PRESET source when a payload names a preset alongside raw text", () => {
    const setBackgroundConfig = mountChannel({
      mode: "shader",
      color: "#101010",
    });
    apply({ op: "set", mode: "glsl", presetId: "aurora", source: FOR_BOMB });
    expect(setBackgroundConfig).toHaveBeenCalledTimes(1);
    const config = setBackgroundConfig.mock.calls[0][0] as BackgroundConfig;
    expect(config.mode).toBe("glsl");
    expect(config.shader?.source).toBe(getShaderPreset("aurora")?.source);
    expect(config.shader?.source).not.toContain("200000");
  });

  it("still applies plain preset payloads (the intended path)", () => {
    const setBackgroundConfig = mountChannel({
      mode: "shader",
      color: "#101010",
    });
    apply({ op: "set", mode: "glsl", presetId: "aurora" });
    expect(setBackgroundConfig).toHaveBeenCalledTimes(1);
    const config = setBackgroundConfig.mock.calls[0][0] as BackgroundConfig;
    expect(config.mode).toBe("glsl");
    expect(config.shader?.presetId).toBe("aurora");
    expect(config.shader?.source).toBe(getShaderPreset("aurora")?.source);
  });

  it("still applies a uniform-only tweak to a live glsl background", () => {
    const auroraSource = getShaderPreset("aurora")?.source ?? "";
    const setBackgroundConfig = mountChannel({
      mode: "glsl",
      color: "#101010",
      shader: {
        presetId: "aurora",
        source: auroraSource,
        uniforms: { u_speed: 1, u_scale: 1, u_intensity: 1, u_seed: 0 },
      },
    });
    apply({ op: "set", mode: "glsl", uniforms: { u_speed: 0.25 } });
    expect(setBackgroundConfig).toHaveBeenCalledTimes(1);
    const config = setBackgroundConfig.mock.calls[0][0] as BackgroundConfig;
    expect(config.shader?.source).toBe(auroraSource);
    expect(config.shader?.uniforms.u_speed).toBe(0.25);
  });
});

describe("useBackgroundApplyChannel — named catalog entry (#13538)", () => {
  it("applies a curated IMAGE catalog entry by id", () => {
    const setBackgroundConfig = mountChannel({
      mode: "shader",
      color: "#101010",
    });
    apply({ op: "set", catalogId: "misty-forest" });
    expect(setBackgroundConfig).toHaveBeenCalledTimes(1);
    const config = setBackgroundConfig.mock.calls[0][0] as BackgroundConfig;
    expect(config.mode).toBe("image");
    expect(config.imageUrl).toContain("data:image/svg+xml");
  });

  it("resolves a catalog GLSL entry through the vetted preset corpus", () => {
    const setBackgroundConfig = mountChannel({
      mode: "shader",
      color: "#101010",
    });
    apply({ op: "set", catalogId: "aurora" });
    expect(setBackgroundConfig).toHaveBeenCalledTimes(1);
    const config = setBackgroundConfig.mock.calls[0][0] as BackgroundConfig;
    expect(config.mode).toBe("glsl");
    expect(config.shader?.presetId).toBe("aurora");
    expect(config.shader?.source).toBe(getShaderPreset("aurora")?.source);
  });

  it("resolves a catalog entry by label / fuzzy name", () => {
    const setBackgroundConfig = mountChannel({
      mode: "shader",
      color: "#101010",
    });
    apply({ op: "set", catalogId: "Misty Forest" });
    expect(setBackgroundConfig).toHaveBeenCalledTimes(1);
    expect(
      (setBackgroundConfig.mock.calls[0][0] as BackgroundConfig).mode,
    ).toBe("image");
  });

  it("IGNORES an unknown catalog name (confinement: never wedges the bg)", () => {
    const setBackgroundConfig = mountChannel({
      mode: "shader",
      color: "#101010",
    });
    apply({ op: "set", catalogId: "definitely-not-a-real-background" });
    expect(setBackgroundConfig).not.toHaveBeenCalled();
  });

  it("a catalogId can NOT smuggle raw GLSL source or a URL past the broker", () => {
    const setBackgroundConfig = mountChannel({
      mode: "shader",
      color: "#101010",
    });
    // Even paired with a for-bomb source + a hostile URL, only the named
    // catalog entry's own (vetted) config is applied — the raw fields are
    // dropped because catalogId short-circuits before the glsl/image branches.
    apply({
      op: "set",
      catalogId: "aurora",
      source: FOR_BOMB,
      imageUrl: "https://evil.example/x.png",
    });
    expect(setBackgroundConfig).toHaveBeenCalledTimes(1);
    const config = setBackgroundConfig.mock.calls[0][0] as BackgroundConfig;
    expect(config.mode).toBe("glsl");
    expect(config.shader?.source).toBe(getShaderPreset("aurora")?.source);
    expect(config.shader?.source).not.toContain("200000");
    expect(config.imageUrl).toBeUndefined();
  });
});
