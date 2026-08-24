/**
 * Behaviour tests for the hologram voice-orb concept
 * (`stories/src/concepts/hologram.ts`), driven through the injected
 * three/webgpu module surface the orb-kit harness hands every concept builder.
 * Covers the descriptor contract, the layered scene construction (wireframe
 * shell, inner ghost sphere, 13 scanline rings on the sphere-radius profile),
 * the idle-frame baseline, the upward scanline sweep with wrap-around at the
 * top of the range, brightness/opacity clamping at extreme energy+respond,
 * the respond colour pulse, glitch firing vs. the no-glitch determinism path
 * with geometric decay, and teardown of every retained resource on dispose.
 * The fake module records calls; every expectation is recomputed here, never
 * read back from the subject.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { concept } from "../../stories/src/concepts/hologram";
import type { OrbFrame, OrbUniforms } from "../../stories/src/orb-kit";

// three.js constant the concept assigns verbatim onto additive materials.
const ADDITIVE_BLENDING = 2;

const EPSILON = 1e-6;

// Authored scanline-sweep envelope of the hologram concept (observable as the
// spread of the constructed ring meshes).
const SCAN_COUNT = 13;
const SCAN_YMIN = -1.15;
const SCAN_YMAX = 1.15;
const SCAN_RANGE = SCAN_YMAX - SCAN_YMIN;

class FakeColor {
  r = 0;
  g = 0;
  b = 0;
  constructor(r?: number, g?: number, b?: number) {
    if (r !== undefined && g !== undefined && b !== undefined) {
      this.r = r;
      this.g = g;
      this.b = b;
    }
  }
  setRGB(r: number, g: number, b: number): void {
    this.r = r;
    this.g = g;
    this.b = b;
  }
}

class FakeGeometry {
  kind: string;
  args: unknown[];
  disposed = false;
  constructor(kind: string, args: unknown[]) {
    this.kind = kind;
    this.args = args;
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakeMaterial {
  color = new FakeColor();
  transparent = false;
  opacity = 1;
  depthWrite = true;
  blending?: number;
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

class FakeObject3D {
  position = { x: 0, y: 0, z: 0 };
  rotation = { x: 0, y: 0, z: 0 };
  renderOrder = 0;
  scale = {
    x: 1,
    y: 1,
    z: 1,
    set(x: number, y: number, z: number): void {
      this.x = x;
      this.y = y;
      this.z = z;
    },
  };
  geometry?: FakeGeometry;
  material?: FakeMaterial;
  children: FakeObject3D[] = [];
  add(child: FakeObject3D): void {
    this.children.push(child);
  }
  remove(child: FakeObject3D): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
  }
}

/**
 * Minimal three/webgpu double: records every constructed geometry/material and
 * parents every mesh onto one trackable group, matching the read/write surface
 * the hologram builder touches (no more).
 */
function makeHologramHarness() {
  const geometries: FakeGeometry[] = [];
  const materials: FakeMaterial[] = [];

  class IcosahedronGeometry extends FakeGeometry {
    constructor(...args: unknown[]) {
      super("icosahedron", args);
      geometries.push(this);
    }
  }
  class WireframeGeometry extends FakeGeometry {
    constructor(...args: unknown[]) {
      super("wireframe", args);
      geometries.push(this);
    }
  }
  class TorusGeometry extends FakeGeometry {
    constructor(...args: unknown[]) {
      super("torus", args);
      geometries.push(this);
    }
  }
  class LineBasicNodeMaterial extends FakeMaterial {
    constructor() {
      super();
      materials.push(this);
    }
  }
  class MeshBasicNodeMaterial extends FakeMaterial {
    constructor() {
      super();
      materials.push(this);
    }
  }

  const THREE = {
    AdditiveBlending: ADDITIVE_BLENDING,
    Color: FakeColor,
    IcosahedronGeometry,
    WireframeGeometry,
    TorusGeometry,
    LineBasicNodeMaterial,
    MeshBasicNodeMaterial,
    LineSegments: class extends FakeObject3D {
      constructor(geo: FakeGeometry, mat: FakeMaterial) {
        super();
        this.geometry = geo;
        this.material = mat;
      }
    },
    Mesh: class extends FakeObject3D {
      constructor(geo: FakeGeometry, mat: FakeMaterial) {
        super();
        this.geometry = geo;
        this.material = mat;
      }
    },
  };
  const parent = new FakeObject3D();
  return { THREE, parent, geometries, materials };
}

const EMPTY_UNIFORMS: OrbUniforms = {
  uTime: null,
  uEnergy: null,
  uLow: null,
  uListen: null,
  uRespond: null,
  uAspect: null,
  uAccent: null,
};

// Sphere-profile contract the rings follow: r = sqrt(1 - y²) * 0.98 with y
// clamped just inside the poles so the profile never collapses to zero width.
function sphereProfileRadius(y: number): number {
  const clampedY = Math.max(-0.98, Math.min(0.98, y));
  return Math.sqrt(1 - clampedY * clampedY) * 0.98;
}

function buildHologram() {
  const harness = makeHologramHarness();
  const handle = concept.build(
    harness.THREE,
    {},
    EMPTY_UNIFORMS,
    harness.parent,
  );
  const [wireframe, innerSphere] = harness.parent.children;
  const rings = harness.parent.children.slice(2);
  return { ...harness, handle, wireframe, innerSphere, rings };
}

const IDLE_FRAME: OrbFrame = {
  time: 0,
  energy: 0,
  low: 0,
  listen: 0,
  respond: 0,
};

describe("hologram voice-orb concept", () => {
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Park Math.random above every gated chance (max 0.36) so the glitch path
    // stays closed unless a test explicitly opens it.
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  it("declares the descriptor the orb gallery dispatches on", () => {
    expect(concept.id).toBe("hologram");
    expect(concept.label).toBe("hologram");
    expect(concept.family).toBe("sci-fi");
    expect(typeof concept.build).toBe("function");
  });

  it("builds shell, ghost sphere and scanline rings under the given parent", () => {
    const { parent, geometries, materials, wireframe, innerSphere, rings } =
      buildHologram();

    expect(parent.children).toHaveLength(2 + SCAN_COUNT);
    expect(wireframe).toBeDefined();
    expect(innerSphere).toBeDefined();
    expect(rings).toHaveLength(SCAN_COUNT);

    // One wireframe pair + one inner sphere + one torus per ring.
    expect(geometries.filter((g) => g.kind === "icosahedron")).toHaveLength(2);
    expect(geometries.filter((g) => g.kind === "wireframe")).toHaveLength(1);
    expect(geometries.filter((g) => g.kind === "torus")).toHaveLength(
      SCAN_COUNT,
    );
    expect(materials).toHaveLength(2 + SCAN_COUNT);
  });

  it("authors the cyan additive wireframe shell in front of a faint ghost sphere", () => {
    const { wireframe, innerSphere, geometries } = buildHologram();

    expect(wireframe.material?.transparent).toBe(true);
    expect(wireframe.material?.opacity).toBe(0.55);
    expect(wireframe.material?.depthWrite).toBe(false);
    expect(wireframe.material?.blending).toBe(ADDITIVE_BLENDING);
    expect(wireframe.material?.color.r).toBe(0);
    expect(wireframe.material?.color.g).toBeCloseTo(0.92, 6);
    expect(wireframe.material?.color.b).toBeCloseTo(1, 6);

    // The ghost sphere renders behind everything else in the group.
    expect(innerSphere.renderOrder).toBe(-1);
    expect(innerSphere.material?.transparent).toBe(true);
    expect(innerSphere.material?.opacity).toBeCloseTo(0.18, 6);
    expect(innerSphere.material?.depthWrite).toBe(false);

    // The wireframe derives from an icosahedron of radius 1, detail 2.
    const icosa = geometries.find((g) => g.kind === "icosahedron");
    expect(icosa?.args).toEqual([1.0, 2]);
  });

  it("distributes the scanline rings across the sweep range on the sphere profile", () => {
    const { rings } = buildHologram();

    const ys = rings.map((ring) => ring.position.y);
    // Evenly phased start positions spanning slightly beyond the sphere.
    expect(Math.min(...ys)).toBeCloseTo(SCAN_YMIN, 6);
    expect(Math.max(...ys)).toBeCloseTo(SCAN_YMAX - SCAN_RANGE / SCAN_COUNT, 6);
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i]).toBeGreaterThan(ys[i - 1]);
      expect(ys[i] - ys[i - 1]).toBeCloseTo(SCAN_RANGE / SCAN_COUNT, 6);
    }

    // Each torus radius follows the sphere profile at its starting height, so
    // rings hug the form instead of poking through it.
    rings.forEach((ring) => {
      const torus = ring.geometry;
      expect(torus?.kind).toBe("torus");
      const [radius, tube] = torus?.args ?? [];
      expect(radius).toBeCloseTo(sphereProfileRadius(ring.position.y), 6);
      expect(tube).toBe(0.008);

      // Lying flat in the XZ plane so the sweep reads as horizontal bands.
      expect(ring.rotation.x).toBeCloseTo(Math.PI / 2, 6);
    });
  });

  it("applies the idle baseline at time zero without perturbing authored state", () => {
    const { handle, wireframe, innerSphere, rings } = buildHologram();

    handle.frame(IDLE_FRAME);

    // Zero shimmer contribution at t=0, zero boost: exact base opacities.
    expect(wireframe.material?.opacity).toBeCloseTo(0.52, 6);
    expect(wireframe.rotation.y).toBe(0);
    expect(wireframe.rotation.x).toBe(0);
    expect(innerSphere.rotation.y).toBe(-0);
    expect(innerSphere.material?.opacity).toBeCloseTo(0.14, 6);

    // At the authored position each ring's profile ratio is exactly 1.
    for (const ring of rings) {
      expect(ring.scale.x).toBeCloseTo(1, 6);
      expect(ring.scale.z).toBeCloseTo(1, 6);
      expect(ring.scale.y).toBe(1);
    }

    // The ring resting at the bottom pole gets attenuated below the floor and
    // clamps at the minimum visible opacity.
    const bottomRing = rings[0];
    const expected = (0.18 + 0) * Math.sqrt(Math.max(0, 1 - -0.98 * -0.98));
    expect(expected).toBeLessThan(0.04);
    expect(bottomRing.material?.opacity).toBe(0.04);
  });

  it("sweeps rings upward over time and wraps back to the bottom of the range", () => {
    const { handle, rings } = buildHologram();
    const startBottom = rings[0].position.y;

    // Idle speed: 0.55 world-units/s along Y.
    handle.frame({ ...IDLE_FRAME, time: 1 });
    const advanced = rings[0].position.y;
    expect(advanced).toBeGreaterThan(startBottom);
    expect(advanced - startBottom).toBeGreaterThan(0.5);
    expect(advanced - startBottom).toBeLessThan(0.57);

    // Past one full sweep the phase wraps modulo the range instead of
    // escaping past the top: unwrapped, this position would exceed SCAN_YMAX.
    handle.frame({ ...IDLE_FRAME, time: 4.4 });
    const wrapped = rings[0].position.y;
    expect(wrapped).toBeLessThan(SCAN_YMIN + 0.2);
    expect(wrapped).toBeGreaterThanOrEqual(SCAN_YMIN);

    // Long-run stability: positions stay inside the sweep window forever and
    // nothing degenerates into NaN.
    handle.frame({ ...IDLE_FRAME, time: 5000 });
    for (const ring of rings) {
      expect(Number.isFinite(ring.position.y)).toBe(true);
      expect(ring.position.y).toBeGreaterThanOrEqual(SCAN_YMIN);
      expect(ring.position.y).toBeLessThan(SCAN_YMAX);
    }
  });

  it("keeps every animated quantity inside its clamp band under extreme drive", () => {
    const { handle, wireframe, rings } = buildHologram();

    handle.frame({ ...IDLE_FRAME, time: 0.37, energy: 1, respond: 1 });

    // Wireframe brightness saturates at its ceiling.
    expect(wireframe.material?.opacity).toBe(0.95);

    // The respond pulse pushes the brightest ring into the opacity ceiling.
    const opacities = rings.map((ring) => ring.material?.opacity ?? NaN);
    for (const opacity of opacities) {
      expect(Number.isFinite(opacity)).toBe(true);
      expect(opacity).toBeGreaterThanOrEqual(0.04);
      expect(opacity).toBeLessThanOrEqual(0.85);
    }
    expect(Math.max(...opacities)).toBe(0.85);
  });

  it("shifts the shell colour toward white-blue while responding", () => {
    const { handle, wireframe } = buildHologram();

    handle.frame(IDLE_FRAME);
    const idleG = wireframe.material?.color.g ?? NaN;
    const idleR = wireframe.material?.color.r ?? NaN;

    handle.frame({ ...IDLE_FRAME, time: 0, respond: 1 });
    expect(wireframe.material?.color.r).toBeCloseTo(idleR + 0.15, 6);
    expect(wireframe.material?.color.g).toBeGreaterThan(idleG);
    expect(wireframe.material?.color.g).toBeCloseTo(0.92, 6);
    expect(wireframe.material?.color.b).toBeCloseTo(1, 6);
  });

  it("ignores listen and low inputs entirely", () => {
    const { handle, wireframe } = buildHologram();

    handle.frame(IDLE_FRAME);
    const baselineOpacity = wireframe.material?.opacity;
    const baselineY = wireframe.rotation.y;

    handle.frame({ ...IDLE_FRAME, listen: 1, low: 1 });
    expect(wireframe.material?.opacity).toBe(baselineOpacity);
    expect(wireframe.rotation.y).toBe(baselineY);
  });

  it("keeps rotation purely time-linear when the glitch never fires", () => {
    const { handle, wireframe } = buildHologram();

    // random=0.99 exceeds every glitch chance, including refires once the
    // cooldown repeatedly expires — exercises the cooldown reset branch too.
    for (let step = 0; step <= 20; step += 1) {
      const time = step * 0.5;
      handle.frame({ ...IDLE_FRAME, time });
      expect(wireframe.rotation.y).toBeCloseTo(time * 0.07, 12);
      expect(wireframe.rotation.x).toBeCloseTo(
        Math.sin(time * 0.09) * 0.06,
        12,
      );
    }
  });

  it("snaps a bounded glitch offset that decays geometrically toward zero", () => {
    const { handle, wireframe } = buildHologram();
    randomSpy.mockReturnValue(0); // every eligible roll fires

    const t1 = 1.0;
    handle.frame({ ...IDLE_FRAME, time: t1 });
    // Rotation is written before the roll, so the first frame stays clean and
    // the freshly snapped offset lands afterwards.
    expect(wireframe.rotation.y).toBeCloseTo(t1 * 0.07, 12);

    const t2 = 1.1;
    handle.frame({ ...IDLE_FRAME, time: t2 });
    const offset2 = wireframe.rotation.y - t2 * 0.07;
    expect(offset2).toBeLessThan(0);
    expect(Math.abs(offset2)).toBeLessThanOrEqual(0.09 + EPSILON);

    const t3 = 1.2;
    handle.frame({ ...IDLE_FRAME, time: t3 });
    const offset3 = wireframe.rotation.y - t3 * 0.07;

    // Same-sign, strictly shrinking: the angle decays by 0.82 per frame while
    // the cooldown window keeps new glitches from stacking.
    expect(offset3).toBeLessThan(0);
    expect(offset3 / offset2).toBeCloseTo(0.82, 6);
  });

  it("disposes every retained geometry and material and empties the parent group", () => {
    const { parent, geometries, materials, handle } = buildHologram();
    expect(parent.children.length).toBeGreaterThan(0);

    handle.dispose();

    expect(parent.children).toHaveLength(0);
    // Every material is released.
    for (const mat of materials) expect(mat.disposed).toBe(true);
    // Every geometry the handle retains is released. The base shell
    // icosahedron is observably NOT disposed: it is consumed only as
    // WireframeGeometry's derivation input and never referenced afterwards,
    // so its lifetime ends with the scope rather than with dispose().
    const [shellIcosa, innerIcosa] = geometries.filter(
      (g) => g.kind === "icosahedron",
    );
    expect(shellIcosa?.disposed).toBe(false);
    expect(innerIcosa?.disposed).toBe(true);
    for (const geo of geometries) {
      if (geo === shellIcosa) continue;
      expect(geo.disposed).toBe(true);
    }
  });
});
