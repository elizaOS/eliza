/**
 * Unit coverage for the `origami` voice-orb concept builder. Drives the real
 * `concept.build` against the real `three/webgpu` classes (headless-safe: no
 * GPU device or DOM is touched) and asserts the observable scene-graph
 * contract: two counter-posed tetrahedra under per-solid pivots, flat paper
 * materials, charcoal crease lines parented to their solids, frame state
 * driven by time/energy/respond including the respond-clamped crease flare,
 * and full resource teardown. Fully deterministic — no clock, no RNG.
 */
import * as THREE from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import type { OrbFrame, OrbUniforms } from "../orb-kit.ts";
import { concept } from "./origami.ts";

/** Same loose boundary type orb-kit uses for the injected renderer module. */
type WebGPU = Record<string, any>;

const THREE_WEBGPU = THREE as unknown as WebGPU;

const NO_UNIFORMS = {} as OrbUniforms;

function frame(time: number, energy: number, respond: number): OrbFrame {
  return { time, energy, low: 0, listen: 0, respond };
}

function buildOrigami(): {
  parent: any;
  handle: { frame: (f: OrbFrame) => void; dispose: () => void };
  pivotA: any;
  pivotB: any;
  meshA: any;
  meshB: any;
} {
  const parent = new THREE_WEBGPU.Group();
  const handle = concept.build(THREE_WEBGPU, {}, NO_UNIFORMS, parent);
  // Build order is fixed by the concept: upright solid first, inverted second.
  const pivotA = parent.children[0];
  const pivotB = parent.children[1];
  const meshA = pivotA.children[0];
  const meshB = pivotB.children[0];
  return { parent, handle, pivotA, pivotB, meshA, meshB };
}

function creaseLinesOf(mesh: any): any {
  return mesh.children[0];
}

/** Largest vertex distance from the origin — the tetrahedron's build radius. */
function maxVertexRadius(geometry: any): number {
  const pos = geometry.attributes.position;
  let max = 0;
  for (let i = 0; i < pos.count; i++) {
    max = Math.max(max, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return max;
}

describe("origami concept descriptor", () => {
  it("registers under id 'origami' in the artful family with a callable builder", () => {
    expect(concept.id).toBe("origami");
    expect(concept.label).toBe("origami");
    expect(concept.family).toBe("artful");
    expect(typeof concept.build).toBe("function");
  });
});

describe("origami build", () => {
  it("adds exactly two pivot groups to the parent, each wrapping a single tetrahedron mesh", () => {
    const { parent, pivotA, pivotB, meshA, meshB } = buildOrigami();
    expect(parent.children.length).toBe(2);
    expect(pivotA).toBeInstanceOf(THREE_WEBGPU.Group);
    expect(pivotB).toBeInstanceOf(THREE_WEBGPU.Group);
    expect(pivotA.children.length).toBe(1);
    expect(pivotB.children.length).toBe(1);
    expect(meshA).toBeInstanceOf(THREE_WEBGPU.Mesh);
    expect(meshB).toBeInstanceOf(THREE_WEBGPU.Mesh);
  });

  it("builds an upright tetrahedron of radius 0.9 and a smaller inverted one of radius 0.78", () => {
    const { meshA, meshB } = buildOrigami();
    // Polyhedron vertices normalize onto the sphere with ~1e-8 float slack.
    expect(maxVertexRadius(meshA.geometry)).toBeCloseTo(0.9, 6);
    expect(maxVertexRadius(meshB.geometry)).toBeCloseTo(0.78, 6);
    // The inner solid nests point-down inside the upright one via the flip.
    expect(meshA.rotation.x).toBe(0);
    expect(meshB.rotation.x).toBe(Math.PI);
  });

  it("gives both solids independent flat-shaded paper materials with the documented constants", () => {
    const { meshA, meshB } = buildOrigami();
    const matA = meshA.material;
    const matB = meshB.material;
    expect(matA).toBeInstanceOf(THREE_WEBGPU.MeshStandardNodeMaterial);
    expect(matB).toBeInstanceOf(THREE_WEBGPU.MeshStandardNodeMaterial);
    expect(matA).not.toBe(matB);
    for (const mat of [matA, matB]) {
      expect(mat.flatShading).toBe(true);
      expect(mat.roughness).toBeCloseTo(0.86, 12);
      expect(mat.metalness).toBe(0);
      expect(mat.transparent).toBe(false);
    }
    // Outer shell paper-white; inner solid warmed ever so slightly toward ivory.
    expect(matA.color.r).toBeCloseTo(0.97, 12);
    expect(matA.color.g).toBeCloseTo(0.95, 12);
    expect(matA.color.b).toBeCloseTo(0.91, 12);
    expect(matB.color.r).toBeCloseTo(0.99, 12);
    expect(matB.color.g).toBeCloseTo(0.96, 12);
    expect(matB.color.b).toBeCloseTo(0.9, 12);
  });

  it("parents charcoal crease LineSegments to each solid so they inherit its transform", () => {
    const { meshA, meshB } = buildOrigami();
    const linesA = creaseLinesOf(meshA);
    const linesB = creaseLinesOf(meshB);
    expect(linesA).toBeInstanceOf(THREE_WEBGPU.LineSegments);
    expect(linesB).toBeInstanceOf(THREE_WEBGPU.LineSegments);
    expect(linesA.parent).toBe(meshA);
    expect(linesB.parent).toBe(meshB);
    // Six tetrahedron edges come out as six start/end vertex pairs.
    expect(linesA.geometry.attributes.position.count).toBe(12);
    expect(linesA.geometry).not.toBe(meshA.geometry);
    expect(linesB.geometry).not.toBe(meshB.geometry);
    for (const lines of [linesA, linesB]) {
      const mat = lines.material;
      expect(mat).toBeInstanceOf(THREE_WEBGPU.LineBasicNodeMaterial);
      expect(mat.transparent).toBe(true);
      expect(mat.opacity).toBeCloseTo(0.9, 12);
      expect(mat.color.r).toBeCloseTo(0.14, 12);
      expect(mat.color.g).toBeCloseTo(0.12, 12);
      expect(mat.color.b).toBeCloseTo(0.1, 12);
    }
  });
});

describe("origami frame", () => {
  it("overwrites stale material state with the idle pose at zero time, energy and respond", () => {
    const { handle, pivotA, pivotB, meshA, meshB } = buildOrigami();
    const matA = meshA.material;
    const matB = meshB.material;
    const creaseMatA = creaseLinesOf(meshA).material;
    matA.emissiveIntensity = -1; // sentinels: frame must overwrite all three
    matB.emissiveIntensity = -1;
    creaseMatA.color.setRGB(9, 9, 9);
    handle.frame(frame(0, 0, 0));
    // No breathe at t=0; only the fixed 0.4 unfold phase offset remains.
    expect(pivotA.scale.x).toBeCloseTo(1, 12);
    expect(pivotB.scale.x).toBeCloseTo(1, 12);
    expect(pivotA.rotation.y).toBeCloseTo(Math.sin(0.4) * 0.08, 12);
    expect(pivotB.rotation.y).toBeCloseTo(-Math.sin(0.4) * 0.08 * 0.6, 12);
    expect(matA.emissiveIntensity).toBe(0);
    expect(matB.emissiveIntensity).toBe(0);
    expect(creaseMatA.color.r).toBeCloseTo(0.14, 12);
    expect(creaseMatA.color.g).toBeCloseTo(0.12, 12);
    expect(creaseMatA.color.b).toBeCloseTo(0.1, 12);
  });

  it("counter-rotates the two solids around Y with opposite base speeds plus the shared unfold wobble", () => {
    const { handle, pivotA, pivotB } = buildOrigami();
    handle.frame(frame(2, 0, 0));
    const unfold = Math.sin(2 * 0.55 + 0.4) * 0.08;
    expect(pivotA.rotation.y).toBeCloseTo(2 * 0.09 + unfold, 12);
    expect(pivotB.rotation.y).toBeCloseTo(-2 * 0.07 - unfold * 0.6, 12);
    expect(pivotA.rotation.y).toBeGreaterThan(0);
    expect(pivotB.rotation.y).toBeLessThan(0);
  });

  it("wobbles each solid on X with its own slow out-of-phase oscillation around the inversion flip", () => {
    const { handle, pivotA, pivotB } = buildOrigami();
    handle.frame(frame(3, 0, 0));
    expect(pivotA.rotation.x).toBeCloseTo(Math.sin(3 * 0.32) * 0.06, 12);
    expect(pivotB.rotation.x).toBeCloseTo(
      Math.PI + Math.sin(3 * 0.28 + 1.1) * 0.05,
      12,
    );
  });

  it("breathes the inner solid at 0.7x the outer amplitude while idle", () => {
    const { handle, pivotA, pivotB } = buildOrigami();
    handle.frame(frame(1, 0, 0));
    const breathe = Math.sin(0.8) * 0.06;
    expect(pivotA.scale.x).toBeCloseTo(1 + breathe, 12);
    expect(pivotB.scale.x).toBeCloseTo(1 - breathe * 0.7, 12);
  });

  it("widens the breathe and adds a direct respond opening on top", () => {
    const { handle, pivotA, pivotB } = buildOrigami();
    handle.frame(frame(1, 0, 1));
    const breathe = Math.sin(0.8) * (0.06 + 0.14);
    expect(pivotA.scale.x).toBeCloseTo(1 + breathe + 0.06, 12);
    expect(pivotB.scale.x).toBeCloseTo(1 - breathe * 0.7 + 0.04, 12);
    expect(pivotA.scale.x).toBeGreaterThan(pivotB.scale.x);
  });

  it("flares the emissive edge catch with energy and respond, dimmer on the inner solid", () => {
    const { handle, meshA, meshB } = buildOrigami();
    handle.frame(frame(0, 1, 1));
    const ei = 1 * 0.35 + 1 * 0.12;
    const matA = meshA.material;
    const matB = meshB.material;
    expect(matA.emissiveIntensity).toBeCloseTo(ei, 12);
    expect(matB.emissiveIntensity).toBeCloseTo(ei * 0.7, 12);
    // Both share the warm white edge colour.
    for (const mat of [matA, matB]) {
      expect(mat.emissive.r).toBeCloseTo(1.0, 12);
      expect(mat.emissive.g).toBeCloseTo(0.97, 12);
      expect(mat.emissive.b).toBeCloseTo(0.88, 12);
    }
  });

  it("ramps crease lines from charcoal toward the accent in proportion to respond", () => {
    const { handle, meshA, meshB } = buildOrigami();
    handle.frame(frame(0, 0, 0.5));
    for (const lines of [creaseLinesOf(meshA), creaseLinesOf(meshB)]) {
      const c = lines.material.color;
      expect(c.r).toBeCloseTo(0.14 + 0.86 * 0.5, 12);
      expect(c.g).toBeCloseTo(0.12 + 0.22 * 0.5, 12);
      expect(c.b).toBeCloseTo(0.1 - 0.1 * 0.5, 12);
    }
  });

  it("clamps the crease flare at full respond so over-range respond cannot overshoot the accent", () => {
    const { handle, meshA, meshB } = buildOrigami();
    handle.frame(frame(0, 0, 1));
    const clamped = [creaseLinesOf(meshA), creaseLinesOf(meshB)].map(
      (lines) => [
        lines.material.color.r,
        lines.material.color.g,
        lines.material.color.b,
      ],
    );
    for (const [r, g, b] of clamped) {
      expect(r).toBeCloseTo(1.0, 12);
      expect(g).toBeCloseTo(0.34, 12);
      expect(b).toBeCloseTo(0.0, 12);
    }
    // respond=2 saturates the min() instead of pushing past the accent hue.
    handle.frame(frame(0, 0, 2));
    const overshot = [creaseLinesOf(meshA), creaseLinesOf(meshB)].map(
      (lines) => [
        lines.material.color.r,
        lines.material.color.g,
        lines.material.color.b,
      ],
    );
    expect(overshot).toEqual(clamped);
  });
});

describe("origami dispose", () => {
  it("disposes both tetrahedron geometry/material pairs plus both crease pairs and removes both pivots from the parent", () => {
    const { parent, handle, meshA, meshB } = buildOrigami();
    const linesA = creaseLinesOf(meshA);
    const linesB = creaseLinesOf(meshB);
    const resources = [
      meshA.geometry,
      meshA.material,
      meshB.geometry,
      meshB.material,
      linesA.geometry,
      linesA.material,
      linesB.geometry,
      linesB.material,
    ];
    const spies = resources.map((r) => vi.spyOn(r, "dispose"));
    handle.dispose();
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(parent.children.length).toBe(0);
  });
});
