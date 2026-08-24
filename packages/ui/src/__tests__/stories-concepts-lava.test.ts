/**
 * Behaviour tests for the lava voice-orb concept
 * (`stories/src/concepts/lava.ts`), driven through the injected three/webgpu
 * module surface the orb-kit harness hands every concept builder. Covers the
 * descriptor contract, scene assembly (glass shell, seven staged-radius lava
 * blobs, twenty-eight-bubble gas points), the warmed crystal-glass shell
 * override, per-frame churn animation (shell containment clamps, swell band,
 * emissive heat curve, respond-driven warmth shift with channel saturation,
 * bubble sine ride and opacity mix, fixed-rate shell yaw accumulation),
 * input-insensitivity to `listen`/`low`, replay determinism, and full
 * teardown on dispose. The double records calls; every expectation is
 * recomputed here, never read back from the subject.
 */

import { describe, expect, it } from "vitest";
import { concept } from "../../stories/src/concepts/lava";

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
  needsUpdate = false;
  constructor(array: Float32Array, itemSize: number) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array.length / itemSize;
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

interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

class FakeMaterial {
  color = new FakeColor();
  emissive = new FakeColor();
  emissiveIntensity = 1;
  opacity = 1;
  transparent = false;
  depthWrite = true;
  size = 1;
  sizeAttenuation = true;
  roughness = 1;
  metalness = 0;
  transmission = 0;
  ior = 1.5;
  thickness = 0;
  dispersion = 0;
  clearcoat = 0;
  clearcoatRoughness = 0;
  envMapIntensity = 1;
  attenuationColor = new FakeColor();
  attenuationDistance = Number.POSITIVE_INFINITY;
  blending = 0;
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

class FakeObject3D {
  geometry: FakeGeometry;
  material: FakeMaterial;
  position: Vector3Like & {
    set: (x: number, y: number, z: number) => void;
  };
  scale: { setScalar: (s: number) => void } & { value?: number };
  rotation = { x: 0, y: 0, z: 0 };
  frustumCulled = true;
  constructor(geometry: FakeGeometry, material: FakeMaterial) {
    this.geometry = geometry;
    this.material = material;
    const pos: Vector3Like = { x: 0, y: 0, z: 0 };
    const scaleBox: { value?: number } = {};
    this.position = {
      get x() {
        return pos.x;
      },
      set x(v: number) {
        pos.x = v;
      },
      get y() {
        return pos.y;
      },
      set y(v: number) {
        pos.y = v;
      },
      get z() {
        return pos.z;
      },
      set z(v: number) {
        pos.z = v;
      },
      set(x: number, y: number, z: number) {
        pos.x = x;
        pos.y = y;
        pos.z = z;
      },
    };
    this.scale = {
      setScalar(s: number) {
        scaleBox.value = s;
      },
      get value() {
        return scaleBox.value;
      },
    };
  }
}

function makeThreeModule() {
  const sphereGeometries: FakeSphereGeometry[] = [];
  const bufferGeometries: FakeGeometry[] = [];
  const geometries: FakeGeometry[] = [];
  const materials: FakeMaterial[] = [];
  const objects: FakeObject3D[] = [];
  const THREE = {
    SphereGeometry: class extends FakeSphereGeometry {
      constructor(...args: ConstructorParameters<typeof FakeSphereGeometry>) {
        super(...args);
        sphereGeometries.push(this);
        geometries.push(this);
      }
    },
    BufferGeometry: class extends FakeGeometry {
      constructor() {
        super();
        bufferGeometries.push(this);
        geometries.push(this);
      }
    },
    BufferAttribute: FakeBufferAttribute,
    Color: FakeColor,
    MeshPhysicalNodeMaterial: class extends FakeMaterial {
      constructor() {
        super();
        materials.push(this);
      }
    },
    MeshStandardNodeMaterial: class extends FakeMaterial {
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
    AdditiveBlending: 2,
  };
  return {
    THREE,
    sphereGeometries,
    bufferGeometries,
    geometries,
    materials,
    objects,
  };
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
  shell: FakeObject3D;
  blobs: FakeObject3D[];
  bubbles: FakeObject3D;
  sphereGeometries: FakeSphereGeometry[];
  geometries: FakeGeometry[];
  materials: FakeMaterial[];
}

/** Builds the concept against fresh doubles and splits the assembled scene. */
function buildScene(): BuiltScene {
  const { THREE, sphereGeometries, geometries, materials } = makeThreeModule();
  const parent = makeParent();
  const handle = concept.build(THREE, {}, UNIFORMS, parent);
  const shell = parent.children[0] as FakeObject3D;
  const blobs = parent.children.slice(1, 8) as FakeObject3D[];
  const bubbles = parent.children[8] as FakeObject3D;
  return {
    handle,
    parent,
    shell,
    blobs,
    bubbles,
    sphereGeometries,
    geometries,
    materials,
  };
}

describe("lava concept descriptor", () => {
  it("registers under the lava id with the mood family and a callable builder", () => {
    expect(concept.id).toBe("lava");
    expect(concept.label).toBe("lava");
    expect(concept.family).toBe("mood");
    expect(typeof concept.build).toBe("function");
  });
});

describe("lava build: scene assembly", () => {
  it("adds one glass shell, seven lava blobs and one bubble cloud to the parent", () => {
    const scene = buildScene();
    expect(scene.parent.children).toHaveLength(9);
    expect(scene.blobs).toHaveLength(7);
    for (const blob of scene.blobs) {
      expect(blob.geometry).toBeInstanceOf(FakeSphereGeometry);
    }
    expect(scene.bubbles.frustumCulled).toBe(false);
    expect(scene.bubbles.geometry.attributes.position.count).toBe(28);
    expect(scene.sphereGeometries).toHaveLength(8);
  });

  it("builds the shell as a radius-1.05 sphere out of crystal glass, warmed past the kit default", () => {
    const scene = buildScene();
    const shellGeo = scene.shell.geometry as FakeSphereGeometry;
    expect(shellGeo.radius).toBeCloseTo(1.05, 10);
    const mat = scene.shell.material;
    // makeCrystalGlass baseline produced by the real orb-kit helper:
    expect(mat.transmission).toBe(1);
    expect(mat.dispersion).toBe(0);
    expect(mat.color.r).toBe(1);
    // The concept then warms the attenuation so thick glass reads amber:
    expect(mat.attenuationDistance).toBeCloseTo(2.5, 10);
    expect(mat.attenuationDistance).toBeLessThan(3.0);
    expect(mat.attenuationColor.r).toBeCloseTo(1.0, 10);
    expect(mat.attenuationColor.g).toBeCloseTo(0.72, 10);
    expect(mat.attenuationColor.b).toBeCloseTo(0.3, 10);
  });

  it("stages the seven blob radii in their declared descending-and-rising order", () => {
    const scene = buildScene();
    const radii = scene.blobs.map(
      (blob) => (blob.geometry as FakeSphereGeometry).radius,
    );
    expect(radii).toEqual([0.42, 0.38, 0.45, 0.36, 0.4, 0.43, 0.37]);
  });

  it("configures blobs as opaque self-lit standard materials with a dimmed base colour", () => {
    const scene = buildScene();
    for (const blob of scene.blobs) {
      const mat = blob.material;
      expect(mat.transparent).toBe(false);
      expect(mat.depthWrite).toBe(true);
      expect(mat.roughness).toBeCloseTo(0.42, 10);
      expect(mat.metalness).toBe(0);
      expect(mat.emissiveIntensity).toBeCloseTo(0.8, 10);
      // Base colour is the palette entry dimmed to 60% of its emissive hue.
      expect(mat.color.r).toBeCloseTo(mat.emissive.r * 0.6, 10);
      expect(mat.color.g).toBeCloseTo(mat.emissive.g * 0.6, 10);
      expect(mat.color.b).toBeCloseTo(mat.emissive.b * 0.6, 10);
      // Every blob glows in the declared warm band (deep crimson .. amber).
      expect(mat.emissive.r).toBeGreaterThanOrEqual(0.7);
      expect(mat.emissive.r).toBeLessThanOrEqual(1);
      expect(mat.emissive.g).toBeLessThanOrEqual(0.45);
      expect(mat.emissive.b).toBeLessThanOrEqual(0.05);
    }
  });

  it("seeds the bubble cloud with one flat vec3 slot per bubble", () => {
    const scene = buildScene();
    const attr = scene.bubbles.geometry.attributes.position;
    expect(attr.itemSize).toBe(3);
    expect(attr.array.length).toBe(28 * 3);
  });
});

describe("lava frame animation", () => {
  const IDLE = { time: 0, energy: 0, low: 0, listen: 0, respond: 0 };
  const MID = { time: 4.2, energy: 0.5, low: 0.25, listen: 1, respond: 0.5 };
  const PEAK = { time: 9, energy: 1, low: 0, listen: 0, respond: 1 };

  it("keeps every blob inside the lamp shell at every sampled beat", () => {
    const scene = buildScene();
    const beats = [
      IDLE,
      MID,
      PEAK,
      { time: 100, energy: 1, low: 0, listen: 0, respond: 0 },
    ];
    for (let step = 0; step <= 24; step += 1) {
      const beat = beats[step % beats.length];
      scene.handle.frame({ ...beat, time: beat.time + step * 0.9 });
      for (const blob of scene.blobs) {
        const radius = (blob.geometry as FakeSphereGeometry).radius;
        const maxR = 0.9 - radius * 0.5;
        const lenXZ = Math.hypot(blob.position.x, blob.position.z);
        expect(lenXZ).toBeLessThanOrEqual(maxR + EPSILON);
        expect(blob.position.y).toBeGreaterThanOrEqual(-0.85 - EPSILON);
        expect(blob.position.y).toBeLessThanOrEqual(0.85 + EPSILON);
      }
    }
  });

  it("swells blobs strictly inside the energy-driven band around rest scale", () => {
    const scene = buildScene();
    scene.handle.frame(IDLE);
    for (const blob of scene.blobs) {
      expect(blob.scale.value).toBeGreaterThanOrEqual(1 - 0.04 - EPSILON);
      expect(blob.scale.value).toBeLessThanOrEqual(1 + 0.04 + EPSILON);
    }
    scene.handle.frame(PEAK);
    for (const blob of scene.blobs) {
      expect(blob.scale.value).toBeGreaterThanOrEqual(
        1 + 0.22 - 0.04 - EPSILON,
      );
      expect(blob.scale.value).toBeLessThanOrEqual(1 + 0.22 + 0.04 + EPSILON);
    }
  });

  it("sets emissive heat to the exact voice mix at idle, mid and peak", () => {
    const scene = buildScene();
    scene.handle.frame(IDLE);
    for (const blob of scene.blobs) {
      expect(blob.material.emissiveIntensity).toBeCloseTo(0.7, 10);
    }
    scene.handle.frame(MID);
    for (const blob of scene.blobs) {
      expect(blob.material.emissiveIntensity).toBeCloseTo(
        0.7 + 0.5 * 0.55 + 0.5 * 0.25,
        10,
      );
    }
    scene.handle.frame(PEAK);
    for (const blob of scene.blobs) {
      expect(blob.material.emissiveIntensity).toBeCloseTo(
        0.7 + 0.55 + 0.25,
        10,
      );
    }
  });

  it("shifts blob colour warmer with respond while blue stays fixed", () => {
    const scene = buildScene();
    const bases = scene.blobs.map((blob) => ({
      r: blob.material.emissive.r,
      g: blob.material.emissive.g,
      b: blob.material.emissive.b,
    }));
    scene.handle.frame({ ...MID, respond: 0.5 });
    scene.blobs.forEach((blob, bi) => {
      const warmth = 0.5 * 0.15;
      const mat = blob.material;
      expect(mat.emissive.r).toBeCloseTo(Math.min(1, bases[bi].r + warmth), 10);
      expect(mat.emissive.g).toBeCloseTo(
        Math.min(1, bases[bi].g + warmth * 0.4),
        10,
      );
      expect(mat.emissive.b).toBeCloseTo(bases[bi].b, 10);
    });
  });

  it("clamps the hottest blob's red channel at exactly 1 at full respond", () => {
    const scene = buildScene();
    scene.handle.frame(PEAK);
    let saturated = false;
    for (const blob of scene.blobs) {
      expect(blob.material.emissive.r).toBeLessThanOrEqual(1);
      expect(blob.material.emissive.g).toBeLessThanOrEqual(1);
      if (blob.material.emissive.r === 1) saturated = true;
    }
    expect(saturated).toBe(true);
  });

  it("rides every bubble on a bounded sine and pins the swarm inside its ring", () => {
    const scene = buildScene();
    for (let step = 0; step <= 12; step += 1) {
      scene.handle.frame({
        ...MID,
        time: MID.time + step * 1.7,
        energy: step % 2,
      });
      const attr = scene.bubbles.geometry.attributes.position;
      expect(attr.needsUpdate).toBe(true);
      for (let vi = 0; vi < attr.count; vi += 1) {
        const x = attr.array[vi * 3];
        const y = attr.array[vi * 3 + 1];
        const z = attr.array[vi * 3 + 2];
        expect(y).toBeGreaterThanOrEqual(-0.85 - EPSILON);
        expect(y).toBeLessThanOrEqual(0.85 + EPSILON);
        expect(Math.hypot(x, z)).toBeLessThanOrEqual(0.82 + EPSILON);
      }
    }
  });

  it("mixes bubble opacity from energy and respond at the exact declared weights", () => {
    const scene = buildScene();
    scene.handle.frame(IDLE);
    expect(scene.bubbles.material.opacity).toBeCloseTo(0.4, 10);
    scene.handle.frame(MID);
    expect(scene.bubbles.material.opacity).toBeCloseTo(
      0.4 + 0.5 * 0.45 + 0.5 * 0.15,
      10,
    );
    scene.handle.frame(PEAK);
    expect(scene.bubbles.material.opacity).toBeCloseTo(0.4 + 0.45 + 0.15, 10);
  });

  it("accumulates a fixed 0.0035 rad of shell yaw per frame and pitches slowly", () => {
    const scene = buildScene();
    scene.handle.frame(IDLE);
    scene.handle.frame(MID);
    scene.handle.frame(PEAK);
    expect(scene.shell.rotation.y).toBeCloseTo(3 * 0.0035, 10);
    expect(scene.shell.rotation.x).toBeCloseTo(
      Math.sin(PEAK.time * 0.07) * 0.04,
      10,
    );
  });

  it("ignores listen and low: only time, energy and respond move anything", () => {
    const scene = buildScene();
    const snapshot = () =>
      JSON.stringify({
        blobs: scene.blobs.map((blob) => ({
          p: [blob.position.x, blob.position.y, blob.position.z],
          s: blob.scale.value,
          glow: blob.material.emissiveIntensity,
          rgb: [
            blob.material.emissive.r,
            blob.material.emissive.g,
            blob.material.emissive.b,
          ],
        })),
        bubbles: Array.from(scene.bubbles.geometry.attributes.position.array),
        opacity: scene.bubbles.material.opacity,
        pitch: scene.shell.rotation.x,
      });
    scene.handle.frame({
      time: 4,
      energy: 0.3,
      low: 0,
      listen: 0,
      respond: 0.2,
    });
    const baseline = snapshot();
    scene.handle.frame({
      time: 4,
      energy: 0.3,
      low: 1,
      listen: 1,
      respond: 0.2,
    });
    expect(snapshot()).toBe(baseline);
  });

  it("replays the same instant identically: positions never accumulate drift", () => {
    const scene = buildScene();
    scene.handle.frame({ ...PEAK, time: 7.3 });
    const first = scene.blobs.map((blob) => [
      blob.position.x,
      blob.position.y,
      blob.position.z,
    ]);
    scene.handle.frame({ ...IDLE, time: 100 });
    scene.handle.frame({ ...PEAK, time: 7.3 });
    scene.blobs.forEach((blob, bi) => {
      expect(blob.position.x).toBeCloseTo(first[bi][0], F32_PRECISION);
      expect(blob.position.y).toBeCloseTo(first[bi][1], F32_PRECISION);
      expect(blob.position.z).toBeCloseTo(first[bi][2], F32_PRECISION);
    });
  });
});

describe("lava dispose", () => {
  it("disposes every geometry and material and detaches everything it added", () => {
    const scene = buildScene();
    expect(scene.geometries).toHaveLength(9);
    expect(scene.materials).toHaveLength(9);

    scene.handle.dispose();

    for (const geometry of scene.geometries) {
      expect(geometry.disposed).toBe(true);
    }
    for (const material of scene.materials) {
      expect(material.disposed).toBe(true);
    }
    expect(scene.parent.children).toHaveLength(0);
  });
});
