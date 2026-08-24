/**
 * Behaviour tests for the liquid-metal voice-orb concept
 * (`stories/src/concepts/liquidmetal.ts`), driven through the injected
 * three/webgpu + three/tsl module surfaces the orb-kit harness hands every
 * concept builder. Covers the descriptor contract, scene assembly (one
 * chrome sphere retuned from the orb-kit gem default to a smooth mirror),
 * the voice-reactive fresnel rim wired through the live uniforms, per-frame
 * churn (purely radial displacement, amplitude envelope, energy-linear idle
 * wobble, respond-threshold crest sharpening with its exact 0.01 boundary,
 * normal recompute + dirty flag, yaw/pitch drift, insensitivity to
 * `listen`/`low`, replay determinism), and full teardown on dispose. The
 * doubles record calls and evaluate lazily; every expectation is recomputed
 * here, never read back from the subject.
 */

import { describe, expect, it } from "vitest";
import { concept } from "../../stories/src/concepts/liquidmetal";

const EPSILON = 1e-6;

// Declared in liquidmetal.ts: ±0.12 max displacement, amplitude driven by
// amp = MAX_DISP * (0.3 + energy*0.9 + respond*0.35), whose worst case at
// full energy + full respond is 0.12 * 1.55.
const BASE_RADIUS = 0.95;
const SPHERE_VERTICES = (48 + 1) * (32 + 1);
const AMPLITUDE_WORST_CASE = 0.12 * (0.3 + 0.9 + 0.35);

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
}

class FakeGeometry {
  attributes: Record<string, FakeBufferAttribute> = {};
  normalsComputed = 0;
  disposed = false;
  setAttribute(name: string, attribute: FakeBufferAttribute): void {
    this.attributes[name] = attribute;
  }
  computeVertexNormals(): void {
    this.normalsComputed += 1;
  }
  dispose(): void {
    this.disposed = true;
  }
}

/**
 * Genuine UV-sphere vertex grid: every vertex sits exactly on the requested
 * radius, laid out as (heightSegments+1) rows x (widthSegments+1) columns.
 */
class FakeSphereGeometry extends FakeGeometry {
  radius: number;
  widthSegments: number;
  heightSegments: number;
  constructor(radius: number, widthSegments: number, heightSegments: number) {
    super();
    this.radius = radius;
    this.widthSegments = widthSegments;
    this.heightSegments = heightSegments;
    const rows = heightSegments + 1;
    const cols = widthSegments + 1;
    const positions = new Float32Array(rows * cols * 3);
    let cursor = 0;
    for (let iy = 0; iy < rows; iy += 1) {
      const v = iy / heightSegments;
      const theta = v * Math.PI;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);
      for (let ix = 0; ix < cols; ix += 1) {
        const u = ix / widthSegments;
        const phi = u * Math.PI * 2;
        positions[cursor] = -radius * sinTheta * Math.cos(phi);
        positions[cursor + 1] = radius * cosTheta;
        positions[cursor + 2] = radius * sinTheta * Math.sin(phi);
        cursor += 3;
      }
    }
    this.setAttribute("position", new FakeBufferAttribute(positions, 3));
  }
}

class FakeMaterial {
  color = new FakeColor();
  flatShading = false;
  roughness = 1;
  metalness = 0;
  envMapIntensity = 1;
  emissiveNode: RimNode | null = null;
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

class FakeObject3D {
  geometry: FakeGeometry;
  material: FakeMaterial;
  rotation: Vector3Like = { x: 0, y: 0, z: 0 };
  constructor(geometry: FakeGeometry, material: FakeMaterial) {
    this.geometry = geometry;
    this.material = material;
  }
}

// --- Minimal lazy-evaluating TSL surface -----------------------------------
//
// The rim-light expression only needs scalar algebra over constants and two
// live uniforms (`uAccent`, `uRespond`); view vectors enter the dot product
// as fixed scalar leaves. Nodes evaluate on read, so mutating a uniform's
// `.value` after build re-prices the whole graph — the same live-binding
// contract the harness relies on when it updates uniforms each frame.

type RimInput = RimNode | number;

function toRim(input: RimInput): RimNode {
  return input instanceof RimNode ? input : RimNode.of(() => input);
}

class RimNode {
  private readonly evaluate: () => number;
  private readonly box?: { value: number };
  constructor(evaluate: () => number, box?: { value: number }) {
    this.evaluate = evaluate;
    this.box = box;
  }
  static of(evaluate: () => number): RimNode {
    return new RimNode(evaluate);
  }
  get value(): number {
    return this.box ? this.box.value : this.evaluate();
  }
  set value(next: number) {
    if (!this.box) {
      throw new Error("only uniform nodes accept live writes");
    }
    this.box.value = next;
  }
  mul(other: RimInput): RimNode {
    const o = toRim(other);
    return RimNode.of(() => this.value * o.value);
  }
  add(other: RimInput): RimNode {
    const o = toRim(other);
    return RimNode.of(() => this.value + o.value);
  }
  abs(): RimNode {
    return RimNode.of(() => Math.abs(this.value));
  }
  oneMinus(): RimNode {
    return RimNode.of(() => 1 - this.value);
  }
  pow(exponent: RimInput): RimNode {
    const e = toRim(exponent);
    return RimNode.of(() => this.value ** e.value);
  }
  dot(other: RimInput): RimNode {
    return this.mul(other);
  }
}

/** A node whose price is read from a mutable box — the harness uniform. */
function rimUniform(initial: number): RimNode {
  const box = { value: initial };
  return new RimNode(() => box.value, box);
}

function makeTslModule(normalViewLeaf: number, viewDirLeaf: number) {
  return {
    vec3: (..._components: number[]): RimNode => RimNode.of(() => Number.NaN),
    float: (x: number): RimNode => RimNode.of(() => x),
    mix: (_a: RimInput, _b: RimInput, _t: RimInput): RimNode =>
      RimNode.of(() => Number.NaN),
    normalView: RimNode.of(() => normalViewLeaf),
    positionViewDirection: RimNode.of(() => viewDirLeaf),
  };
}

function makeThreeModule() {
  const sphereGeometries: FakeSphereGeometry[] = [];
  const materials: FakeMaterial[] = [];
  const objects: FakeObject3D[] = [];
  const THREE = {
    SphereGeometry: class extends FakeSphereGeometry {
      constructor(...args: ConstructorParameters<typeof FakeSphereGeometry>) {
        super(...args);
        sphereGeometries.push(this);
      }
    },
    Color: FakeColor,
    MeshPhysicalNodeMaterial: class extends FakeMaterial {
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
  };
  return { THREE, sphereGeometries, materials, objects };
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

/** Scalar stand-ins for the vec3 accent colour / respond uniform pair. */
const NORMAL_VIEW_LEAF = 0.62;
const VIEW_DIRECTION_LEAF = 1;
const FRESNEL_AT_LEAVES = (1 - NORMAL_VIEW_LEAF * VIEW_DIRECTION_LEAF) ** 3;

function buildScene(accentInitial = 1, respondInitial = 0) {
  const { THREE, sphereGeometries, materials, objects } = makeThreeModule();
  const parent = makeParent();
  const uAccent = rimUniform(accentInitial);
  const uRespond = rimUniform(respondInitial);
  const handle = concept.build(
    THREE,
    makeTslModule(NORMAL_VIEW_LEAF, VIEW_DIRECTION_LEAF),
    {
      uTime: null,
      uEnergy: null,
      uLow: null,
      uListen: null,
      uRespond,
      uAspect: null,
      uAccent,
    },
    parent,
  );
  const mesh = parent.children[0] as FakeObject3D;
  const positionAttr = (mesh.geometry as FakeSphereGeometry).attributes
    .position;
  const basePositions = Array.from(positionAttr.array);
  return {
    handle,
    parent,
    mesh,
    positionAttr,
    basePositions,
    materials,
    objects,
    sphereGeometries,
    uAccent,
    uRespond,
  };
}

type Scene = ReturnType<typeof buildScene>;

/** Signed radial and tangential displacement of one vertex after a frame. */
function radialDecomposition(
  scene: Scene,
  i: number,
): { radial: number; tangential: number } {
  const bx = scene.basePositions[i * 3];
  const by = scene.basePositions[i * 3 + 1];
  const bz = scene.basePositions[i * 3 + 2];
  const len = Math.sqrt(bx * bx + by * by + bz * bz);
  const dx = bx / len;
  const dy = by / len;
  const dz = bz / len;
  const px = scene.positionAttr.array[i * 3];
  const py = scene.positionAttr.array[i * 3 + 1];
  const pz = scene.positionAttr.array[i * 3 + 2];
  const ex = px - bx;
  const ey = py - by;
  const ez = pz - bz;
  const radial = ex * dx + ey * dy + ez * dz;
  const cx = ey * dz - ez * dy;
  const cy = ez * dx - ex * dz;
  const cz = ex * dy - ey * dx;
  const tangential = Math.sqrt(cx * cx + cy * cy + cz * cz);
  return { radial, tangential };
}

describe("liquidmetal concept descriptor", () => {
  it("registers under the liquidmetal id with the abstract family and a callable builder", () => {
    expect(concept.id).toBe("liquidmetal");
    expect(concept.label).toBe("liquid");
    expect(concept.family).toBe("abstract");
    expect(typeof concept.build).toBe("function");
  });
});

describe("liquidmetal build: scene assembly", () => {
  it("adds exactly one chrome sphere mesh to the parent at the declared tessellation", () => {
    const scene = buildScene();
    expect(scene.parent.children).toHaveLength(1);
    expect(scene.objects).toHaveLength(1);
    expect(scene.sphereGeometries).toHaveLength(1);
    const geo = scene.mesh.geometry as FakeSphereGeometry;
    expect(geo.radius).toBeCloseTo(BASE_RADIUS, 10);
    expect(geo.widthSegments).toBe(48);
    expect(geo.heightSegments).toBe(32);
    expect(scene.positionAttr.itemSize).toBe(3);
    expect(scene.positionAttr.count).toBe(SPHERE_VERTICES);
    // Every seeded vertex sits on the requested sphere.
    for (let i = 0; i < scene.positionAttr.count; i += 1) {
      const x = scene.positionAttr.getX(i);
      const y = scene.positionAttr.getY(i);
      const z = scene.positionAttr.getZ(i);
      expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(BASE_RADIUS, 5);
    }
  });

  it("retunes the kit chrome-gem material into a smooth mirror finish", () => {
    const scene = buildScene();
    expect(scene.materials).toHaveLength(1);
    const mat = scene.mesh.material;
    // makeChromeGem seeds flatShading=true / roughness=0.18 — the concept
    // overrides them for the liquid-mirror look:
    expect(mat.flatShading).toBe(false);
    expect(mat.roughness).toBeCloseTo(0.03, 10);
    expect(mat.metalness).toBe(1);
    expect(mat.envMapIntensity).toBeCloseTo(1.8, 10);
    expect(mat.color.r).toBeCloseTo(0.95, 10);
    expect(mat.color.g).toBeCloseTo(0.97, 10);
    expect(mat.color.b).toBeCloseTo(1.0, 10);
  });

  it("wires a fresnel rim light that re-prices live with uAccent and uRespond", () => {
    const scene = buildScene();
    const rim = scene.mesh.material.emissiveNode;
    expect(rim).not.toBeNull();
    const restGlow = rim?.value ?? 0;
    expect(restGlow).toBeCloseTo(1 * FRESNEL_AT_LEAVES * (0.08 + 0 * 0.55), 12);
    // Live binding: raising respond brightens the rim by exactly the
    // declared (0.08 + 0.55*respond)/0.08 factor...
    scene.uRespond.value = 1;
    expect(rim?.value).toBeCloseTo(restGlow * ((0.08 + 0.55) / 0.08), 12);
    // ...and the accent scales it linearly.
    scene.uRespond.value = 0;
    scene.uAccent.value = 2.5;
    expect(rim?.value).toBeCloseTo(restGlow * 2.5, 12);
  });
});

describe("liquidmetal frame animation", () => {
  const IDLE = { time: 0, energy: 0, low: 0, listen: 0, respond: 0 };
  const MID = { time: 4.2, energy: 0.5, low: 0.25, listen: 1, respond: 0.5 };
  const PEAK = { time: 9, energy: 1, low: 0, listen: 0, respond: 1 };

  it("moves every vertex strictly along its own radial direction", () => {
    const scene = buildScene();
    const beats = [IDLE, MID, PEAK, { ...IDLE, time: 100 }];
    for (let step = 0; step <= 8; step += 1) {
      const beat = beats[step % beats.length];
      scene.handle.frame({ ...beat, time: beat.time + step * 1.3 });
      for (let i = 0; i < scene.positionAttr.count; i += 1) {
        const { tangential } = radialDecomposition(scene, i);
        expect(tangential).toBeLessThan(1e-5);
      }
    }
  });

  it("keeps every vertex inside the declared amplitude envelope while staying alive at idle", () => {
    const scene = buildScene();
    const beats = [IDLE, MID, PEAK, { ...PEAK, energy: 1, respond: 1 }];
    let idleMaxDisplacement = 0;
    for (let step = 0; step <= 16; step += 1) {
      const beat = beats[step % beats.length];
      scene.handle.frame({ ...beat, time: beat.time + step * 0.9 });
      for (let i = 0; i < scene.positionAttr.count; i += 1) {
        const { radial } = radialDecomposition(scene, i);
        const magnitude = Math.abs(radial);
        expect(magnitude).toBeLessThanOrEqual(AMPLITUDE_WORST_CASE + EPSILON);
        if (beat.energy === 0 && beat.respond === 0) {
          idleMaxDisplacement = Math.max(idleMaxDisplacement, magnitude);
        }
      }
    }
    // The mercury blob undulates even with the mic silent.
    expect(idleMaxDisplacement).toBeGreaterThan(0.001);
  });

  it("scales the idle wobble linearly with energy at a frozen clock", () => {
    const quiet = buildScene();
    quiet.handle.frame({ ...IDLE, energy: 0 });
    const loud = buildScene();
    loud.handle.frame({ ...IDLE, energy: 0.5 });
    // Amplitude ratio (0.3 + 0.5*0.9)/(0.3 + 0) = 2.5 must hold per vertex.
    const expectedRatio = (0.3 + 0.5 * 0.9) / 0.3;
    let significant = 0;
    for (let i = 0; i < quiet.positionAttr.count; i += 1) {
      const base = radialDecomposition(quiet, i).radial;
      if (Math.abs(base) < 1e-3) continue;
      significant += 1;
      const boosted = radialDecomposition(loud, i).radial;
      expect(boosted / base).toBeCloseTo(expectedRatio, 2);
    }
    expect(significant).toBeGreaterThan(SPHERE_VERTICES / 2);
  });

  it("sharpens crests past the linear amplitude gain once respond crosses its threshold", () => {
    const raw = buildScene();
    raw.handle.frame({ ...IDLE, respond: 0 });
    const spiked = buildScene();
    spiked.handle.frame({ ...IDLE, respond: 0.5 });
    // Amplitude alone would scale every displacement by (0.475/0.3).
    const amplitudeRatio = (0.3 + 0.5 * 0.35) / 0.3;
    let amplifiedBeyondAmplitude = 0;
    for (let i = 0; i < raw.positionAttr.count; i += 1) {
      const before = radialDecomposition(raw, i).radial;
      if (Math.abs(before) < 1e-4) continue;
      const after = radialDecomposition(spiked, i).radial;
      // Crest sharpening never flips a ripple's phase...
      expect(Math.sign(after)).toBe(Math.sign(before));
      if (after > before * amplitudeRatio * (1 + 1e-3)) {
        amplifiedBeyondAmplitude += 1;
      }
    }
    // ...and the power curve pushes crests beyond what amplitude alone does.
    expect(amplifiedBeyondAmplitude).toBeGreaterThan(0);
  });

  it("leaves sub-threshold respond unsharpened: 0.01 tracks pure amplitude scaling", () => {
    const raw = buildScene();
    raw.handle.frame({ ...IDLE, respond: 0 });
    const boundary = buildScene();
    boundary.handle.frame({ ...IDLE, respond: 0.01 });
    const amplitudeRatio = (0.3 + 0.01 * 0.35) / 0.3;
    for (let i = 0; i < raw.positionAttr.count; i += 1) {
      const before = radialDecomposition(raw, i).radial;
      if (Math.abs(before) < 1e-3) continue;
      const after = radialDecomposition(boundary, i).radial;
      expect(after / before).toBeCloseTo(amplitudeRatio, 2);
    }
  });

  it("marks the position attribute dirty and recomputes normals on every frame", () => {
    const scene = buildScene();
    const geo = scene.mesh.geometry as FakeSphereGeometry;
    expect(geo.normalsComputed).toBe(0);
    expect(scene.positionAttr.needsUpdate).toBe(false);
    for (let frameIndex = 1; frameIndex <= 5; frameIndex += 1) {
      scene.handle.frame({ ...MID, time: MID.time + frameIndex });
      expect(scene.positionAttr.needsUpdate).toBe(true);
      expect(geo.normalsComputed).toBe(frameIndex);
    }
  });

  it("drifts yaw linearly with time while pitching on a bounded slow sine", () => {
    const scene = buildScene();
    const t = 13.7;
    scene.handle.frame({ ...MID, time: t });
    expect(scene.mesh.rotation.y).toBeCloseTo(t * 0.08, 10);
    expect(scene.mesh.rotation.x).toBeCloseTo(Math.sin(t * 0.055) * 0.14, 10);
    expect(Math.abs(scene.mesh.rotation.x)).toBeLessThanOrEqual(0.14);
  });

  it("ignores listen and low: only time, energy and respond move anything", () => {
    const scene = buildScene();
    const snapshot = () =>
      JSON.stringify({
        vertices: Array.from(scene.positionAttr.array),
        pitch: scene.mesh.rotation.x,
        yaw: scene.mesh.rotation.y,
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
    const first = JSON.stringify(Array.from(scene.positionAttr.array));
    scene.handle.frame({ ...IDLE, time: 100 });
    scene.handle.frame({ ...PEAK, time: 7.3 });
    expect(JSON.stringify(Array.from(scene.positionAttr.array))).toBe(first);
  });
});

describe("liquidmetal dispose", () => {
  it("disposes the geometry and material once and detaches its mesh from the parent", () => {
    const scene = buildScene();
    const geo = scene.mesh.geometry as FakeSphereGeometry;
    expect(geo.disposed).toBe(false);
    expect(scene.parent.children).toHaveLength(1);

    scene.handle.dispose();

    expect(geo.disposed).toBe(true);
    expect(scene.mesh.material.disposed).toBe(true);
    expect(scene.parent.children).toHaveLength(0);
  });
});
