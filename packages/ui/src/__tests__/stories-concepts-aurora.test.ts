/**
 * Behaviour tests for the aurora voice-orb concept
 * (`stories/src/concepts/aurora.ts`), driven through the injected three/webgpu
 * module surface the orb-kit harness hands every concept builder. Covers the
 * descriptor contract, the cylindrical ribbon bend (equator identity, backward
 * wrap, width flare, preserved height grid), the translucent-curtain material
 * contract, per-frame sway/lift animation with saturation clamping and
 * per-ribbon hue preservation, star-shell bounds, input-insensitivity to
 * `listen`/`low`, frame determinism, and full teardown on dispose. The double
 * records calls; every expectation is recomputed here, never read back from
 * the subject.
 */

import { describe, expect, it } from "vitest";
import { concept } from "../../stories/src/concepts/aurora";

// three.js constant values the concept assigns verbatim onto materials.
const NORMAL_BLENDING = 1;
const DOUBLE_SIDE = 2;

const EPSILON = 1e-6;

// Geometry positions live in Float32Array storage (as in three.js), so
// recomputed grid expectations only hold to float32 epsilon.
const F32_PRECISION = 6;

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

class FakeBufferAttribute {
  array: Float32Array;
  itemSize: number;
  count: number;
  constructor(array: Float32Array, itemSize: number) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array.length / itemSize;
  }
  getX(i: number): number {
    return this.array[i * 3];
  }
  getY(i: number): number {
    return this.array[i * 3 + 1];
  }
  getZ(i: number): number {
    return this.array[i * 3 + 2];
  }
  setXYZ(i: number, x: number, y: number, z: number): void {
    this.array[i * 3] = x;
    this.array[i * 3 + 1] = y;
    this.array[i * 3 + 2] = z;
  }
}

class FakeGeometry {
  attributes: Record<string, FakeBufferAttribute> = {};
  disposed = false;
  normalsComputed = false;
  setAttribute(name: string, attribute: FakeBufferAttribute): void {
    this.attributes[name] = attribute;
  }
  computeVertexNormals(): void {
    this.normalsComputed = true;
  }
  dispose(): void {
    this.disposed = true;
  }
}

/**
 * Row-major plane grid matching three.js PlaneGeometry ordering for
 * `wSegs = 1`: `(hSegs + 1)` rows from `+height/2` down to `-height/2`, each
 * holding a left/right column pair at `±width/2`.
 */
class FakePlaneGeometry extends FakeGeometry {
  width: number;
  height: number;
  hSegs: number;
  constructor(width: number, height: number, _wSegs: number, hSegs: number) {
    super();
    this.width = width;
    this.height = height;
    this.hSegs = hSegs;
    const positions = new Float32Array(2 * (hSegs + 1) * 3);
    let vi = 0;
    for (let iy = 0; iy <= hSegs; iy += 1) {
      const y = height / 2 - (iy / hSegs) * height;
      for (let ix = 0; ix <= 1; ix += 1) {
        positions[vi * 3] = ix === 0 ? -width / 2 : width / 2;
        positions[vi * 3 + 1] = y;
        vi += 1;
      }
    }
    this.setAttribute("position", new FakeBufferAttribute(positions, 3));
  }
}

class FakeMaterial {
  color = new FakeColor();
  opacity = 1;
  transparent = false;
  depthWrite = true;
  side = 0;
  blending = 0;
  size = 1;
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

class FakeObject3D {
  geometry: FakeGeometry;
  material: FakeMaterial;
  rotation = { x: 0, y: 0, z: 0 };
  position = { x: 0, y: 0, z: 0 };
  frustumCulled = true;
  constructor(geometry: FakeGeometry, material: FakeMaterial) {
    this.geometry = geometry;
    this.material = material;
  }
}

function makeThreeModule() {
  const planeGeometries: FakePlaneGeometry[] = [];
  const geometries: FakeGeometry[] = [];
  const materials: FakeMaterial[] = [];
  const objects: FakeObject3D[] = [];
  const THREE = {
    PlaneGeometry: class extends FakePlaneGeometry {
      constructor(...args: ConstructorParameters<typeof FakePlaneGeometry>) {
        super(...args);
        planeGeometries.push(this);
        geometries.push(this);
      }
    },
    BufferGeometry: class extends FakeGeometry {
      constructor() {
        super();
        geometries.push(this);
      }
    },
    BufferAttribute: FakeBufferAttribute,
    Color: FakeColor,
    MeshBasicNodeMaterial: class extends FakeMaterial {
      constructor() {
        super();
        materials.push(this);
      }
    },
    PointsNodeMaterial: class extends FakeMaterial {
      constructor() {
        super();
        materials.push(this);
      }
    },
    Mesh: class extends FakeObject3D {
      constructor(geometry: FakeGeometry, material: FakeMaterial) {
        super(geometry, material);
        objects.push(this);
      }
    },
    Points: class extends FakeObject3D {
      constructor(geometry: FakeGeometry, material: FakeMaterial) {
        super(geometry, material);
        objects.push(this);
      }
    },
    DoubleSide: DOUBLE_SIDE,
    NormalBlending: NORMAL_BLENDING,
  };
  return { THREE, planeGeometries, geometries, materials, objects };
}

function makeParent() {
  return {
    children: [] as FakeObject3D[],
    add(child: FakeObject3D): void {
      this.children.push(child);
    },
    remove(child: FakeObject3D): void {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
    },
  };
}

const UNIFORMS = {
  uTime: null,
  uEnergy: null,
  uLow: null,
  uListen: null,
  uRespond: null,
  uAspect: null,
  uAccent: null,
};

interface BuiltScene {
  handle: ReturnType<typeof concept.build>;
  parent: ReturnType<typeof makeParent>;
  ribbons: FakeObject3D[];
  stars: FakeObject3D;
  ribbonGeometries: FakePlaneGeometry[];
}

/** Builds the concept against fresh doubles and splits parent children into ribbons + stars. */
function buildScene(): BuiltScene {
  const { THREE, planeGeometries } = makeThreeModule();
  const parent = makeParent();
  const handle = concept.build(THREE, {}, UNIFORMS, parent);
  const ribbons = parent.children.slice(0, 5) as FakeObject3D[];
  const stars = parent.children[5] as FakeObject3D;
  return { handle, parent, ribbons, stars, ribbonGeometries: planeGeometries };
}

/** Per-ribbon animated state, stringified for whole-state equality checks. */
function snapshot(scene: {
  ribbons: FakeObject3D[];
  stars: FakeObject3D;
}): string[] {
  const states = scene.ribbons.map(
    (mesh) =>
      `${mesh.rotation.x},${mesh.rotation.y},${mesh.rotation.z},${mesh.position.y},${
        (mesh.material as FakeMaterial).opacity
      },${(mesh.material as FakeMaterial).color.r},${
        (mesh.material as FakeMaterial).color.g
      },${(mesh.material as FakeMaterial).color.b}`,
  );
  states.push(`${scene.stars.rotation.x},${scene.stars.rotation.y}`);
  return states;
}

describe("aurora concept descriptor", () => {
  it("registers under the aurora id with the mood family and a callable builder", () => {
    expect(concept.id).toBe("aurora");
    expect(concept.label).toBe("aurora");
    expect(concept.family).toBe("mood");
    expect(typeof concept.build).toBe("function");
  });
});

describe("aurora build: ribbon geometry", () => {
  it("adds five ribbon meshes followed by one star cloud to the parent", () => {
    const scene = buildScene();
    expect(scene.parent.children).toHaveLength(6);
    expect(scene.ribbonGeometries).toHaveLength(5);
    for (const mesh of scene.ribbons) {
      expect(mesh.geometry).toBeInstanceOf(FakePlaneGeometry);
    }
    expect(scene.stars.frustumCulled).toBe(false);
  });

  it("keeps the ribbon equator unbent: center-row vertices stay at their flat plane positions", () => {
    const scene = buildScene();
    const middleRow = 18;
    for (const geo of scene.ribbonGeometries) {
      const pos = geo.attributes.position;
      expect(pos.count).toBe((geo.hSegs + 1) * 2);
      for (const [vi, x] of [
        [middleRow * 2, -geo.width / 2],
        [middleRow * 2 + 1, geo.width / 2],
      ] as const) {
        expect(pos.getX(vi)).toBeCloseTo(x, F32_PRECISION);
        expect(pos.getY(vi)).toBeCloseTo(0, F32_PRECISION);
        expect(Math.abs(pos.getZ(vi))).toBeLessThan(EPSILON);
      }
    }
  });

  it("wraps every ribbon backwards around the core: off-equator vertices gain negative depth", () => {
    const scene = buildScene();
    for (const geo of scene.ribbonGeometries) {
      const pos = geo.attributes.position;
      for (let vi = 0; vi < pos.count; vi += 1) {
        if (Math.abs(pos.getY(vi)) > EPSILON) {
          expect(pos.getZ(vi)).toBeLessThan(0);
        }
      }
    }
  });

  it("flares the ribbon ends outward past the flat plane width", () => {
    const scene = buildScene();
    for (const geo of scene.ribbonGeometries) {
      const pos = geo.attributes.position;
      let maxTopAbsX = 0;
      for (let vi = 0; vi < 2; vi += 1) {
        maxTopAbsX = Math.max(maxTopAbsX, Math.abs(pos.getX(vi)));
      }
      expect(maxTopAbsX).toBeGreaterThan(geo.width / 2);
    }
  });

  it("preserves the height grid: bent rows stay symmetric about the equator", () => {
    const scene = buildScene();
    for (const geo of scene.ribbonGeometries) {
      const pos = geo.attributes.position;
      const rows = new Set<string>();
      let extreme = 0;
      for (let vi = 0; vi < pos.count; vi += 1) {
        const y = pos.getY(vi);
        rows.add(y.toPrecision(10));
        extreme = Math.max(extreme, Math.abs(y));
      }
      expect(rows.size).toBe(geo.hSegs + 1);
      let minSummed = 0;
      for (let vi = 0; vi < pos.count; vi += 1) {
        minSummed += pos.getY(vi);
      }
      expect(Math.abs(minSummed)).toBeLessThan(EPSILON);
      expect(extreme).toBeCloseTo(geo.height / 2, F32_PRECISION);
      expect(geo.normalsComputed).toBe(true);
    }
  });

  it("gives every ribbon its own non-zero pitch so the sheets never share a plane", () => {
    const scene = buildScene();
    const pitches = scene.ribbons.map((mesh) => mesh.rotation.x);
    expect(new Set(pitches).size).toBe(5);
    for (const pitch of pitches) {
      expect(pitch).not.toBe(0);
    }
  });
});

describe("aurora build: material contract", () => {
  it("configures every ribbon as translucent normal-blended curtain geometry", () => {
    const scene = buildScene();
    for (const mesh of scene.ribbons) {
      const mat = mesh.material as FakeMaterial;
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(mat.side).toBe(DOUBLE_SIDE);
      expect(mat.blending).toBe(NORMAL_BLENDING);
      expect(mat.opacity).toBeCloseTo(0.45, 10);
    }
  });

  it("gives each ribbon its own base hue within unit range, none shared", () => {
    const scene = buildScene();
    const seen = new Set<string>();
    for (const mesh of scene.ribbons) {
      const color = (mesh.material as FakeMaterial).color;
      for (const channel of [color.r, color.g, color.b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
      seen.add(`${color.r},${color.g},${color.b}`);
    }
    expect(seen.size).toBe(5);
  });

  it("configures the star cloud as small cool translucent points", () => {
    const scene = buildScene();
    const mat = scene.stars.material as FakeMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.blending).toBe(NORMAL_BLENDING);
    expect(mat.opacity).toBeCloseTo(0.7, 10);
    expect(mat.size).toBeCloseTo(0.02, 10);
    const pos = (scene.stars.geometry as FakeGeometry).attributes.position;
    expect(pos.count).toBe(60);
    for (let vi = 0; vi < pos.count; vi += 1) {
      const r = Math.hypot(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      expect(r).toBeGreaterThanOrEqual(0.5 - EPSILON);
      expect(r).toBeLessThanOrEqual(1.25 + EPSILON);
    }
  });
});

describe("aurora frame animation", () => {
  const IDLE = { time: 0, energy: 0, low: 0, listen: 0, respond: 0 };
  const PEAK = { time: 10, energy: 1, low: 0.5, listen: 1, respond: 1 };

  it("rests at the idle floor: ribbon opacity 0.42 and star opacity 0.5", () => {
    const scene = buildScene();
    scene.handle.frame(IDLE);
    for (const mesh of scene.ribbons) {
      expect((mesh.material as FakeMaterial).opacity).toBeCloseTo(0.42, 10);
    }
    expect((scene.stars.material as FakeMaterial).opacity).toBeCloseTo(0.5, 10);
  });

  it("brightens along the response curve and saturates at the 0.7 ceiling", () => {
    const scene = buildScene();
    const bases = scene.ribbons.map(
      (mesh) =>
        `${(mesh.material as FakeMaterial).color.r},${
          (mesh.material as FakeMaterial).color.g
        },${(mesh.material as FakeMaterial).color.b}`,
    );
    scene.handle.frame(PEAK);
    const lift = 1 + PEAK.respond * 0.25 + PEAK.energy * 0.18;
    scene.ribbons.forEach((mesh, ri) => {
      const color = (mesh.material as FakeMaterial).color;
      const [br, bg, bb] = bases[ri].split(",").map(Number);
      const expected = [br * lift, bg * lift, bb * lift].map((channel) =>
        Math.min(channel, 1),
      );
      expect(color.r).toBeCloseTo(expected[0], 10);
      expect(color.g).toBeCloseTo(expected[1], 10);
      expect(color.b).toBeCloseTo(expected[2], 10);
      expect((mesh.material as FakeMaterial).opacity).toBe(0.7);
    });
  });

  it("clamps lifted colour channels at exactly 1 instead of overshooting", () => {
    const scene = buildScene();
    scene.handle.frame(PEAK);
    const saturated = scene.ribbons.some((mesh) => {
      const color = (mesh.material as FakeMaterial).color;
      return color.r === 1 || color.g === 1 || color.b === 1;
    });
    expect(saturated).toBe(true);
  });

  it("spreads the five ribbons to pairwise-distinct headings while swaying", () => {
    const scene = buildScene();
    scene.handle.frame({ ...PEAK, time: 3.7 });
    const headings = scene.ribbons.map((mesh) => mesh.rotation.y);
    expect(new Set(headings).size).toBe(5);
  });

  it("keeps ribbons near-vertical and near the core at every sampled time", () => {
    const scene = buildScene();
    for (let step = 0; step <= 20; step += 1) {
      scene.handle.frame({ ...IDLE, time: step * 0.9 });
      for (const mesh of scene.ribbons) {
        expect(Math.abs(mesh.rotation.x)).toBeLessThanOrEqual(0.16);
        expect(Math.abs(mesh.position.y)).toBeLessThanOrEqual(0.27);
      }
    }
  });

  it("drifts the star cloud at fixed yaw/pitch rates", () => {
    const scene = buildScene();
    scene.handle.frame({ ...IDLE, time: 10 });
    expect(scene.stars.rotation.y).toBeCloseTo(0.4, 10);
    expect(scene.stars.rotation.x).toBeCloseTo(0.2, 10);
  });

  it("ignores listen and low inputs: only time, energy and respond move anything", () => {
    const scene = buildScene();
    scene.handle.frame({
      time: 4,
      energy: 0.3,
      low: 0,
      listen: 0,
      respond: 0.2,
    });
    const baseline = snapshot(scene);
    scene.handle.frame({
      time: 4,
      energy: 0.3,
      low: 1,
      listen: 1,
      respond: 0.2,
    });
    expect(snapshot(scene)).toEqual(baseline);
  });

  it("is deterministic: replaying the same frame reproduces the same world state", () => {
    const scene = buildScene();
    scene.handle.frame(PEAK);
    const first = snapshot(scene);
    scene.handle.frame(PEAK);
    expect(snapshot(scene)).toEqual(first);
  });
});

describe("aurora dispose", () => {
  it("disposes every geometry and material and detaches everything it added", () => {
    const scene = buildScene();
    const allGeometries: FakeGeometry[] = [
      ...scene.ribbonGeometries,
      scene.stars.geometry as FakeGeometry,
    ];
    const allMaterials = scene.parent.children.map(
      (child) => child.material as FakeMaterial,
    );
    expect(scene.parent.children).toHaveLength(6);

    scene.handle.dispose();

    for (const geometry of allGeometries) {
      expect(geometry.disposed).toBe(true);
    }
    for (const material of allMaterials) {
      expect(material.disposed).toBe(true);
    }
    expect(scene.parent.children).toHaveLength(0);
  });
});
