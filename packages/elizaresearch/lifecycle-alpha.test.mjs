/**
 * Executes the particle lifecycle helpers from the production page and pins
 * entrance handoff, post-resize initialization, and invisible reseeding.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadProductionLifecycle() {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/u)?.[1];
  if (!script) throw new Error("Production particle script was not found");

  const instrumented = script.replace(
    /\}\)\(\);\s*$/u,
    `globalThis.__lifecycle = {
      FADE_FRAMES,
      seedSteadyState,
      lifecycleAlpha,
      alphaLevel,
      alphaLevelOpacity,
    };\n})();`,
  );
  if (instrumented === script) {
    throw new Error("Production particle script could not be instrumented");
  }

  const noOp = () => {};
  const context = {
    console,
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: false }),
    addEventListener: noOp,
    cancelAnimationFrame: noOp,
    requestAnimationFrame: () => 1,
    devicePixelRatio: 1,
    Image: class {
      complete = false;
      naturalWidth = 0;
    },
  };
  const drawingContext = { setTransform: noOp };
  const header = { addEventListener: noOp };
  const canvas = {
    parentElement: header,
    clientWidth: 1200,
    clientHeight: 800,
    getContext: () => drawingContext,
    addEventListener: noOp,
  };
  context.document = {
    hidden: false,
    body: { addEventListener: noOp },
    addEventListener: noOp,
    getElementById: () => canvas,
  };
  context.globalThis = context;

  vm.runInNewContext(instrumented, context, { filename: "index.html" });
  return context.__lifecycle;
}

const lifecycle = loadProductionLifecycle();

function opacityFor(particle) {
  return lifecycle.alphaLevelOpacity(
    lifecycle.alphaLevel(lifecycle.lifecycleAlpha(particle.age, particle.life)),
  );
}

describe("elizaresearch particle lifecycle", () => {
  it("keeps the first steady-state draw opaque across initial lifetimes", () => {
    for (let life = 0; life < 100; life += 1) {
      const particle = { age: 0, life };
      lifecycle.seedSteadyState(particle);
      particle.age += 1;
      particle.life -= 1;
      expect(opacityFor(particle)).toBe(1);
    }
  });

  it("initializes particles created by a post-entrance resize as opaque", () => {
    const particle = { age: 0, life: 1 };
    lifecycle.seedSteadyState(particle);
    particle.age += 1;
    particle.life -= 1;
    expect(opacityFor(particle)).toBe(1);
  });

  it("preserves the original lifetime when it already clears the handoff", () => {
    const particle = { age: 0, life: 99 };
    lifecycle.seedSteadyState(particle);
    expect(particle).toEqual({ age: lifecycle.FADE_FRAMES, life: 99 });
  });

  it("renders a reseeded particle at true zero before it fades in", () => {
    expect(opacityFor({ age: 0, life: 300 })).toBe(0);
  });
});
