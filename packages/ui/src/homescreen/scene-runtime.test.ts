import { describe, expect, it, vi } from "vitest";
import type {
  SceneInstance,
  SceneRenderContext,
} from "./scene-types";
import {
  compileSceneScript,
  createSceneInputs,
  getPreset,
  presetKeys,
  registerPreset,
  resolveSceneFactory,
  resolveSceneFactoryOrDefault,
} from "./scene-runtime";
import { BUILTIN_PRESETS } from "./scene-types";

function fakeCtx(): SceneRenderContext {
  return {
    three: {},
    scene: {},
    camera: {},
    renderer: {},
    size: { width: 800, height: 600, dpr: 1 },
    theme: { accent: [1, 0.345, 0], background: 0xff5800 },
    inputs: createSceneInputs(),
  };
}

function noopInstance(): SceneInstance {
  return { update: () => {}, dispose: () => {} };
}

describe("preset registry", () => {
  it("registers and resolves a preset factory", () => {
    const factory = vi.fn(() => noopInstance());
    registerPreset("test-orb", factory);
    expect(getPreset("test-orb")).toBe(factory);
    expect(presetKeys()).toContain("test-orb");

    const resolved = resolveSceneFactory({ kind: "preset", preset: "test-orb" });
    expect(resolved.ok).toBe(true);
  });

  it("fails to resolve an unknown preset", () => {
    const resolved = resolveSceneFactory({
      kind: "preset",
      preset: "does-not-exist-xyz",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toMatch(/unknown preset/);
  });
});

describe("compileSceneScript", () => {
  it("compiles a valid body returning a SceneInstance", () => {
    const result = compileSceneScript(
      "return { update() {}, dispose() {} };",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const instance = result.factory(fakeCtx());
    expect(typeof instance.update).toBe("function");
    expect(typeof instance.dispose).toBe("function");
  });

  it("rejects an empty body", () => {
    expect(compileSceneScript("   ").ok).toBe(false);
  });

  it("returns (not throws) a syntax error", () => {
    const result = compileSceneScript("return {{{ broken");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("throws at run time when the body returns a non-instance", () => {
    const result = compileSceneScript("return 123;");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => result.factory(fakeCtx())).toThrow(/SceneInstance/);
  });

  it("shadows dangerous globals to undefined inside the body", () => {
    const result = compileSceneScript(
      "return { update() {}, dispose() {}, _w: typeof window, _f: typeof fetch };",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const instance = result.factory(fakeCtx()) as SceneInstance & {
      _w: string;
      _f: string;
    };
    expect(instance._w).toBe("undefined");
    expect(instance._f).toBe("undefined");
  });

  it("passes ctx through to the body", () => {
    const result = compileSceneScript(
      "return { update() {}, dispose() {}, dpr: ctx.size.dpr };",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ctx = fakeCtx();
    ctx.size.dpr = 2;
    const instance = result.factory(ctx) as SceneInstance & { dpr: number };
    expect(instance.dpr).toBe(2);
  });
});

describe("resolveSceneFactoryOrDefault", () => {
  it("falls back to the default preset when the script fails to compile", () => {
    // The default preset must be registered for the fallback to succeed.
    registerPreset(BUILTIN_PRESETS.fresnelCrystalBall, () => noopInstance());
    const { factory, error } = resolveSceneFactoryOrDefault({
      kind: "script",
      code: "syntax ((( error",
    });
    expect(error).toBeTruthy();
    expect(factory).not.toBeNull();
  });

  it("returns no error when the background resolves directly", () => {
    registerPreset("test-direct", () => noopInstance());
    const { factory, error } = resolveSceneFactoryOrDefault({
      kind: "preset",
      preset: "test-direct",
    });
    expect(error).toBeNull();
    expect(factory).not.toBeNull();
  });
});

describe("createSceneInputs", () => {
  it("produces a zeroed, idle input object", () => {
    const inputs = createSceneInputs();
    expect(inputs.energy).toBe(0);
    expect(inputs.phase).toBe("idle");
    expect(inputs.bands).toEqual({ low: 0, mid: 0, high: 0 });
    expect(inputs.pointer).toEqual({ x: 0, y: 0, down: false });
  });
});
