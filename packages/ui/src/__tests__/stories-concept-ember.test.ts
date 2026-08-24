/**
 * Behavioral suite for the ember voice-orb concept. Drives the real
 * ConceptDescriptor/build/frame/dispose pipeline over a minimal faithful
 * WebGPU-module double — orb-kit documents concepts as fake-drivable at this
 * boundary — and pins the observed contract: child wiring order, the faceted
 * icosa perturbation, idle breath heat, time/energy animation with the heat
 * ceiling, the respond-flare hysteresis state machine, and full teardown.
 *
 * Lives under src/__tests__ (not stories/) because the package vitest lane and
 * tsconfig both collect only src/** — a suite inside stories/src never runs.
 */

import { describe, expect, it } from "vitest";
import { concept } from "../../stories/src/concepts/ember.ts";
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

  setRGB(r: number, g: number, b: number): void {
    this.r = r;
    this.g = g;
    this.b = b;
  }
}

class FakeVector3 {
  x = 0;
  y = 0;
  z = 0;

  fromBufferAttribute(attr: FakeBufferAttribute, i: number): this {
    this.x = attr.getX(i);
    this.y = attr.getY(i);
    this.z = attr.getZ(i);
    return this;
  }

  normalize(): this {
    const len = Math.hypot(this.x, this.y, this.z);
    if (len > 0) {
      this.x /= len;
      this.y /= len;
      this.z /= len;
    }
    return this;
  }

  multiplyScalar(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
}

class FakeBufferAttribute {
  readonly array: Float32Array;
  readonly itemSize: number;

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
  normalsComputed = false;
  disposed = false;

  setAttribute(name: string, attr: FakeBufferAttribute): void {
    this.attributes[name] = attr;
  }

  computeVertexNormals(): void {
    this.normalsComputed = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

// Single triangle: enough surface for the kit's real perturbation loop and
// per-face centroid bake to execute over genuine data.
class FakeIcosahedronGeometry extends FakeGeometry {
  constructor(radius: number, _detail: number) {
    super();
    this.attributes.position = new FakeBufferAttribute(
      new Float32Array([radius, 0, 0, 0, radius, 0, 0, 0, radius]),
      3,
    );
  }
}

class FakeWireframeGeometry extends FakeGeometry {
  readonly sourceGeometry: FakeGeometry;

  constructor(source: FakeGeometry) {
    super();
    this.sourceGeometry = source;
  }
}

class FakeMaterial {
  disposed = false;

  dispose(): void {
    this.disposed = true;
  }
}

class FakeStandardNodeMaterial extends FakeMaterial {
  color: FakeColor | null = null;
  emissive: FakeColor | null = null;
  emissiveIntensity = 0;
  flatShading = false;
  roughness = 0;
  metalness = 0;
  transparent = false;
  opacity = 1;
  depthWrite = true;
}

class FakeLineBasicNodeMaterial extends FakeMaterial {
  color: FakeColor | null = null;
  transparent = false;
  opacity = 1;
  depthWrite = true;
}

class FakePointsNodeMaterial extends FakeMaterial {
  color: FakeColor | null = null;
  transparent = false;
  depthWrite = true;
  blending: unknown = null;
  positionNode: unknown = null;
  colorNode: unknown = null;
  sizeNode: unknown = null;
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
  rotation = { x: 0, y: 0, z: 0 };
  scale = new FakeScale();
  frustumCulled = true;

  constructor(geometry: FakeGeometry, material: FakeMaterial) {
    this.geometry = geometry;
    this.material = material;
  }
}

class FakeMesh extends FakeObject3D {}
class FakeLineSegments extends FakeObject3D {}

class FakePoints extends FakeObject3D {
  declare material: FakePointsNodeMaterial;
}

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

interface TslNode {
  value?: number;
  mul(operand?: unknown): TslNode;
  add(operand?: unknown): TslNode;
  sub(operand?: unknown): TslNode;
  readonly x: TslNode;
  readonly y: TslNode;
  readonly z: TslNode;
}

// Lazy shader-node stand-in: concepts only compose nodes, they never evaluate
// them, so chaining shape is the entire contract.
function makeNode(value?: number): TslNode {
  const chain = (): TslNode => makeNode();
  return {
    value,
    mul: () => chain(),
    add: () => chain(),
    sub: () => chain(),
    get x(): TslNode {
      return chain();
    },
    get y(): TslNode {
      return chain();
    },
    get z(): TslNode {
      return chain();
    },
  };
}

const THREE_DOUBLE = {
  Color: FakeColor,
  Vector3: FakeVector3,
  BufferAttribute: FakeBufferAttribute,
  IcosahedronGeometry: FakeIcosahedronGeometry,
  BufferGeometry: FakeGeometry,
  WireframeGeometry: FakeWireframeGeometry,
  MeshStandardNodeMaterial: FakeStandardNodeMaterial,
  LineBasicNodeMaterial: FakeLineBasicNodeMaterial,
  PointsNodeMaterial: FakePointsNodeMaterial,
  Mesh: FakeMesh,
  LineSegments: FakeLineSegments,
  Points: FakePoints,
  AdditiveBlending: "additive",
};

const TSL_DOUBLE = {
  vec3: () => makeNode(),
  float: (v?: number) => makeNode(v),
  attribute: (_name: string, _type: string) => makeNode(),
  sin: (_n?: unknown) => makeNode(),
  cos: (_n?: unknown) => makeNode(),
};

function makeUniforms(): OrbUniforms {
  return {
    uTime: makeNode(0),
    uEnergy: makeNode(0),
    uLow: makeNode(0),
    uListen: makeNode(0),
    uRespond: makeNode(0),
    uAspect: makeNode(1),
    uAccent: makeNode(0),
  };
}

function buildConcept() {
  const parent = new FakeParent();
  const handle = concept.build(
    THREE_DOUBLE as unknown as WebGPUModule,
    TSL_DOUBLE as unknown as TSLModule,
    makeUniforms(),
    parent,
  );
  return { parent, handle };
}

function frameAt(time: number, overrides?: Partial<OrbFrame>): OrbFrame {
  return { time, energy: 0, low: 0, listen: 0, respond: 0, ...overrides };
}

// Breath minimum: sin(t * 0.7) = -1 puts heatBase at its 0.35 floor.
const T_FLAT = (3 * Math.PI) / (2 * 0.7);

describe("concepts/ember — orb lifecycle over a faithful WebGPU double", () => {
  it("catalogs the ember mood concept with a callable builder", () => {
    expect(concept.id).toBe("ember");
    expect(concept.label).toBe("ember");
    expect(concept.family).toBe("mood");
    expect(typeof concept.build).toBe("function");
  });

  it("wires body, crack wireframe, furnace core and recolored sparks onto the parent", () => {
    const { parent } = buildConcept();

    expect(parent.children).toHaveLength(4);
    const [body, cracks, core, sparks] = parent.children;

    expect(body).toBeInstanceOf(FakeMesh);
    expect(cracks).toBeInstanceOf(FakeLineSegments);
    expect(core).toBeInstanceOf(FakeMesh);
    expect(sparks).toBeInstanceOf(FakePoints);

    const bodyGeo = body.geometry as FakeIcosahedronGeometry;
    const wireGeo = cracks.geometry as FakeWireframeGeometry;
    expect(wireGeo).toBeInstanceOf(FakeWireframeGeometry);
    expect(wireGeo.sourceGeometry).toBe(bodyGeo);

    const bodyMat = body.material as FakeStandardNodeMaterial;
    expect(bodyMat.flatShading).toBe(true);

    const wireMat = cracks.material as FakeLineBasicNodeMaterial;
    expect(wireMat.transparent).toBe(true);
    expect(wireMat.depthWrite).toBe(false);

    expect((core.material as FakeStandardNodeMaterial).transparent).toBe(true);

    const sparkSeeds = sparks.geometry.attributes.aSeed;
    expect(sparkSeeds?.count).toBe(90);
    const sparkMat = (sparks as FakePoints).material;
    expect(sparkMat.blending).toBe("additive");
    expect(sparkMat.color?.r).toBeCloseTo(1.0, 12);
    expect(sparkMat.color?.g).toBeCloseTo(0.3, 12);
    expect(sparkMat.color?.b).toBeCloseTo(0.02, 12);
  });

  it("runs the kit's real facet perturbation and bakes per-face centers", () => {
    const { parent } = buildConcept();
    const geo = parent.children[0].geometry as FakeIcosahedronGeometry;
    const pos = geo.attributes.position;

    expect(geo.normalsComputed).toBe(true);

    // Vertex 0 normalizes to (1,0,0): lumps = sin(5.2)*0.5 + sin(0)*0.3 + sin(5.9)*0.2
    // Positions live in a Float32Array, so compare at f32 precision.
    const lumps = Math.sin(5.2) * 0.5 + Math.sin(5.9) * 0.2;
    expect(pos.getX(0)).toBe(Math.fround(1 + lumps * 0.1));
    expect(pos.getY(0)).toBe(0);
    expect(pos.getZ(0)).toBe(0);

    // The bake writes one centroid entry per vertex (all three share the
    // single face here).
    const centers = geo.attributes.aCenter;
    expect(centers?.count).toBe(3);
    const cx = (pos.getX(0) + pos.getX(1) + pos.getX(2)) / 3;
    if (!centers) throw new Error("aCenter not baked");
    expect(centers.getX(0)).toBeCloseTo(cx, 12);
    for (let v = 1; v < 3; v += 1) {
      expect(centers.getX(v)).toBe(centers.getX(0));
      expect(centers.getY(v)).toBe(centers.getY(0));
      expect(centers.getZ(v)).toBe(centers.getZ(0));
    }
  });

  it("idle frame at t=0 breathes at half heat with no flare", () => {
    const { handle, parent } = buildConcept();
    handle.frame(frameAt(0));

    const [body, cracks, core, sparks] = parent.children;
    const wireMat = cracks.material as FakeLineBasicNodeMaterial;
    const bodyMat = body.material as FakeStandardNodeMaterial;
    const coreMat = core.material as FakeStandardNodeMaterial;

    // heatBase = 0.35 + breath(0.5) * 0.25 = 0.475
    expect(wireMat.color?.r).toBeCloseTo(1.0, 12);
    expect(wireMat.color?.g).toBeCloseTo(0.18 + 0.475 * 0.47, 12);
    expect(wireMat.color?.b).toBeCloseTo(0.475 * 0.05, 12);
    expect(wireMat.opacity).toBeCloseTo(0.5 + 0.475 * 0.45, 12);

    expect(bodyMat.emissive?.r).toBeCloseTo(0.08 + 0.475 * 0.22, 12);
    expect(bodyMat.emissive?.g).toBeCloseTo(0.475 * 0.04, 12);
    expect(bodyMat.emissive?.b).toBe(0);
    expect(bodyMat.emissiveIntensity).toBeCloseTo(0.3 + 0.475 * 0.7, 12);

    expect(coreMat.emissive?.r).toBeCloseTo(0.4 + 0.475 * 0.55, 12);
    expect(coreMat.emissive?.g).toBeCloseTo(0.03 + 0.475 * 0.12, 12);
    expect(coreMat.emissiveIntensity).toBeCloseTo(0.8 + 0.475 * 1.4, 12);
    expect(coreMat.opacity).toBeCloseTo(0.55 + 0.475 * 0.3, 12);

    expect(body.scale.value).toBeCloseTo(1, 12);
    expect(cracks.scale.value).toBeCloseTo(1 * 1.001, 12);
    expect(core.scale.value).toBeCloseTo(0.9 + 0.475 * 0.15, 12);

    expect(body.rotation.x).toBe(0);
    expect(body.rotation.y).toBe(0);
    expect(cracks.rotation.x).toBe(body.rotation.x);
    expect(cracks.rotation.y).toBe(body.rotation.y);
    expect(core.rotation.x).toBe(0);
    // -time * 0.07 yields -0 at t=0.
    expect(core.rotation.y).toBeCloseTo(0, 12);
    expect(sparks.rotation.x).toBe(0);
    expect(sparks.rotation.y).toBe(0);
  });

  it("animates rotation from time and clamps heat at the ceiling", () => {
    const energy = 0.5;
    const { handle, parent } = buildConcept();
    handle.frame(frameAt(10, { energy }));

    const [body, cracks, core, sparks] = parent.children;

    expect(body.rotation.y).toBeCloseTo(10 * 0.04, 12);
    expect(body.rotation.x).toBeCloseTo(Math.sin(10 * 0.31) * 0.08, 12);
    expect(cracks.rotation.y).toBe(body.rotation.y);
    expect(cracks.rotation.x).toBe(body.rotation.x);
    expect(core.rotation.y).toBeCloseTo(-10 * 0.07, 12);
    expect(sparks.rotation.y).toBeCloseTo(10 * (0.05 + energy * 0.12), 12);
    expect(sparks.rotation.x).toBeCloseTo(Math.sin(10 * 0.18) * 0.2, 12);

    // heatBase(10) + energy*1.4 exceeds 1 -> every heat-driven output pins.
    const wireMat = cracks.material as FakeLineBasicNodeMaterial;
    const bodyMat = body.material as FakeStandardNodeMaterial;
    const coreMat = core.material as FakeStandardNodeMaterial;

    expect(wireMat.color?.g).toBeCloseTo(0.65, 12);
    expect(wireMat.color?.b).toBeCloseTo(0.05, 12);
    expect(wireMat.opacity).toBeCloseTo(0.95, 12);
    expect(bodyMat.emissive?.r).toBeCloseTo(0.3, 12);
    expect(bodyMat.emissiveIntensity).toBeCloseTo(1.0, 12);
    expect(coreMat.emissive?.r).toBeCloseTo(0.95, 12);
    expect(coreMat.emissive?.g).toBeCloseTo(0.15, 12);
    expect(coreMat.emissiveIntensity).toBeCloseTo(2.2, 12);
    expect(coreMat.opacity).toBeCloseTo(0.85, 12);

    expect(body.scale.value).toBeCloseTo(1 + energy * 0.06, 12);
    expect(cracks.scale.value).toBeCloseTo((1 + energy * 0.06) * 1.001, 12);
    expect(core.scale.value).toBeCloseTo(1.05, 12);
  });

  it("respond above 0.7 spikes heat; exactly 0.7 never fires", () => {
    const spiked = buildConcept();
    spiked.handle.frame(frameAt(0));
    spiked.handle.frame(frameAt(0, { respond: 0.9 }));
    const wireMatSpiked = spiked.parent.children[1]
      .material as FakeLineBasicNodeMaterial;
    expect(wireMatSpiked.opacity).toBeCloseTo(0.95, 12);

    const held = buildConcept();
    held.handle.frame(frameAt(0));
    const wireMatHeld = held.parent.children[1]
      .material as FakeLineBasicNodeMaterial;
    const idleOpacity = wireMatHeld.opacity;
    for (let i = 0; i < 3; i += 1) {
      held.handle.frame(frameAt(0, { respond: 0.7 }));
      expect(wireMatHeld.opacity).toBe(idleOpacity);
    }
  });

  it("sustained responding re-arms the flare after decay, sawtoothing heat", () => {
    const { handle, parent } = buildConcept();
    const wireMat = parent.children[1].material as FakeLineBasicNodeMaterial;
    const f = frameAt(T_FLAT, { respond: 0.9 });

    const ops: number[] = [];
    for (let i = 0; i < 80; i += 1) {
      handle.frame(f);
      ops.push(wireMat.opacity);
    }

    expect(ops[0]).toBeCloseTo(0.95, 12);
    expect(Math.min(...ops)).toBeLessThan(0.94);
    expect(ops[79]).toBeCloseTo(0.95, 12);
  });

  it("flare decays back to the exact idle baseline after respond releases", () => {
    const { handle, parent } = buildConcept();
    const wireMat = parent.children[1].material as FakeLineBasicNodeMaterial;
    handle.frame(frameAt(T_FLAT));
    const idleOpacity = wireMat.opacity;

    handle.frame(frameAt(T_FLAT, { respond: 0.9 }));
    expect(wireMat.opacity).toBeCloseTo(0.95, 12);

    handle.frame(frameAt(T_FLAT));
    expect(wireMat.opacity).toBeGreaterThan(idleOpacity);

    for (let i = 0; i < 200; i += 1) {
      handle.frame(frameAt(T_FLAT));
    }
    expect(wireMat.opacity).toBe(idleOpacity);
  });

  it("dispose releases every geometry and material and empties the parent", () => {
    const { handle, parent } = buildConcept();
    const [body, cracks, core, sparks] = parent.children;
    const wireGeo = cracks.geometry as FakeWireframeGeometry;

    handle.dispose();

    expect(parent.children).toHaveLength(0);
    expect(body.geometry.disposed).toBe(true);
    expect(body.material.disposed).toBe(true);
    expect(wireGeo.disposed).toBe(true);
    expect(cracks.material.disposed).toBe(true);
    expect(core.geometry.disposed).toBe(true);
    expect(core.material.disposed).toBe(true);
    expect(sparks.geometry.disposed).toBe(true);
    expect(sparks.material.disposed).toBe(true);
  });
});
