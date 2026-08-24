/**
 * Unit coverage for the datacore orb concept: descriptor registration,
 * gyroscope assembly into the parent group, per-ring spin/tilt-easing/emissive
 * animation, respond-lock hysteresis, and teardown. Harness is deterministic:
 * the real builder runs against a plain-object renderer stand-in, which the
 * module accepts because it takes the WebGPU module as an injected parameter.
 */
import { describe, expect, it } from "vitest";
import { concept } from "../../stories/src/concepts/datacore";
import type { OrbFrame, OrbUniforms } from "../../stories/src/orb-kit";

class FakeGeometry {
  disposed = 0;
  constructor(
    public readonly kind: string,
    public readonly args: readonly number[],
  ) {}
  dispose(): void {
    this.disposed += 1;
  }
}

class FakeMaterial {
  disposed = 0;
  flatShading = false;
  metalness = 0;
  roughness = 0;
  emissive = new FakeColor(0, 0, 0);
  emissiveIntensity = 0;
  dispose(): void {
    this.disposed += 1;
  }
}

class FakeColor {
  constructor(
    public r: number,
    public g: number,
    public b: number,
  ) {}
  setRGB(r: number, g: number, b: number): void {
    this.r = r;
    this.g = g;
    this.b = b;
  }
}

class FakeMesh {
  rotation = { x: 0, y: 0, z: 0 };
  scale = {
    value: 1,
    setScalar(v: number): void {
      this.value = v;
    },
  };
  constructor(
    public geometry: FakeGeometry,
    public material: FakeMaterial,
  ) {}
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("missing item");
  return value;
}

function makeUniforms(): OrbUniforms {
  return {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uLow: { value: 0 },
    uListen: { value: 0 },
    uRespond: { value: 0 },
    uAspect: { value: 1 },
    uAccent: { value: null },
  };
}

function makeHarness() {
  const geometries: FakeGeometry[] = [];
  const materials: FakeMaterial[] = [];
  const THREE = {
    TorusGeometry: class extends FakeGeometry {
      constructor(...args: number[]) {
        super("torus", args);
        geometries.push(this);
      }
    },
    IcosahedronGeometry: class extends FakeGeometry {
      constructor(...args: number[]) {
        super("icosahedron", args);
        geometries.push(this);
      }
    },
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
    Color: FakeColor,
    Mesh: FakeMesh,
  };
  const parent = {
    children: [] as FakeMesh[],
    add(child: FakeMesh): void {
      parent.children.push(child);
    },
    remove(child: FakeMesh): void {
      const index = parent.children.indexOf(child);
      if (index >= 0) parent.children.splice(index, 1);
    },
  };
  const handle = concept.build(THREE, {}, makeUniforms(), parent);
  return { handle, parent, geometries, materials };
}

function frame(over: Partial<OrbFrame>): OrbFrame {
  return { time: 0, energy: 0, low: 0, listen: 0, respond: 0, ...over };
}

describe("datacore concept descriptor", () => {
  it("registers the datacore label in the sci-fi family with a callable builder", () => {
    expect(concept.id).toBe("datacore");
    expect(concept.label).toBe("datacore");
    expect(concept.family).toBe("sci-fi");
    expect(typeof concept.build).toBe("function");
  });
});

describe("datacore assembly", () => {
  it("adds three gyro rings, the nucleus, and the accent ring to the parent in order", () => {
    const { parent, geometries } = makeHarness();
    expect(parent.children).toHaveLength(5);
    expect(geometries.map((g) => g.kind)).toEqual([
      "torus",
      "torus",
      "torus",
      "icosahedron",
      "torus",
    ]);
    expect(geometries[0]?.args).toEqual([0.55, 0.028, 12, 80]);
    expect(geometries[1]?.args).toEqual([0.8, 0.022, 12, 80]);
    expect(geometries[2]?.args).toEqual([1.05, 0.018, 12, 80]);
    expect(geometries[3]?.args).toEqual([0.18, 1]);
    expect(geometries[4]?.args).toEqual([0.32, 0.012, 8, 60]);
  });

  it("seeds each ring mesh and the accent ring at their natural rest tilts", () => {
    const { parent } = makeHarness();
    const [ring0, ring1, ring2, , accent] = parent.children;
    expect(must(ring0).rotation.x).toBe(Math.PI * 0.5);
    expect(must(ring0).rotation.z).toBe(0);
    expect(must(ring1).rotation.x).toBe(Math.PI * 0.28);
    expect(must(ring1).rotation.z).toBe(Math.PI * 0.14);
    expect(must(ring2).rotation.x).toBe(Math.PI * 0.12);
    expect(must(ring2).rotation.z).toBe(Math.PI * 0.62);
    expect(must(accent).rotation.x).toBe(Math.PI * 0.3);
  });

  it("bases rings on a flat-shaded chrome gem with faint cyan emissive and flares the nucleus", () => {
    const { materials } = makeHarness();
    const [ringMat, , , nucleusMat, accentMat] = materials;
    expect(must(ringMat).flatShading).toBe(true);
    expect(must(ringMat).metalness).toBe(1);
    expect(must(ringMat).roughness).toBeCloseTo(0.18, 12);
    expect(must(ringMat).emissive.r).toBe(0);
    expect(must(ringMat).emissive.g).toBeCloseTo(0.55, 12);
    expect(must(ringMat).emissive.b).toBeCloseTo(0.72, 12);
    expect(must(ringMat).emissiveIntensity).toBeCloseTo(0.18, 12);
    expect(must(nucleusMat).metalness).toBeCloseTo(0.6, 12);
    expect(must(nucleusMat).roughness).toBeCloseTo(0.25, 12);
    expect(must(nucleusMat).emissiveIntensity).toBeCloseTo(0.9, 12);
    expect(must(accentMat).emissive.r).toBeCloseTo(0.8, 12);
    expect(must(accentMat).emissive.g).toBeCloseTo(0.45, 12);
    expect(must(accentMat).emissive.b).toBe(0);
  });
});

describe("datacore per-frame animation", () => {
  it("accumulates each ring's spin on its own axis over one fixed 0.016 s step", () => {
    const { handle, parent } = makeHarness();
    handle.frame(frame({}));
    const [ring0, ring1, ring2] = parent.children;
    expect(must(ring0).rotation.y).toBeCloseTo(0.72 * 0.016, 12);
    expect(must(ring1).rotation.x).toBeCloseTo(
      Math.PI * 0.28 + 0.48 * 0.016,
      12,
    );
    expect(must(ring2).rotation.z).toBeCloseTo(
      Math.PI * 0.62 + 0.31 * 0.016,
      12,
    );
  });

  it("leaves the non-spin axes pinned at rest while idle", () => {
    const { handle, parent } = makeHarness();
    handle.frame(frame({}));
    const [ring0, ring1, ring2] = parent.children;
    expect(must(ring0).rotation.x).toBe(Math.PI * 0.5);
    expect(must(ring1).rotation.z).toBe(Math.PI * 0.14);
    expect(must(ring2).rotation.x).toBe(Math.PI * 0.12);
  });

  it("scales spin speed up by 2.4x at full voice energy", () => {
    const { handle, parent } = makeHarness();
    handle.frame(frame({ energy: 0 }));
    const idleRy = must(parent.children[0]).rotation.y;
    handle.frame(frame({ energy: 1 }));
    const energizedDelta = must(parent.children[0]).rotation.y - idleRy;
    expect(energizedDelta).toBeCloseTo(0.72 * 2.4 * 0.016, 12);
  });

  it("flares ring emissive with energy and shifts cyan toward amber while responding", () => {
    const { handle, materials } = makeHarness();
    const ringMat = must(materials[0]);
    handle.frame(frame({ energy: 0.5 }));
    expect(ringMat.emissiveIntensity).toBeCloseTo(0.455, 12);
    expect(ringMat.emissive.r).toBe(0);
    expect(ringMat.emissive.g).toBeCloseTo(0.7, 12);
    expect(ringMat.emissive.b).toBeCloseTo(0.86, 12);
    handle.frame(frame({ energy: 0.5, respond: 1 }));
    expect(ringMat.emissive.r).toBeCloseTo(0.63, 12);
    expect(ringMat.emissive.g).toBeCloseTo(0.56, 12);
    expect(ringMat.emissive.b).toBeCloseTo(0.328, 12);
    expect(ringMat.emissiveIntensity).toBeCloseTo(0.905, 12);
  });

  it("steps the accent ring 0.022 radians per frame at rest regardless of the timestep constant", () => {
    const { handle, parent, materials } = makeHarness();
    const accent = must(parent.children[4]);
    const accentMat = must(materials[4]);
    handle.frame(frame({ energy: 1 }));
    expect(accent.rotation.z).toBeCloseTo(0.066, 12);
    expect(accentMat.emissiveIntensity).toBeCloseTo(0.9, 12);
  });

  it("pulses the nucleus scale with time and energy, spins it slowly, and warms its glow on respond", () => {
    const { handle, parent, materials } = makeHarness();
    const nucleus = must(parent.children[3]);
    const nucleusMat = must(materials[3]);
    handle.frame(frame({ energy: 0.2, respond: 0.5 }));
    expect(nucleus.scale.value).toBeCloseTo(1.169, 12);
    expect(nucleus.rotation.y).toBe(0);
    expect(nucleus.rotation.x).toBe(0);
    expect(nucleusMat.emissive.r).toBeCloseTo(0.4, 12);
    expect(nucleusMat.emissive.g).toBeCloseTo(0.7, 12);
    expect(nucleusMat.emissive.b).toBeCloseTo(0.62, 12);
    expect(nucleusMat.emissiveIntensity).toBeCloseTo(1.78, 12);
    const quarterPulse = Math.PI / (2 * 3.8);
    handle.frame(frame({ time: quarterPulse }));
    expect(nucleus.scale.value).toBeCloseTo(1.06, 6);
    expect(nucleus.rotation.y).toBeCloseTo(0.165347, 6);
    expect(nucleus.rotation.x).toBeCloseTo(0.111609, 6);
  });
});

describe("datacore respond lock", () => {
  it("holds rings toward the shared plane after a respond peak ends, then drifts back to natural tilts", () => {
    const { handle, parent } = makeHarness();
    handle.frame(frame({ respond: 1 }));
    const onsetRx = must(parent.children[0]).rotation.x;
    expect(onsetRx).toBeCloseTo(Math.PI * 0.5 * 0.94, 9);
    let minRx = onsetRx;
    for (let i = 0; i < 60; i += 1) {
      handle.frame(frame({}));
      const rx = must(parent.children[0]).rotation.x;
      expect(rx).toBeLessThan(minRx);
      minRx = rx;
    }
    expect(minRx).toBeLessThan(0.1);
    for (let i = 0; i < 300; i += 1) {
      handle.frame(frame({}));
    }
    const recovered = must(parent.children[0]).rotation.x;
    expect(recovered).toBeGreaterThan(minRx);
    expect(recovered).toBeGreaterThan(1.5);
  });

  it("does not latch the hold when respond peaks at exactly 0.5", () => {
    const { handle, parent } = makeHarness();
    handle.frame(frame({ respond: 0.5 }));
    expect(must(parent.children[0]).rotation.x).toBeCloseTo(
      Math.PI * 0.5 * 0.94,
      9,
    );
    handle.frame(frame({}));
    expect(must(parent.children[0]).rotation.x).toBeCloseTo(
      Math.PI * 0.5 * 0.9415,
      9,
    );
  });

  it("keeps mid-band respond above 0.1 in the fast locked easing even without an onset", () => {
    const { handle, parent } = makeHarness();
    handle.frame(frame({ respond: 0.3 }));
    expect(must(parent.children[0]).rotation.x).toBeCloseTo(
      Math.PI * 0.5 * 0.94,
      9,
    );
  });
});

describe("datacore teardown", () => {
  it("removes all five meshes from the parent and disposes each geometry and material once", () => {
    const { handle, parent, geometries, materials } = makeHarness();
    expect(parent.children).toHaveLength(5);
    handle.dispose();
    expect(parent.children).toHaveLength(0);
    expect(geometries.map((g) => g.disposed)).toEqual([1, 1, 1, 1, 1]);
    expect(materials.map((m) => m.disposed)).toEqual([1, 1, 1, 1, 1]);
  });
});
