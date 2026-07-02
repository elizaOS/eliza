// @vitest-environment jsdom
/**
 * Effect-splitting contract (#11088): a uniform/color-only prop change must
 * MUTATE the live uniforms in place — never tear down + rebuild the
 * THREE.WebGLRenderer (browsers cap ~16 live WebGL contexts, and a rebuild
 * recompiles the shader). Only a `source` change may rebuild. THREE is mocked
 * so renderer construction is observable in jsdom.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgrammableShaderBackground } from "./ProgrammableShaderBackground";
import { DEFAULT_SHADER_UNIFORMS } from "./shader-schema";

const state = vi.hoisted(() => ({
  rendererCount: 0,
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
    constructor() {
      state.rendererCount += 1;
    }
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

const SOURCE_A =
  "precision highp float; void main(){ gl_FragColor = vec4(1.0); }";
const SOURCE_B =
  "precision highp float; void main(){ gl_FragColor = vec4(0.5); }";

beforeEach(() => {
  state.rendererCount = 0;
  state.renderCalls = 0;
  state.uniformSets.length = 0;
  // Freeze the animation loop so frame counts are deterministic.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProgrammableShaderBackground — uniform tweaks must not rebuild the GL context (#11088)", () => {
  it("mutates live uniforms in place on a uniform/color-only change (no renderer rebuild)", () => {
    const { rerender } = render(
      <ProgrammableShaderBackground
        source={SOURCE_A}
        uniforms={DEFAULT_SHADER_UNIFORMS}
        color="#ffffff"
      />,
    );
    expect(state.rendererCount).toBe(1);
    expect(state.uniformSets).toHaveLength(1);
    const live = state.uniformSets[0];
    expect(live.u_speed.value).toBe(DEFAULT_SHADER_UNIFORMS.u_speed);

    rerender(
      <ProgrammableShaderBackground
        source={SOURCE_A}
        uniforms={{ ...DEFAULT_SHADER_UNIFORMS, u_speed: 2.5 }}
        color="#000000"
      />,
    );
    // The heavy build path was NOT re-entered…
    expect(state.rendererCount).toBe(1);
    expect(state.uniformSets).toHaveLength(1);
    // …and the SAME live uniform objects were mutated in place.
    expect(live.u_speed.value).toBe(2.5);
    const colorVec = live.u_color.value as { x: number; y: number; z: number };
    expect(colorVec.x).toBe(0);
    expect(colorVec.y).toBe(0);
    expect(colorVec.z).toBe(0);
  });

  it("rebuilds (recompiles) only when the shader source changes", () => {
    const { rerender } = render(
      <ProgrammableShaderBackground
        source={SOURCE_A}
        uniforms={DEFAULT_SHADER_UNIFORMS}
        color="#ffffff"
      />,
    );
    expect(state.rendererCount).toBe(1);
    rerender(
      <ProgrammableShaderBackground
        source={SOURCE_B}
        uniforms={DEFAULT_SHADER_UNIFORMS}
        color="#ffffff"
      />,
    );
    expect(state.rendererCount).toBe(2);
    expect(state.uniformSets).toHaveLength(2);
  });

  it("repaints the single static frame after a tweak under reduced motion", () => {
    vi.stubGlobal(
      "matchMedia",
      () => ({ matches: true }) as unknown as MediaQueryList,
    );

    const { rerender } = render(
      <ProgrammableShaderBackground
        source={SOURCE_A}
        uniforms={DEFAULT_SHADER_UNIFORMS}
        color="#ffffff"
      />,
    );
    // Reduced motion renders exactly one static frame on mount.
    expect(state.renderCalls).toBe(1);
    rerender(
      <ProgrammableShaderBackground
        source={SOURCE_A}
        uniforms={{ ...DEFAULT_SHADER_UNIFORMS, u_seed: 42 }}
        color="#ffffff"
      />,
    );
    // No rebuild — one extra repaint at the new frozen seed phase.
    expect(state.rendererCount).toBe(1);
    expect(state.renderCalls).toBe(2);
    expect(state.uniformSets[0].u_seed.value).toBe(42);
    expect(state.uniformSets[0].u_time.value).toBe(42);
  });
});
