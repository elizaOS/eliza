/**
 * Unit coverage for the `nebula` voice-orb concept builder. Drives the real
 * `concept.build` against the real `three/webgpu` classes (headless-safe: no
 * GPU device or DOM is touched) and asserts the observable scene-graph
 * contract: dust/star/core point-cloud construction with fixed vertex counts,
 * radius bounds invariant under the build's RNG, material blending/opacity
 * contracts, the differential galactic tilt, frame state driven by
 * time/energy/respond including the twinkle accumulator and magenta flush,
 * and full resource teardown.
 */
import * as THREE from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import type { OrbFrame, OrbUniforms } from "../orb-kit.ts";
import { concept } from "./nebula.ts";

/** Same loose boundary type orb-kit uses for the injected renderer module. */
type WebGPU = Record<string, any>;

const THREE_WEBGPU = THREE as unknown as WebGPU;

const NO_UNIFORMS = {} as OrbUniforms;

function frame(time: number, energy: number, respond: number): OrbFrame {
  return { time, energy, low: 0, listen: 0, respond };
}

function buildNebula(): {
  parent: any;
  handle: { frame: (f: OrbFrame) => void; dispose: () => void };
  dust: any;
  stars: any;
  core: any;
} {
  const parent = new THREE_WEBGPU.Group();
  const handle = concept.build(THREE_WEBGPU, {}, NO_UNIFORMS, parent);
  // Build order is fixed by the concept: dust cloud, stars, core.
  const dust = parent.children[0];
  const stars = parent.children[1];
  const core = parent.children[2];
  return { parent, handle, dust, stars, core };
}

describe("nebula concept descriptor", () => {
  it("registers under id 'nebula' in the abstract family with a callable builder", () => {
    expect(concept.id).toBe("nebula");
    expect(concept.label).toBe("nebula");
    expect(concept.family).toBe("abstract");
    expect(typeof concept.build).toBe("function");
  });
});

describe("nebula build", () => {
  it("adds exactly three Points children to the parent, none frustum-culled", () => {
    const { parent, dust, stars, core } = buildNebula();
    expect(parent.children.length).toBe(3);
    expect(dust).toBeInstanceOf(THREE_WEBGPU.Points);
    expect(stars).toBeInstanceOf(THREE_WEBGPU.Points);
    expect(core).toBeInstanceOf(THREE_WEBGPU.Points);
    for (const points of [dust, stars, core]) {
      expect(points.frustumCulled).toBe(false);
    }
  });

  it("builds a 680-point dust cloud whose vertices carry per-point colors", () => {
    const { dust } = buildNebula();
    const pos = dust.geometry.attributes.position;
    const col = dust.geometry.attributes.color;
    expect(pos.count).toBe(680);
    expect(col.count).toBe(680);
    expect(pos.itemSize).toBe(3);
    expect(col.itemSize).toBe(3);
  });

  it("clusters dust inside the max build radius of 1.28", () => {
    const { dust } = buildNebula();
    const pos = dust.geometry.attributes.position as any;
    let maxRadius = 0;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      maxRadius = Math.max(maxRadius, r);
      expect(r).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(maxRadius).toBeLessThanOrEqual(1.28 + 1e-9);
  });

  it("keeps every dust color channel within [0, 1]", () => {
    const { dust } = buildNebula();
    const col = dust.geometry.attributes.color as any;
    for (let i = 0; i < col.count; i++) {
      for (const c of [col.getX(i), col.getY(i), col.getZ(i)]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it("builds exactly 44 star points without a color attribute", () => {
    const { stars } = buildNebula();
    expect(stars.geometry.attributes.position.count).toBe(44);
    expect(stars.geometry.attributes.color).toBeUndefined();
  });

  it("scatters stars between radius 0.08 and 1.26", () => {
    const { stars } = buildNebula();
    const pos = stars.geometry.attributes.position as any;
    let minRadius = Number.POSITIVE_INFINITY;
    let maxRadius = 0;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      minRadius = Math.min(minRadius, r);
      maxRadius = Math.max(maxRadius, r);
    }
    expect(minRadius).toBeGreaterThanOrEqual(0.08 - 1e-9);
    expect(maxRadius).toBeLessThanOrEqual(1.26 + 1e-9);
  });

  it("anchors the core with 3 points hugging the origin", () => {
    const { core } = buildNebula();
    const pos = core.geometry.attributes.position as any;
    expect(pos.count).toBe(3);
    for (let i = 0; i < pos.count; i++) {
      expect(Math.abs(pos.getX(i))).toBeLessThanOrEqual(0.01 + 1e-12);
      expect(Math.abs(pos.getY(i))).toBeLessThanOrEqual(0.01 + 1e-12);
      expect(Math.abs(pos.getZ(i))).toBeLessThanOrEqual(0.01 + 1e-12);
    }
  });

  it("gives all three clouds their own transparent, depth-write-off normal-blended PointsNodeMaterial", () => {
    const { dust, stars, core } = buildNebula();
    for (const points of [dust, stars, core]) {
      const mat = points.material as any;
      expect(mat).toBeInstanceOf(THREE_WEBGPU.PointsNodeMaterial);
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      // Deliberately NOT additive: additive dust vanishes into the bright sky.
      expect(mat.blending).toBe(THREE_WEBGPU.NormalBlending);
      expect(mat.blending).not.toBe(THREE_WEBGPU.AdditiveBlending);
    }
  });

  it("applies the documented per-cloud material constants", () => {
    const { dust, stars, core } = buildNebula();
    const dustMat = dust.material as any;
    const starMat = stars.material as any;
    const coreMat = core.material as any;
    expect(dustMat.vertexColors).toBe(true);
    expect(dustMat.size).toBeCloseTo(0.075, 12);
    expect(dustMat.sizeAttenuation).toBe(true);
    expect(dustMat.opacity).toBeCloseTo(0.92, 12);
    expect(starMat.color.r).toBeCloseTo(1.0, 12);
    expect(starMat.color.g).toBeCloseTo(0.52, 12);
    expect(starMat.color.b).toBeCloseTo(0.86, 12);
    expect(starMat.size).toBeCloseTo(0.055, 12);
    expect(starMat.opacity).toBeCloseTo(0.9, 12);
    expect(coreMat.color.r).toBeCloseTo(0.42, 12);
    expect(coreMat.color.g).toBeCloseTo(0.16, 12);
    expect(coreMat.color.b).toBeCloseTo(0.78, 12);
    expect(coreMat.size).toBeCloseTo(0.42, 12);
    expect(coreMat.opacity).toBeCloseTo(0.5, 12);
  });

  it("tilts the dust plane more than the star plane for galactic depth", () => {
    const { dust, stars, core } = buildNebula();
    expect(dust.rotation.x).toBeCloseTo(0.22, 12);
    expect(stars.rotation.x).toBeCloseTo(0.18, 12);
    expect(core.rotation.x).toBe(0);
  });
});

describe("nebula frame", () => {
  it("overwrites stale material state with the idle pose at zero time, energy and respond", () => {
    const { handle, dust, stars, core } = buildNebula();
    const dustMat = dust.material as any;
    const starMat = stars.material as any;
    dustMat.opacity = -1; // sentinels: frame must overwrite both
    starMat.opacity = -1;
    handle.frame(frame(0, 0, 0));
    expect(dust.rotation.y).toBe(0);
    expect(stars.rotation.y).toBe(0);
    expect(core.rotation.y).toBe(0);
    expect(dust.rotation.z).toBeCloseTo(0, 12);
    expect(stars.rotation.z).toBeCloseTo(Math.cos(0) * 0.05, 12);
    expect(dust.scale.x).toBeCloseTo(1, 12);
    expect(stars.scale.x).toBeCloseTo(0.98, 12);
    expect(dustMat.opacity).toBeCloseTo(0.62, 12);
    // Twinkle phase advances BEFORE the formula runs, so the very first
    // painted frame already samples phase 0.09 (observed), scaled by the
    // idle respond/energy factor of 0.7.
    expect(starMat.opacity).toBeCloseTo(
      (0.72 + Math.sin(0.09 * 2.3) * 0.18 + Math.cos(0.09 * 3.7) * 0.08) * 0.7,
      12,
    );
    // Neutral tint when not responding.
    expect(dustMat.color.r).toBeCloseTo(1, 12);
    expect(dustMat.color.g).toBeCloseTo(1, 12);
    expect(dustMat.color.b).toBeCloseTo(1, 12);
    expect(core.material.opacity).toBeCloseTo(0.22, 12);
    expect((core.material as any).size).toBeCloseTo(0.38, 12);
  });

  it("swirls each layer at its own multiple of the shared speed", () => {
    const { handle, dust, stars, core } = buildNebula();
    handle.frame(frame(2, 0, 0));
    const speed = 0.055;
    expect(dust.rotation.y).toBeCloseTo(2 * speed, 12);
    expect(stars.rotation.y).toBeCloseTo(2 * speed * 0.65, 12);
    expect(core.rotation.y).toBeCloseTo(2 * speed * 1.1, 12);
  });

  it("boosts swirl speed with energy", () => {
    const { handle, dust } = buildNebula();
    handle.frame(frame(1, 1, 0));
    expect(dust.rotation.y).toBeCloseTo(0.055 + 1 * 0.18, 12);
  });

  it("drifts the planes on z with slow out-of-phase oscillations", () => {
    const { handle, dust, stars } = buildNebula();
    handle.frame(frame(3, 0, 0));
    expect(dust.rotation.z).toBeCloseTo(Math.sin(3 * 0.07) * 0.06, 12);
    expect(stars.rotation.z).toBeCloseTo(Math.cos(3 * 0.05) * 0.05, 12);
  });

  it("breathes the whole cloud outward on respond plus energy", () => {
    const { handle, dust, stars } = buildNebula();
    handle.frame(frame(0, 1, 1));
    expect(dust.scale.x).toBeCloseTo(1 + 1 * 0.12 + 1 * 0.06, 12);
    expect(stars.scale.x).toBeCloseTo(0.98 + 1 * 0.1 + 1 * 0.04, 12);
  });

  it("pulses dust opacity above its idle base with energy and respond", () => {
    const { handle, dust } = buildNebula();
    handle.frame(frame(0, 1, 1));
    // Observed behaviour: the formula is unclamped, so full energy+respond
    // lands slightly above 1 rather than saturating.
    expect(dust.material.opacity).toBeCloseTo(0.62 + 0.32 + 0.08, 12);
  });

  it("flushes the dust tint toward magenta in proportion to respond", () => {
    const { handle, dust } = buildNebula();
    handle.frame(frame(0, 0, 1));
    expect(dust.material.color.r).toBeCloseTo(1.35, 12);
    expect(dust.material.color.g).toBeCloseTo(0.72, 12);
    expect(dust.material.color.b).toBeCloseTo(1.18, 12);
    handle.frame(frame(0, 0, 0.5));
    expect(dust.material.color.r).toBeCloseTo(1.175, 12);
    expect(dust.material.color.g).toBeCloseTo(0.86, 12);
    expect(dust.material.color.b).toBeCloseTo(1.09, 12);
  });

  it("advances the twinkle accumulator across frames instead of resetting it", () => {
    const { handle, stars } = buildNebula();
    const starMat = stars.material as any;
    handle.frame(frame(0, 0, 0));
    const first = starMat.opacity;
    handle.frame(frame(0, 0, 0));
    // Phase advances before each paint: the two calls sample 0.09 then 0.18;
    // multiplier stays 0.7.
    const twinkleAtPhase = (phase: number) =>
      (0.72 + Math.sin(phase * 2.3) * 0.18 + Math.cos(phase * 3.7) * 0.08) *
      0.7;
    expect(first).toBeCloseTo(twinkleAtPhase(0.09), 12);
    expect(starMat.opacity).toBeCloseTo(twinkleAtPhase(0.18), 12);
  });

  it("pulses the core's opacity and size on energy and respond", () => {
    const { handle, core } = buildNebula();
    handle.frame(frame(0, 1, 1));
    expect(core.material.opacity).toBeCloseTo(0.22 + 0.28 + 0.22, 12);
    expect((core.material as any).size).toBeCloseTo(0.38 + 0.18 + 0.12, 12);
  });
});

describe("nebula dispose", () => {
  it("disposes all three geometries and materials and removes all three clouds from the parent", () => {
    const { parent, handle, dust, stars, core } = buildNebula();
    const resources = [
      dust.geometry,
      dust.material,
      stars.geometry,
      stars.material,
      core.geometry,
      core.material,
    ];
    const spies = resources.map((r) => vi.spyOn(r, "dispose"));
    handle.dispose();
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(parent.children.length).toBe(0);
  });
});
