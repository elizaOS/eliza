/**
 * Behaviour tests for the fog voice-orb concept
 * (`stories/src/concepts/fog.ts`), driven through the injected three/webgpu
 * module surface the orb-kit harness hands every concept builder. Covers the
 * descriptor contract, the ten-shell layered scene (descending radii,
 * translucent slate-blue NormalBlending materials, sparse haze-mote cloud),
 * per-frame spin classification per axis with alternating directions, bounded
 * positional drift, the opacity respond/listen formula with its 0.24 ceiling,
 * the energy breathe scale, mote rewrite bounds with `needsUpdate` signalling,
 * input-insensitivity to `low`, frame determinism, and full teardown on
 * dispose. The double records calls; every expectation is recomputed here,
 * never read back from the subject.
 */

import { describe, expect, it } from "vitest";
import { concept } from "../../stories/src/concepts/fog";

// three.js constant value the concept assigns verbatim onto materials.
const NORMAL_BLENDING = 1;

const EPSILON = 1e-6;

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
  needsUpdate = false;
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
  setAttribute(name: string, attribute: FakeBufferAttribute): void {
    this.attributes[name] = attribute;
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** Sphere stand-in recording the radius and segmentation it was built with. */
class FakeSphereGeometry extends FakeGeometry {
  radius: number;
  widthSegments: number;
  heightSegments: number;
  constructor(radius: number, widthSegments: number, heightSegments: number) {
    super();
    this.radius = radius;
    this.widthSegments = widthSegments;
    this.heightSegments = heightSegments;
  }
}

class FakeMaterial {
  color = new FakeColor();
  opacity = 1;
  transparent = false;
  depthWrite = true;
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
  scale = {
    x: 1,
    y: 1,
    z: 1,
    setScalar(v: number): void {
      this.x = v;
      this.y = v;
      this.z = v;
    },
  };
  frustumCulled = true;
  constructor(geometry: FakeGeometry, material: FakeMaterial) {
    this.geometry = geometry;
    this.material = material;
  }
}

function makeThreeModule() {
  const sphereGeometries: FakeSphereGeometry[] = [];
  const bufferGeometries: FakeGeometry[] = [];
  const materials: FakeMaterial[] = [];
  const objects: FakeObject3D[] = [];
  const THREE = {
    SphereGeometry: class extends FakeSphereGeometry {
      constructor(...args: ConstructorParameters<typeof FakeSphereGeometry>) {
        super(...args);
        sphereGeometries.push(this);
      }
    },
    BufferGeometry: class extends FakeGeometry {
      constructor() {
        super();
        bufferGeometries.push(this);
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
    NormalBlending: NORMAL_BLENDING,
  };
  return { THREE, sphereGeometries, bufferGeometries, materials, objects };
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

const SHELL_COUNT = 10;

interface BuiltScene {
  handle: ReturnType<typeof concept.build>;
  parent: ReturnType<typeof makeParent>;
  shells: FakeObject3D[];
  motes: FakeObject3D;
  shellGeometries: FakeSphereGeometry[];
  moteGeometry: FakeGeometry;
}

/** Builds the concept against fresh doubles and splits parent children into shells + motes. */
function buildScene(): BuiltScene {
  const { THREE, sphereGeometries, bufferGeometries } = makeThreeModule();
  const parent = makeParent();
  const handle = concept.build(THREE, {}, UNIFORMS, parent);
  const shells = parent.children.slice(0, SHELL_COUNT) as FakeObject3D[];
  const motes = parent.children[SHELL_COUNT] as FakeObject3D;
  return {
    handle,
    parent,
    shells,
    motes,
    shellGeometries: sphereGeometries,
    moteGeometry: bufferGeometries[0],
  };
}

/** Per-shell animated state, stringified for whole-state equality checks. */
function shellSnapshot(scene: BuiltScene): string[] {
  return scene.shells.map(
    (mesh) =>
      `${mesh.rotation.x},${mesh.rotation.y},${mesh.rotation.z},${
        mesh.position.x
      },${mesh.position.y},${mesh.position.z},${mesh.scale.x},${
        (mesh.material as FakeMaterial).opacity
      },${(mesh.material as FakeMaterial).color.r},${
        (mesh.material as FakeMaterial).color.g
      },${(mesh.material as FakeMaterial).color.b}`,
  );
}

describe("fog concept descriptor", () => {
  it("registers under the fog id with the mood family and a callable builder", () => {
    expect(concept.id).toBe("fog");
    expect(concept.label).toBe("fog");
    expect(concept.family).toBe("mood");
    expect(typeof concept.build).toBe("function");
  });
});

describe("fog build: layered shell scene", () => {
  it("adds ten sphere shells followed by one haze-mote cloud to the parent", () => {
    const scene = buildScene();
    expect(scene.parent.children).toHaveLength(SHELL_COUNT + 1);
    expect(scene.shellGeometries).toHaveLength(SHELL_COUNT);
    expect(scene.moteGeometry).toBeInstanceOf(FakeGeometry);
    for (const geo of scene.shellGeometries) {
      expect(geo.widthSegments).toBe(24);
      expect(geo.heightSegments).toBe(16);
    }
    expect(scene.motes.frustumCulled).toBe(false);
  });

  it("stacks the shells inner-to-outer: radii descend monotonically within unit scale", () => {
    const scene = buildScene();
    const radii = scene.shellGeometries.map((geo) => geo.radius);
    for (let i = 1; i < radii.length; i += 1) {
      expect(radii[i]).toBeLessThan(radii[i - 1]);
    }
    expect(radii[radii.length - 1]).toBeGreaterThanOrEqual(0.7);
    expect(radii[0]).toBeLessThanOrEqual(1.25);
  });

  it("configures every shell as translucent unblotted normal-blended haze", () => {
    const scene = buildScene();
    for (const mesh of scene.shells) {
      const mat = mesh.material as FakeMaterial;
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(mat.blending).toBe(NORMAL_BLENDING);
      expect(mat.opacity).toBeGreaterThanOrEqual(0.1);
      expect(mat.opacity).toBeLessThanOrEqual(0.15);
    }
  });

  it("gives every shell a muted slate-blue hue ordered blue over green over red, repeating at most one", () => {
    const scene = buildScene();
    const seen = new Set<string>();
    for (const mesh of scene.shells) {
      const color = (mesh.material as FakeMaterial).color;
      expect(color.b).toBeGreaterThan(color.g);
      expect(color.g).toBeGreaterThan(color.r);
      for (const channel of [color.r, color.g, color.b]) {
        expect(channel).toBeGreaterThanOrEqual(0.3);
        expect(channel).toBeLessThanOrEqual(0.65);
      }
      seen.add(`${color.r},${color.g},${color.b}`);
    }
    expect(seen.size).toBe(SHELL_COUNT - 1);
  });

  it("configures the mote cloud as small dim slate-blue translucent points", () => {
    const scene = buildScene();
    const mat = scene.motes.material as FakeMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.blending).toBe(NORMAL_BLENDING);
    expect(mat.opacity).toBeCloseTo(0.4, 10);
    expect(mat.size).toBeCloseTo(0.022, 10);
    expect(mat.color.b).toBeGreaterThan(mat.color.g);
    expect(mat.color.g).toBeGreaterThan(mat.color.r);
    const pos = (scene.motes.geometry as FakeGeometry).attributes.position;
    expect(pos.itemSize).toBe(3);
    expect(pos.count).toBe(80);
    for (let vi = 0; vi < pos.count; vi += 1) {
      const r = Math.hypot(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      expect(r).toBeGreaterThanOrEqual(0.5 - EPSILON);
      expect(r).toBeLessThanOrEqual(1.25 + EPSILON);
    }
  });
});

describe("fog frame animation", () => {
  const IDLE = { time: 0, energy: 0, low: 0, listen: 0, respond: 0 };

  it("rests perfectly still at time zero: every rotation is zero and scale is unity", () => {
    const scene = buildScene();
    scene.handle.frame(IDLE);
    for (const mesh of scene.shells) {
      // Negative spin directions turn 0 * -1 into -0; compare numerically.
      expect(mesh.rotation.x).toBeCloseTo(0, 10);
      expect(mesh.rotation.y).toBeCloseTo(0, 10);
      expect(mesh.rotation.z).toBeCloseTo(0, 10);
      expect(mesh.scale.x).toBe(1);
      expect(mesh.scale.y).toBe(1);
      expect(mesh.scale.z).toBe(1);
    }
  });

  it("leaves shell opacity at its build-time base when energy inputs are neutral", () => {
    const scene = buildScene();
    const bases = scene.shells.map(
      (mesh) => (mesh.material as FakeMaterial).opacity,
    );
    scene.handle.frame(IDLE);
    scene.shells.forEach((mesh, si) => {
      expect((mesh.material as FakeMaterial).opacity).toBeCloseTo(
        bases[si],
        10,
      );
    });
  });

  it("resets the mote cloud opacity from the build-time 0.4 to the animated 0.34 floor", () => {
    const scene = buildScene();
    expect((scene.motes.material as FakeMaterial).opacity).toBeCloseTo(0.4, 10);
    scene.handle.frame(IDLE);
    expect((scene.motes.material as FakeMaterial).opacity).toBeCloseTo(
      0.34,
      10,
    );
  });

  it("breathes the whole stack uniformly with energy: scalar scale of 1 + energy * 0.06", () => {
    const scene = buildScene();
    scene.handle.frame({ ...IDLE, energy: 0.5 });
    for (const mesh of scene.shells) {
      expect(mesh.scale.x).toBeCloseTo(1.03, 10);
      expect(mesh.scale.y).toBeCloseTo(1.03, 10);
      expect(mesh.scale.z).toBeCloseTo(1.03, 10);
    }
    scene.handle.frame({ ...IDLE, energy: 1 });
    for (const mesh of scene.shells) {
      expect(mesh.scale.x).toBeCloseTo(1.06, 10);
      expect(mesh.scale.y).toBeCloseTo(1.06, 10);
      expect(mesh.scale.z).toBeCloseTo(1.06, 10);
    }
  });

  it("lifts colour toward cooler blue on respond by fixed per-channel offsets", () => {
    const scene = buildScene();
    // Copy channels out before framing: setRGB mutates the captured color.
    const bases = scene.shells.map((mesh) => {
      const color = (mesh.material as FakeMaterial).color;
      return { r: color.r, g: color.g, b: color.b };
    });
    scene.handle.frame({ ...IDLE, respond: 1 });
    scene.shells.forEach((mesh, si) => {
      const color = (mesh.material as FakeMaterial).color;
      expect(color.r).toBeCloseTo(bases[si].r + 0.05, 10);
      expect(color.g).toBeCloseTo(bases[si].g + 0.06, 10);
      expect(color.b).toBeCloseTo(bases[si].b + 0.08, 10);
    });
  });

  it("raises opacity by 0.015 at full respond without ever reaching the 0.24 ceiling", () => {
    const scene = buildScene();
    const bases = scene.shells.map(
      (mesh) => (mesh.material as FakeMaterial).opacity,
    );
    scene.handle.frame({ ...IDLE, respond: 1 });
    scene.shells.forEach((mesh, si) => {
      const lifted = (mesh.material as FakeMaterial).opacity;
      expect(lifted).toBeCloseTo(Math.min(0.24, bases[si] + 0.015), 10);
      expect(lifted).toBeLessThan(0.24);
    });
  });

  it("dims opacity by 0.008 at full listen, stacking subtractively with respond", () => {
    const scene = buildScene();
    const bases = scene.shells.map(
      (mesh) => (mesh.material as FakeMaterial).opacity,
    );
    scene.handle.frame({ ...IDLE, listen: 1 });
    scene.shells.forEach((mesh, si) => {
      expect((mesh.material as FakeMaterial).opacity).toBeCloseTo(
        bases[si] - 0.008,
        10,
      );
    });
    scene.handle.frame({ ...IDLE, respond: 1, listen: 0.5 });
    scene.shells.forEach((mesh, si) => {
      expect((mesh.material as FakeMaterial).opacity).toBeCloseTo(
        Math.min(0.24, bases[si] + 0.015 - 0.004),
        10,
      );
    });
  });

  it("spins each shell at a constant signed rate about exactly one axis", () => {
    const scene = buildScene();
    const times = [2, 12, 22];
    const readings = times.map((time) => {
      scene.handle.frame({ ...IDLE, time });
      return scene.shells.map(
        (mesh) => [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z] as const,
      );
    });
    const axisCounts = { x: 0, y: 0, z: 0 } as Record<string, number>;
    const directions: number[] = [];
    for (let si = 0; si < SHELL_COUNT; si += 1) {
      let spinningAxis = -1;
      let rate = 0;
      for (let axis = 0; axis < 3; axis += 1) {
        const r1 =
          (readings[1][si][axis] - readings[0][si][axis]) /
          (times[1] - times[0]);
        const r2 =
          (readings[2][si][axis] - readings[1][si][axis]) /
          (times[2] - times[1]);
        if (Math.abs(r1 - r2) < 1e-9 && Math.abs(r1) > 1e-6) {
          expect(spinningAxis).toBe(-1);
          spinningAxis = axis;
          rate = r1;
        }
      }
      expect(spinningAxis).toBeGreaterThanOrEqual(0);
      axisCounts["xyz"[spinningAxis]] += 1;
      directions.push(Math.sign(rate));
      expect(Math.abs(rate)).toBeGreaterThanOrEqual(0.006);
      expect(Math.abs(rate)).toBeLessThanOrEqual(0.015);
    }
    expect(axisCounts).toEqual({ x: 3, y: 5, z: 2 });
    for (let si = 1; si < directions.length; si += 1) {
      expect(directions[si]).toBe(-directions[si - 1]);
    }
  });

  it("keeps non-spinning rotation components inside their small wobble bounds", () => {
    const scene = buildScene();
    // Classify each shell's spin axis first: only that component grows
    // linearly; a wobble's apparent rate stays under 0.002 rad/s.
    scene.handle.frame({ ...IDLE, time: 100 });
    const early = scene.shells.map(
      (mesh) => [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z] as const,
    );
    scene.handle.frame({ ...IDLE, time: 200 });
    const late = scene.shells.map(
      (mesh) => [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z] as const,
    );
    const spinAxes = early.map((from, si) => {
      for (let axis = 0; axis < 3; axis += 1) {
        if (Math.abs((late[si][axis] - from[axis]) / 100) > 0.002) return axis;
      }
      return -1;
    });
    for (let step = 0; step <= 30; step += 1) {
      scene.handle.frame({ ...IDLE, time: step * 1.7 });
      scene.shells.forEach((mesh, si) => {
        const angles = [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z];
        for (let axis = 0; axis < 3; axis += 1) {
          if (axis === spinAxes[si]) continue;
          expect(Math.abs(angles[axis])).toBeLessThanOrEqual(0.08 + EPSILON);
        }
      });
    }
  });

  it("wanders each shell centre on bounded sinusoidal drift of amplitude 0.025", () => {
    const scene = buildScene();
    const mins = scene.shells.map(() => [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ]);
    const maxs = scene.shells.map(() => [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
    for (let step = 0; step <= 120; step += 1) {
      scene.handle.frame({ ...IDLE, time: step * 2.03 });
      scene.shells.forEach((mesh, si) => {
        for (let axis = 0; axis < 3; axis += 1) {
          const v = [mesh.position.x, mesh.position.y, mesh.position.z][axis];
          mins[si][axis] = Math.min(mins[si][axis], v);
          maxs[si][axis] = Math.max(maxs[si][axis], v);
        }
      });
    }
    for (let si = 0; si < SHELL_COUNT; si += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const range = maxs[si][axis] - mins[si][axis];
        expect(range).toBeGreaterThan(0.03);
        expect(range).toBeLessThanOrEqual(0.05 + 1e-9);
      }
    }
  });

  it("rewrites all eighty mote positions inside the shell volume and flags the attribute dirty", () => {
    const scene = buildScene();
    const pos = (scene.motes.geometry as FakeGeometry).attributes
      .position as FakeBufferAttribute;
    scene.handle.frame({ ...IDLE, time: 37 });
    expect(pos.needsUpdate).toBe(true);
    for (let vi = 0; vi < pos.count; vi += 1) {
      const x = pos.getX(vi);
      const y = pos.getY(vi);
      const z = pos.getZ(vi);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(Number.isFinite(z)).toBe(true);
      const r = Math.hypot(x, y, z);
      expect(r).toBeGreaterThanOrEqual(0.42 - EPSILON);
      expect(r).toBeLessThanOrEqual(1.33 + EPSILON);
    }
  });

  it("actually moves the motes between distant frames rather than pinning them", () => {
    const scene = buildScene();
    const pos = (scene.motes.geometry as FakeGeometry).attributes
      .position as FakeBufferAttribute;
    scene.handle.frame({ ...IDLE, time: 0 });
    const before = Float32Array.from(pos.array);
    scene.handle.frame({ ...IDLE, time: 40 });
    let travel = 0;
    for (let i = 0; i < before.length; i += 1) {
      travel += Math.abs(pos.array[i] - before[i]);
    }
    expect(travel).toBeGreaterThan(5);
  });

  it("ignores the low band entirely: only time, energy, listen and respond move anything", () => {
    const scene = buildScene();
    scene.handle.frame({
      time: 4,
      energy: 0.3,
      low: 0,
      listen: 0.2,
      respond: 0.4,
    });
    const baseline = [
      ...shellSnapshot(scene),
      Float32Array.from(
        (scene.motes.geometry as FakeGeometry).attributes.position.array,
      ).join(","),
    ];
    scene.handle.frame({
      time: 4,
      energy: 0.3,
      low: 1,
      listen: 0.2,
      respond: 0.4,
    });
    const replay = [
      ...shellSnapshot(scene),
      Float32Array.from(
        (scene.motes.geometry as FakeGeometry).attributes.position.array,
      ).join(","),
    ];
    expect(replay).toEqual(baseline);
  });

  it("is deterministic: replaying the same frame reproduces the same world state", () => {
    const scene = buildScene();
    const PEAK = { time: 9, energy: 0.8, low: 0.3, listen: 0.4, respond: 0.9 };
    scene.handle.frame(PEAK);
    const first = [
      ...shellSnapshot(scene),
      Float32Array.from(
        (scene.motes.geometry as FakeGeometry).attributes.position.array,
      ).join(","),
    ];
    scene.handle.frame(PEAK);
    const second = [
      ...shellSnapshot(scene),
      Float32Array.from(
        (scene.motes.geometry as FakeGeometry).attributes.position.array,
      ).join(","),
    ];
    expect(second).toEqual(first);
  });
});

describe("fog dispose", () => {
  it("disposes every geometry and material and detaches everything it added", () => {
    const scene = buildScene();
    const allGeometries: FakeGeometry[] = [
      ...scene.shellGeometries,
      scene.moteGeometry,
    ];
    const allMaterials = scene.parent.children.map(
      (child) => child.material as FakeMaterial,
    );
    expect(allGeometries).toHaveLength(SHELL_COUNT + 1);
    expect(allMaterials).toHaveLength(SHELL_COUNT + 1);

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
