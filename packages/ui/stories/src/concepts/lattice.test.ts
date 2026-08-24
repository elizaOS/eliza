/**
 * Unit coverage for the `lattice` voice-orb concept builder. Drives the real
 * `concept.build` against the real `three/webgpu` classes (headless-safe: no
 * GPU device or DOM is touched) and asserts the observable scene-graph
 * contract: cage + instanced-node construction, unique-vertex deduplication,
 * initial instance placement, frame state driven by time/energy/respond,
 * pulse-wave instance scaling bounds, and full resource teardown. Fully
 * deterministic — no clock, no RNG.
 */
import * as THREE from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import type { OrbFrame, OrbUniforms } from "../orb-kit.ts";
import { concept } from "./lattice.ts";

/** Same loose boundary type orb-kit uses for the injected renderer module. */
type WebGPU = Record<string, any>;

const THREE_WEBGPU = THREE as unknown as WebGPU;

const NO_UNIFORMS = {} as OrbUniforms;

function frame(time: number, energy: number, respond: number): OrbFrame {
  return { time, energy, low: 0, listen: 0, respond };
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function newMatrix(): any {
  return new THREE_WEBGPU.Matrix4();
}

function positionOf(m: any): Vec3 {
  return { x: m.elements[12], y: m.elements[13], z: m.elements[14] };
}

function buildLattice(): {
  parent: any;
  handle: { frame: (f: OrbFrame) => void; dispose: () => void };
  struts: any;
  nodes: any;
} {
  const parent = new THREE_WEBGPU.Group();
  const handle = concept.build(THREE_WEBGPU, {}, NO_UNIFORMS, parent);
  // Build order is fixed by the concept: struts first, nodes second.
  const struts = parent.children[0];
  const nodes = parent.children[1];
  return { parent, handle, struts, nodes };
}

/** Uniform instance scale encoded on a matrix built by Object3D.setScalar. */
function instanceScale(m: any): number {
  return m.elements[0];
}

describe("lattice concept descriptor", () => {
  it("registers under id 'lattice' in the geometric family with a callable builder", () => {
    expect(concept.id).toBe("lattice");
    expect(concept.label).toBe("lattice");
    expect(concept.family).toBe("geometric");
    expect(typeof concept.build).toBe("function");
  });
});

describe("lattice build", () => {
  it("adds exactly two children to the parent: a strut LineSegments cage and an InstancedMesh of nodes", () => {
    const { parent, struts, nodes } = buildLattice();
    expect(parent.children.length).toBe(2);
    expect(struts).toBeInstanceOf(THREE_WEBGPU.LineSegments);
    expect(nodes).toBeInstanceOf(THREE_WEBGPU.InstancedMesh);

    const strutGeo = struts.geometry as any;
    const cageVerts = strutGeo.attributes.position.count;
    // The cage is a wireframe: edges come in start/end pairs.
    expect(cageVerts % 2).toBe(0);
  });

  it("instances one node per unique icosa vertex, far fewer than the raw face vertices", () => {
    const { struts, nodes } = buildLattice();
    // Observed on three 0.184: IcosahedronGeometry(1, 2) carries 540
    // non-indexed face vertices which collapse to 92 unique positions under
    // the concept's 4-decimal-place keying.
    const rawVerts = (new THREE_WEBGPU.IcosahedronGeometry(1, 2) as any)
      .attributes.position.count;
    expect(rawVerts).toBeGreaterThan(nodes.count);
    expect(nodes.count).toBe(92);
    // The strut cage geometry is independent of the node instances.
    expect(struts.geometry).not.toBe(nodes.geometry);
  });

  it("places each node instance on the unit sphere exactly once, with unit initial scale", () => {
    const { nodes } = buildLattice();
    const m = newMatrix();
    const seen = new Set<string>();
    let minRadius = Number.POSITIVE_INFINITY;
    let maxRadius = 0;
    for (let i = 0; i < nodes.count; i++) {
      nodes.getMatrixAt(i, m);
      const p = positionOf(m);
      const radius = Math.hypot(p.x, p.y, p.z);
      minRadius = Math.min(minRadius, radius);
      maxRadius = Math.max(maxRadius, radius);
      seen.add(`${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`);
      expect(instanceScale(m)).toBeCloseTo(1, 9);
    }
    // Every node sits on the cage surface (radius 1 ± 4dp rounding slack).
    expect(minRadius).toBeGreaterThan(0.999);
    expect(maxRadius).toBeLessThan(1.001);
    // No duplicate placements: one instance per unique vertex.
    expect(seen.size).toBe(nodes.count);
  });
});

describe("lattice frame", () => {
  it("holds the idle pose at zero time, energy and respond", () => {
    const { handle, struts, nodes } = buildLattice();
    (nodes.material as any).emissiveIntensity = -1; // sentinel: frame must overwrite
    handle.frame(frame(0, 0, 0));
    const strutMat = struts.material as any;
    const nodeMat = nodes.material as any;
    expect(struts.rotation.y).toBe(0);
    expect(struts.rotation.x).toBe(0);
    expect(struts.scale.x).toBeCloseTo(1, 12);
    expect(nodeMat.emissiveIntensity).toBeCloseTo(1.2, 12);
    // Cool cyan base, dimmed to idle brightness 0.55.
    expect(strutMat.color.r).toBeCloseTo(0.3025, 9);
    expect(strutMat.color.g).toBeCloseTo(0.484, 9);
    expect(strutMat.color.b).toBeCloseTo(0.55, 9);
    expect(nodeMat.emissive.r).toBeCloseTo(0.4, 9);
    expect(nodeMat.emissive.g).toBeCloseTo(0.9, 9);
    expect(nodeMat.emissive.b).toBeCloseTo(1.0, 9);
  });

  it("rotates forward with time at the idle speed", () => {
    const { handle, struts, nodes } = buildLattice();
    handle.frame(frame(2, 0, 0));
    expect(struts.rotation.y).toBeCloseTo(0.12, 12);
    expect(struts.rotation.x).toBeCloseTo(Math.sin(2 * 0.09) * 0.14, 12);
    // Nodes share the cage orientation.
    expect(nodes.rotation.y).toBeCloseTo(0.12, 12);
  });

  it("speeds rotation, breathes the whole frame and lerps colours toward orange on respond", () => {
    const { handle, struts, nodes } = buildLattice();
    handle.frame(frame(1, 1, 1));
    const strutMat = struts.material as any;
    const nodeMat = nodes.material as any;
    // Rotation speed rises from 0.06 to 0.18 rad/s.
    expect(struts.rotation.y).toBeCloseTo(0.18, 12);
    // Breathing scale: 1 + 0.12 respond + 0.04 energy.
    expect(struts.scale.x).toBeCloseTo(1.16, 12);
    expect(nodes.scale.x).toBeCloseTo(1.16, 12);
    // Strut colour reaches the accent hue at full brightness 1.55.
    expect(strutMat.color.r).toBeCloseTo(1.55, 9);
    expect(strutMat.color.g).toBeCloseTo(0.34 * 1.55, 9);
    expect(strutMat.color.b).toBeCloseTo(0, 9);
    // Opacity hits the hard ceiling at this energy+respond combination.
    expect(strutMat.opacity).toBe(1);
    // Node emissive follows the same accent lerp.
    expect(nodeMat.emissive.r).toBeCloseTo(1.0, 9);
    expect(nodeMat.emissive.g).toBeCloseTo(0.34, 9);
    expect(nodeMat.emissive.b).toBeCloseTo(0, 9);
    expect(nodeMat.emissiveIntensity).toBeCloseTo(5.2, 12);
  });

  it("raises opacity, breathing and emissive intensity with energy alone, below the ceiling", () => {
    const { handle, struts, nodes } = buildLattice();
    handle.frame(frame(0, 1, 0));
    const strutMat = struts.material as any;
    expect(struts.rotation.y).toBe(0);
    expect(struts.scale.x).toBeCloseTo(1.04, 12);
    expect(strutMat.opacity).toBeCloseTo(0.85, 12);
    expect((nodes.material as any).emissiveIntensity).toBeCloseTo(3.7, 12);
  });

  it("oscillates every node instance between 0.7x and 1.3x scale across the pulse wave", () => {
    const { handle, nodes } = buildLattice();
    const m = newMatrix();
    let observedMin = Number.POSITIVE_INFINITY;
    let observedMax = 0;
    for (let t = 0; t <= 3; t += 0.11) {
      handle.frame(frame(t, 0, 0));
      for (let i = 0; i < nodes.count; i++) {
        nodes.getMatrixAt(i, m);
        const s = instanceScale(m);
        observedMin = Math.min(observedMin, s);
        observedMax = Math.max(observedMax, s);
        expect(s).toBeGreaterThanOrEqual(0.7 - 1e-9);
        expect(s).toBeLessThanOrEqual(1.3 + 1e-9);
      }
    }
    // The wave genuinely swings rather than freezing at a constant size.
    expect(observedMin).toBeLessThanOrEqual(0.72);
    expect(observedMax).toBeGreaterThanOrEqual(1.28);
  });
});

describe("lattice dispose", () => {
  it("disposes both geometries and both materials and removes both meshes from the parent", () => {
    const { parent, handle, struts, nodes } = buildLattice();
    const resources = [
      struts.geometry,
      struts.material,
      nodes.geometry,
      nodes.material,
    ];
    const spies = resources.map((r) => vi.spyOn(r, "dispose"));
    handle.dispose();
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(parent.children.length).toBe(0);
  });
});
