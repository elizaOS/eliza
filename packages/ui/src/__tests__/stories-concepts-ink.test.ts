/**
 * Behavioral suite for the ink voice-orb concept. Drives the real
 * ConceptDescriptor/build/frame/dispose pipeline over a minimal faithful
 * WebGPU-module double — orb-kit documents concepts as fake-drivable at this
 * boundary — and pins the observed contract: body/cloud/seal child wiring,
 * the 220-particle charcoal buffer, idle/time/energy frame state including
 * the per-particle orbit-radius breath ratio, the respond-driven seal pulse,
 * and full resource teardown.
 *
 * Lives under src/__tests__ (not stories/) because the package vitest lane and
 * tsconfig both collect only src/** — a suite inside stories/src never runs.
 *
 * The concept seeds its particles from Math.random() at build time, so every
 * assertion is seed-independent by construction: closed-form formulas that do
 * not involve the random phase/speed/y-band/base-ring draws, per-particle
 * relational ratios between two frames of the same build, and bounded ranges
 * derived from the documented random intervals.
 */

import { describe, expect, it } from "vitest";
import { concept } from "../../stories/src/concepts/ink.ts";
import type {
  OrbFrame,
  OrbUniforms,
  TSLModule,
  WebGPUModule,
} from "../../stories/src/orb-kit.ts";

class FakeColor {
  r: number;
  g: number;
  b: number;

  constructor(r = 0, g = 0, b = 0) {
    this.r = r;
    this.g = g;
    this.b = b;
  }
}

class FakeBufferAttribute {
  readonly array: Float32Array;
  readonly itemSize: number;
  needsUpdate = false;

  constructor(array: Float32Array, itemSize: number) {
    this.array = array;
    this.itemSize = itemSize;
  }

  get count(): number {
    return this.array.length / this.itemSize;
  }

  getX(i: number): number {
    return this.array[i * this.itemSize];
  }

  getY(i: number): number {
    return this.array[i * this.itemSize + 1];
  }

  getZ(i: number): number {
    return this.array[i * this.itemSize + 2];
  }

  setXYZ(i: number, x: number, y: number, z: number): void {
    const o = i * this.itemSize;
    this.array[o] = x;
    this.array[o + 1] = y;
    this.array[o + 2] = z;
  }
}

class FakeGeometry {
  attributes: Record<string, FakeBufferAttribute> = {};
  disposed = false;

  setAttribute(name: string, attr: FakeBufferAttribute): void {
    this.attributes[name] = attr;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeMaterial {
  disposed = false;

  dispose(): void {
    this.disposed = true;
  }
}

class FakeMeshStandardNodeMaterial extends FakeMaterial {
  color: FakeColor | null = null;
  emissive: FakeColor | null = null;
  emissiveIntensity = 0;
  roughness = 0;
  metalness = 0;
}

class FakePointsNodeMaterial extends FakeMaterial {
  color: FakeColor | null = null;
  transparent = false;
  opacity = 1;
  depthWrite = true;
  blending: unknown = null;
  size = 0;
  sizeAttenuation = false;
}

class FakePosition {
  x = 0;
  y = 0;
  z = 0;

  set(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

class FakeScale {
  value = 1;

  setScalar(s: number): void {
    this.value = s;
  }
}

class FakeObject3D {
  geometry: FakeGeometry;
  material: FakeMaterial;
  position = new FakePosition();
  rotation = { x: 0, y: 0, z: 0 };
  scale = new FakeScale();
  frustumCulled = true;

  constructor(geometry: FakeGeometry, material: FakeMaterial) {
    this.geometry = geometry;
    this.material = material;
  }
}

class FakeMesh extends FakeObject3D {}
class FakePoints extends FakeObject3D {}

class FakeParent {
  children: FakeObject3D[] = [];

  add(child: FakeObject3D): void {
    this.children.push(child);
  }

  remove(child: FakeObject3D): void {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
  }
}

const THREE_DOUBLE = {
  Color: FakeColor,
  SphereGeometry: FakeGeometry,
  BufferGeometry: FakeGeometry,
  BufferAttribute: FakeBufferAttribute,
  MeshStandardNodeMaterial: FakeMeshStandardNodeMaterial,
  PointsNodeMaterial: FakePointsNodeMaterial,
  Mesh: FakeMesh,
  Points: FakePoints,
  NormalBlending: "normal",
};

function makeUniforms(): OrbUniforms {
  // The concept never reads the uniforms; an empty frozen node satisfies
  // every `any`-typed slot in OrbUniforms without reaching for `any` itself.
  const node: Record<string, never> = {};
  return {
    uTime: node,
    uEnergy: node,
    uLow: node,
    uListen: node,
    uRespond: node,
    uAspect: node,
    uAccent: node,
  };
}

interface BuiltInk {
  parent: FakeParent;
  handle: { frame: (f: OrbFrame) => void; dispose: () => void };
  body: FakeMesh;
  cloud: FakePoints;
  seal: FakeMesh;
  cloudPositions: FakeBufferAttribute;
}

/** Random-interval contracts the concept documents in its own seed block. */
const BASE_RING_MIN = 0.88;
const BASE_RING_MAX = 0.88 + 0.38;
const Y_BAND_MAX = 1.1;
const PY_AMPLITUDE = 0.11;

function buildInk(): BuiltInk {
  const parent = new FakeParent();
  const handle = concept.build(
    THREE_DOUBLE as unknown as WebGPUModule,
    {} as unknown as TSLModule,
    makeUniforms(),
    parent,
  );
  expect(parent.children).toHaveLength(3);
  const [body, cloud, seal] = parent.children;
  return {
    parent,
    handle,
    body: body as FakeMesh,
    cloud: cloud as FakePoints,
    seal: seal as FakeMesh,
    cloudPositions: (cloud.geometry as FakeGeometry).attributes.position,
  };
}

function frameAt(
  time: number,
  overrides?: Partial<Omit<OrbFrame, "time">>,
): OrbFrame {
  return { time, energy: 0, low: 0, listen: 0, respond: 0, ...overrides };
}

/** Horizontal orbit radius sqrt(x²+z²) of one stored particle position. */
function ringRadius(attr: FakeBufferAttribute, i: number): number {
  return Math.hypot(attr.getX(i), attr.getZ(i));
}

describe("concepts/ink — orb lifecycle over a faithful WebGPU double", () => {
  it("catalogs the ink artful concept with a callable builder", () => {
    expect(concept.id).toBe("ink");
    expect(concept.label).toBe("ink");
    expect(concept.family).toBe("artful");
    expect(typeof concept.build).toBe("function");
  });

  it("wires body sphere, ink cloud points and hanko seal onto the parent", () => {
    const { body, cloud, cloudPositions, seal } = buildInk();

    expect(body).toBeInstanceOf(FakeMesh);
    expect(cloud).toBeInstanceOf(FakePoints);
    expect(seal).toBeInstanceOf(FakeMesh);

    // Body: soft matte near-black sphere.
    const bodyMat = body.material as FakeMeshStandardNodeMaterial;
    expect(bodyMat.color?.r).toBeCloseTo(0.045, 12);
    expect(bodyMat.color?.g).toBeCloseTo(0.045, 12);
    expect(bodyMat.color?.b).toBeCloseTo(0.05, 12);
    expect(bodyMat.roughness).toBeCloseTo(0.92, 12);
    expect(bodyMat.metalness).toBe(0);
    expect(bodyMat.emissiveIntensity).toBe(0);

    // Cloud: unculled charcoal points on a 220-slot position buffer that is
    // allocated empty — particle state lives in private data until framed.
    expect(cloud.frustumCulled).toBe(false);
    expect(cloudPositions.count).toBe(220);
    expect(cloudPositions.itemSize).toBe(3);
    expect(cloudPositions.needsUpdate).toBe(false);
    let nonZeroSlots = 0;
    for (let slot = 0; slot < cloudPositions.array.length; slot += 1) {
      if (cloudPositions.array[slot] !== 0) nonZeroSlots += 1;
    }
    expect(nonZeroSlots).toBe(0);
    const cloudMat = cloud.material as FakePointsNodeMaterial;
    expect(cloudMat.transparent).toBe(true);
    expect(cloudMat.opacity).toBeCloseTo(0.6, 12);
    expect(cloudMat.depthWrite).toBe(false);
    expect(cloudMat.blending).toBe(THREE_DOUBLE.NormalBlending);
    expect(cloudMat.size).toBeCloseTo(0.03, 12);
    expect(cloudMat.sizeAttenuation).toBe(true);
    expect(cloudMat.color?.r).toBeCloseTo(0.1, 12);
    expect(cloudMat.color?.g).toBeCloseTo(0.1, 12);
    expect(cloudMat.color?.b).toBeCloseTo(0.13, 12);

    // Seal: deep vermilion stamp offset to the lower-right of the face.
    expect(seal.position.x).toBeCloseTo(0.62, 12);
    expect(seal.position.y).toBeCloseTo(-0.52, 12);
    expect(seal.position.z).toBeCloseTo(0.42, 12);
    const sealMat = seal.material as FakeMeshStandardNodeMaterial;
    expect(sealMat.color?.r).toBeCloseTo(0.78, 12);
    expect(sealMat.color?.g).toBeCloseTo(0.1, 12);
    expect(sealMat.color?.b).toBeCloseTo(0.07, 12);
    expect(sealMat.emissive?.r).toBeCloseTo(0.7, 12);
    expect(sealMat.emissive?.g).toBeCloseTo(0.06, 12);
    expect(sealMat.emissive?.b).toBeCloseTo(0.04, 12);
    expect(sealMat.emissiveIntensity).toBeCloseTo(0.25, 12);
    expect(sealMat.roughness).toBeCloseTo(0.45, 12);
    expect(sealMat.metalness).toBeCloseTo(0.05, 12);
  });

  it("idle frame writes every particle onto its base ring and marks the buffer dirty", () => {
    const { handle, cloud, cloudPositions } = buildInk();

    handle.frame(frameAt(0));

    // The concept must have flagged the GPU buffer for re-upload.
    expect(cloudPositions.needsUpdate).toBe(true);

    // At t=0, energy=0 the orbit angle is the pure random phase and the ring
    // radius equals the raw draw, so every particle satisfies
    // baseRing ∈ [0.88, 1.26] and |y| ≤ 1.1 + 0.11 regardless of the seed.
    for (let i = 0; i < cloudPositions.count; i += 1) {
      const r = ringRadius(cloudPositions, i);
      expect(r).toBeGreaterThanOrEqual(BASE_RING_MIN - 1e-6);
      expect(r).toBeLessThanOrEqual(BASE_RING_MAX + 1e-6);
      expect(Math.abs(cloudPositions.getY(i))).toBeLessThanOrEqual(
        Y_BAND_MAX + PY_AMPLITUDE + 1e-6,
      );
    }
    // Idle pose holds every animated channel at its rest value.
    expect(cloud.rotation.y).toBe(0);
    expect((cloud.material as FakePointsNodeMaterial).opacity).toBeCloseTo(
      0.6,
      12,
    );
    expect(handle).toBeDefined();
  });

  it("breathes the whole cloud outward by exactly 1 + energy * 0.55 per particle", () => {
    const { handle, body, cloudPositions } = buildInk();

    handle.frame(frameAt(0));
    const idleRadii: number[] = [];
    for (let i = 0; i < cloudPositions.count; i += 1) {
      idleRadii.push(ringRadius(cloudPositions, i));
    }

    handle.frame(frameAt(0, { energy: 0.5 }));

    // Same build, same phases: the only change is the multiplicative breath
    // factor, so each particle's horizontal radius scales by 1.275 exactly.
    const breathe = 1 + 0.5 * 0.55;
    for (let i = 0; i < cloudPositions.count; i += 1) {
      expect(
        ringRadius(cloudPositions, i) / (idleRadii[i] as number),
      ).toBeCloseTo(breathe, 5);
    }
    // The body swells with the same energy on its own gentler curve.
    expect(body.scale.value).toBeCloseTo(1 + 0.5 * 0.07, 12);
  });

  it("animates rotations and the seal bob from time alone", () => {
    const { handle, body, cloud, seal } = buildInk();

    handle.frame(frameAt(2));

    expect(body.rotation.y).toBeCloseTo(2 * 0.045, 12);
    expect(body.rotation.x).toBeCloseTo(Math.sin(2 * 0.032) * 0.06, 12);
    expect(body.scale.value).toBe(1);
    expect(cloud.rotation.y).toBeCloseTo(2 * 0.018, 12);
    // Seal bobs around its resting lower-right mount.
    expect(seal.position.y).toBeCloseTo(-0.52 + Math.sin(2 * 0.5) * 0.025, 12);
    // With no respond the stamp brightness stays at its 0.25 floor even
    // though the sine carrier is running.
    expect(
      (seal.material as FakeMeshStandardNodeMaterial).emissiveIntensity,
    ).toBeCloseTo(0.25, 12);
  });

  it("lifts seal emissive along the respond ramp with the time carrier on top", () => {
    const { handle, seal } = buildInk();
    const sealMat = seal.material as FakeMeshStandardNodeMaterial;

    // t where sin(t * 1.8) peaks at 1: the carrier contributes respond * 0.06.
    const tPeak = Math.PI / (2 * 1.8);

    handle.frame(frameAt(tPeak, { respond: 1 }));
    expect(sealMat.emissiveIntensity).toBeCloseTo(0.25 + 0.6 + 0.06, 12);

    handle.frame(frameAt(tPeak, { respond: 0.5 }));
    expect(sealMat.emissiveIntensity).toBeCloseTo(0.25 + 0.3 + 0.03, 12);
  });

  it("dispose releases both geometries and both materials plus the cloud pair and empties the parent", () => {
    const { parent, handle, body, cloud, seal } = buildInk();
    const resources = [
      body.geometry,
      body.material,
      cloud.geometry,
      cloud.material,
      seal.geometry,
      seal.material,
    ];

    handle.dispose();

    for (const resource of resources) {
      expect((resource as FakeMaterial).disposed).toBe(true);
    }
    expect(parent.children).toHaveLength(0);
  });
});
