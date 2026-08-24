/**
 * Unit coverage for the neon orb concept (packages/ui/stories/src/concepts/neon.ts)
 * against a deterministic, in-memory WebGPU host stand-in. The real concept module
 * runs unmodified — the fake only records scene-graph wiring and state mutations,
 * so every assertion below exercises neon.ts's own math and lifecycle: registration
 * contract, halo/core draw ordering, audio-reactive rotation/scale/opacity, hue-cycle
 * gating at the respond threshold, and dispose-time resource release.
 */

import { describe, expect, it } from "vitest";
import { concept } from "../../stories/src/concepts/neon.ts";
import type {
  OrbFrame,
  OrbUniforms,
  VariantHandle,
} from "../../stories/src/orb-kit.ts";

// Palette constants as shipped in neon.ts — assertions compare against these
// observed baseline colours rather than restating literals inline everywhere.
const MAGENTA = { r: 1.0, g: 0.08, b: 0.72 };
const CYAN = { r: 0.0, g: 0.78, b: 0.95 };

class FakeColor {
  r: number;
  g: number;
  b: number;

  constructor(r = 0, g = 0, b = 0) {
    this.r = r;
    this.g = g;
    this.b = b;
  }

  setRGB(r: number, g: number, b: number): void {
    this.r = r;
    this.g = g;
    this.b = b;
  }
}

interface MaterialProps {
  color: FakeColor;
  transparent?: boolean;
  blending?: unknown;
}

class FakeGeometry {
  disposed = false;

  constructor(
    readonly kind: string,
    readonly args: unknown[],
  ) {}

  dispose(): void {
    this.disposed = true;
  }
}

class FakeMaterial {
  disposed = false;
  opacity = 1;
  depthWrite = true;
  transparent = false;
  blending: unknown = null;
  color: FakeColor;

  constructor(props: MaterialProps) {
    this.color = props.color;
    this.transparent = props.transparent === true;
    this.blending = props.blending ?? null;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeVector3 {
  x = 1;
  y = 1;
  z = 1;

  setScalar(v: number): void {
    this.x = v;
    this.y = v;
    this.z = v;
  }
}

class FakeLineSegments {
  renderOrder = 0;
  rotation = { x: 0, y: 0, z: 0 };
  scale = new FakeVector3();

  constructor(
    readonly geometry: FakeGeometry,
    readonly material: FakeMaterial,
  ) {}
}

class FakeParent {
  children: FakeLineSegments[] = [];

  add(child: FakeLineSegments): void {
    this.children.push(child);
  }

  remove(child: FakeLineSegments): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
  }
}

function makeHost() {
  const geometries: FakeGeometry[] = [];
  const materials: FakeMaterial[] = [];
  const lines: FakeLineSegments[] = [];

  // Scoped classes, not function expressions: neon.ts instantiates these with
  // `new`, and biome's arrow-function assist would rewrite bare function
  // expressions back into arrows (which cannot be constructed) on every
  // `biome check --write`.
  class HostTorusKnotGeometry extends FakeGeometry {
    constructor(...args: number[]) {
      super("torus-knot", args);
      geometries.push(this);
    }
  }

  class HostEdgesGeometry extends FakeGeometry {
    constructor(source: FakeGeometry) {
      super("edges", [source]);
      geometries.push(this);
    }
  }

  class HostLineBasicNodeMaterial extends FakeMaterial {
    constructor(props: MaterialProps) {
      super(props);
      materials.push(this);
    }
  }

  class HostLineSegments extends FakeLineSegments {
    constructor(geometry: FakeGeometry, material: FakeMaterial) {
      super(geometry, material);
      lines.push(this);
    }
  }

  const host = {
    NormalBlending: "normal-blending",
    Color: FakeColor,
    TorusKnotGeometry: HostTorusKnotGeometry,
    EdgesGeometry: HostEdgesGeometry,
    LineBasicNodeMaterial: HostLineBasicNodeMaterial,
    LineSegments: HostLineSegments,
  };

  return { host, geometries, materials, lines };
}

const uniforms: OrbUniforms = {
  uTime: null,
  uEnergy: null,
  uLow: null,
  uListen: null,
  uRespond: null,
  uAspect: null,
  uAccent: null,
};

function buildConcept() {
  const { host, geometries, materials, lines } = makeHost();
  const parent = new FakeParent();
  const handle = concept.build(host, {}, uniforms, parent);
  return { handle, parent, geometries, materials, lines, host };
}

function frameAt(handle: VariantHandle, over: Partial<OrbFrame> = {}): void {
  handle.frame({
    time: 0,
    energy: 0,
    low: 0,
    listen: 0,
    respond: 0,
    ...over,
  });
}

function snapshot(...lines: FakeLineSegments[]) {
  return lines.map((line) => ({
    rotation: { ...line.rotation },
    scale: { ...line.scale },
    opacity: line.material.opacity,
    color: {
      r: line.material.color.r,
      g: line.material.color.g,
      b: line.material.color.b,
    },
  }));
}

describe("concept: neon — torus-knot orb variant (fake WebGPU host)", () => {
  it("registers under the gallery contract with an abstract family", () => {
    expect(concept.id).toBe("neon");
    expect(concept.label).toBe("neon");
    expect(concept.family).toBe("abstract");
    expect(typeof concept.build).toBe("function");
  });

  it("adds halo behind core with correct draw order and material setup", () => {
    const { parent, lines } = buildConcept();

    // Creation order is core-first; parenting order puts halo first so it
    // renders behind the bright core at equal depth.
    const core = lines[0];
    const halo = lines[1];
    expect(parent.children).toEqual([halo, core]);

    expect(core.renderOrder).toBe(1);
    expect(halo.renderOrder).toBe(0);

    expect(core.material.color.r).toBeCloseTo(MAGENTA.r, 12);
    expect(core.material.color.g).toBeCloseTo(MAGENTA.g, 12);
    expect(core.material.color.b).toBeCloseTo(MAGENTA.b, 12);
    expect(halo.material.color.r).toBeCloseTo(CYAN.r, 12);
    expect(halo.material.color.g).toBeCloseTo(CYAN.g, 12);
    expect(halo.material.color.b).toBeCloseTo(CYAN.b, 12);

    for (const line of [core, halo]) {
      expect(line.material.transparent).toBe(true);
      expect(line.material.depthWrite).toBe(false);
      expect(line.material.blending).toBe("normal-blending");
    }

    expect(core.material.opacity).toBeCloseTo(0.95, 12);
    expect(halo.material.opacity).toBeCloseTo(0.5, 12);

    expect(core.scale.x).toBe(1);
    expect(halo.scale.x).toBeCloseTo(1.04, 12);
  });

  it("builds trefoil edge sets sharing one knot geometry", () => {
    const { geometries, lines } = buildConcept();

    expect(geometries.map((g) => g.kind)).toEqual([
      "torus-knot",
      "edges",
      "edges",
    ]);
    // p=2, q=3, tubular 128, radial 16, radius 0.68, tube 0.22 — the classic
    // trefoil parameters the concept documents.
    expect(geometries[0].args).toEqual([0.68, 0.22, 128, 16, 2, 3]);

    const knot = geometries[0];
    expect(lines[0].geometry.args[0]).toBe(knot);
    expect(lines[1].geometry.args[0]).toBe(knot);
    expect(lines[0].geometry).not.toBe(lines[1].geometry);
  });

  it("rotates both layers identically from time alone", () => {
    const { handle, lines } = buildConcept();
    const [core, halo] = lines;

    frameAt(handle, { time: 10 });

    const rotY = 10 * 0.14;
    const rotX = Math.sin(10 * 0.09) * 0.18;
    const rotZ = Math.cos(10 * 0.07) * 0.08;
    for (const line of [core, halo]) {
      expect(line.rotation.y).toBeCloseTo(rotY, 12);
      expect(line.rotation.x).toBeCloseTo(rotX, 12);
      expect(line.rotation.z).toBeCloseTo(rotZ, 12);
    }
  });

  it("couples beat scale to bass and preserves the halo offset", () => {
    const { handle, lines } = buildConcept();
    const [core, halo] = lines;

    frameAt(handle, {});
    expect(core.scale.x).toBeCloseTo(1.0, 12);
    expect(halo.scale.x).toBeCloseTo(1.04, 12);

    frameAt(handle, { low: 0.5 });
    expect(core.scale.x).toBeCloseTo(1.06, 12);
    // Halo keeps its +4% outline offset on top of the beat scale.
    expect(halo.scale.x).toBeCloseTo(1.06 * 1.04, 12);

    frameAt(handle, { low: 0 });
    expect(core.scale.x).toBeCloseTo(1.0, 12);
  });

  it("clamps glow opacity at exactly 1 and 0.8 under extreme audio", () => {
    const { handle, lines } = buildConcept();
    const [core, halo] = lines;

    frameAt(handle, { energy: 5, respond: 5 });
    expect(core.material.opacity).toBe(1);
    expect(halo.material.opacity).toBe(0.8);
  });

  it("rests at baseline glow when the audio channels are silent", () => {
    const { handle, lines } = buildConcept();
    const [core, halo] = lines;

    frameAt(handle, {});
    expect(core.material.opacity).toBeCloseTo(0.85, 12);
    expect(halo.material.opacity).toBeCloseTo(0.5, 12);
  });

  it("pins hue at magenta/cyan while idle, including at the respond threshold", () => {
    const { handle, lines } = buildConcept();
    const coreMat = lines[0].material;
    const haloMat = lines[1].material;

    for (let i = 0; i < 40; i++) {
      frameAt(handle, { time: i * 0.37, energy: 0.9, respond: 0 });
    }
    expect(coreMat.color.r).toBe(MAGENTA.r);
    expect(coreMat.color.g).toBe(MAGENTA.g);
    expect(coreMat.color.b).toBe(MAGENTA.b);
    expect(haloMat.color.r).toBe(CYAN.r);
    expect(haloMat.color.g).toBe(CYAN.g);
    expect(haloMat.color.b).toBe(CYAN.b);

    // respond === 0.05 sits ON the gate (> 0.05), so the cycle must stay shut.
    frameAt(handle, { time: 3, energy: 0, respond: 0.05 });
    expect(coreMat.color.r).toBe(MAGENTA.r);
    expect(coreMat.color.b).toBe(MAGENTA.b);
  });

  it("swings core toward cyan and halo toward magenta while responding", () => {
    const { handle, lines } = buildConcept();
    const coreMat = lines[0].material;
    const haloMat = lines[1].material;

    // sin(t * 2.8) === 1 here, so the hue target is a clean 1.0.
    const t = Math.PI / 5.6;
    frameAt(handle, { time: t, respond: 1 });

    // One easing step of 0.06 from hueCycle 0.
    expect(coreMat.color.r).toBeCloseTo(0.94, 10);
    expect(coreMat.color.g).toBeCloseTo(0.122, 10);
    expect(coreMat.color.b).toBeCloseTo(0.7338, 10);
    expect(haloMat.color.r).toBeCloseTo(0.06, 10);
    expect(haloMat.color.g).toBeCloseTo(0.738, 10);
    expect(haloMat.color.b).toBeCloseTo(0.9362, 10);

    for (let i = 0; i < 300; i++) {
      frameAt(handle, { time: t, respond: 1 });
    }
    // Converged: the two layers have fully swapped hues.
    expect(coreMat.color.r).toBeCloseTo(CYAN.r, 6);
    expect(coreMat.color.g).toBeCloseTo(CYAN.g, 6);
    expect(coreMat.color.b).toBeCloseTo(CYAN.b, 6);
    expect(haloMat.color.r).toBeCloseTo(MAGENTA.r, 6);
    expect(haloMat.color.g).toBeCloseTo(MAGENTA.g, 6);
    expect(haloMat.color.b).toBeCloseTo(MAGENTA.b, 6);
  });

  it("treats the listen channel as inert for this concept", () => {
    // Two fresh builds, one frame each — hueCycle eases cumulatively across
    // frames, so sequential frames on one build would differ regardless.
    const quiet = buildConcept();
    const listening = buildConcept();

    frameAt(quiet.handle, { time: 2, energy: 0.3, low: 0.2, respond: 0.4 });
    frameAt(listening.handle, {
      time: 2,
      energy: 0.3,
      low: 0.2,
      respond: 0.4,
      listen: 1,
    });

    expect(snapshot(...listening.lines)).toEqual(snapshot(...quiet.lines));
  });

  it("dispose releases every geometry and material and clears the parent", () => {
    const { handle, parent, geometries, materials, lines } = buildConcept();
    const [core, halo] = lines;

    expect(parent.children).toHaveLength(2);
    handle.dispose();

    for (const geo of geometries) expect(geo.disposed).toBe(true);
    for (const mat of materials) expect(mat.disposed).toBe(true);
    expect(parent.children).toEqual([]);
    expect(parent.children.includes(core)).toBe(false);
    expect(parent.children.includes(halo)).toBe(false);
  });

  it("builds are independent — driving one variant never bleeds into another", () => {
    const a = buildConcept();
    const b = buildConcept();

    frameAt(a.handle, { time: 3, energy: 5, low: 0.4, respond: 1 });

    expect(a.lines[0]).not.toBe(b.lines[0]);
    expect(b.lines[0].material.opacity).toBeCloseTo(0.95, 12);
    expect(b.lines[0].scale.x).toBe(1);
    expect(b.lines[1].scale.x).toBeCloseTo(1.04, 12);
    expect(b.parent.children).toEqual([b.lines[1], b.lines[0]]);
  });
});
