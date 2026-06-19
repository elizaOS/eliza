// Shared kit for the voice-orb comparison harness.
//
// Concept files (./concepts/<id>.ts) import the types + helpers from HERE, never
// from voice-main.tsx — importing the entry module would re-run its
// `createRoot`/`root.render` and mount a second React tree onto the canvas.
//
// TSL's node API is a runtime proxy with no usable static types, so the
// three/tsl modules are typed loosely at this boundary and nowhere else.
// Concepts receive `THREE`/`TSL` already imported.

export type WebGPUModule = Record<string, any>;
export type TSLModule = Record<string, any>;

/** Visual mode for the voice orb harness: idle / mic open / agent speaking. */
export type VoiceWaveformMode = "idle" | "listening" | "responding";

/** Minimal analyser surface — lets the harness drive the orb from a fake. */
export type FrequencyAnalyser = Pick<
  AnalyserNode,
  "frequencyBinCount" | "getByteFrequencyData"
>;

/**
 * Average `analyser` frequency data into `count` normalized [0,1] buckets.
 * Pure and DOM-free so the orb can be driven from a fake analyser.
 */
export function sampleFrequencyLevels(
  analyser: FrequencyAnalyser | null | undefined,
  count: number,
): Float32Array {
  const out = new Float32Array(count);
  if (!analyser || count <= 0) return out;
  const bins = analyser.frequencyBinCount;
  if (bins <= 0) return out;
  const buf = new Uint8Array(bins);
  analyser.getByteFrequencyData(buf);
  const step = Math.max(1, Math.floor(bins / count));
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    for (let j = 0; j < step; j += 1) {
      sum += buf[i * step + j] ?? 0;
    }
    out[i] = sum / step / 255;
  }
  return out;
}

export interface LevelSummary {
  /** Mean amplitude across the whole spectrum, [0,1]. */
  energy: number;
  /** Mean amplitude of the low third (bass), [0,1]. */
  low: number;
  /** Mean amplitude of the middle third (mids), [0,1]. */
  mid: number;
  /** Mean amplitude of the upper third (treble), [0,1]. */
  high: number;
}

/**
 * Collapse per-bucket frequency levels into an overall energy plus low/mid/high
 * band averages. Pure so the shader-driving math stays unit-testable.
 */
export function summarizeLevels(levels: Float32Array): LevelSummary {
  const n = levels.length;
  if (n === 0) return { energy: 0, low: 0, mid: 0, high: 0 };
  const third = Math.max(1, Math.floor(n / 3));
  let total = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  for (let i = 0; i < n; i += 1) {
    const v = levels[i] ?? 0;
    total += v;
    if (i < third) low += v;
    else if (i < third * 2) mid += v;
    else high += v;
  }
  const highCount = Math.max(1, n - third * 2);
  return {
    energy: total / n,
    low: low / third,
    mid: mid / third,
    high: high / highCount,
  };
}

/**
 * Fake analyser with a slow, bass-weighted moving spectrum so the orb visibly
 * pulses in the harness without a live audio graph. Matches the read-only
 * surface the harness consumes (`frequencyBinCount` + `getByteFrequencyData`).
 */
export function makeOscillatingAnalyser(): FrequencyAnalyser {
  const bins = 128;
  return {
    frequencyBinCount: bins,
    getByteFrequencyData: (buf: Uint8Array) => {
      const t = Date.now() / 1000;
      for (let i = 0; i < buf.length; i += 1) {
        const f = i / buf.length;
        const wave = Math.sin(t * 4 + f * 8) * 0.5 + 0.5;
        const tilt = 1 - f * 0.6;
        buf[i] = Math.max(0, Math.min(255, Math.round(wave * tilt * 230)));
      }
    },
  };
}

/** Per-frame state pushed into the shader uniforms. Amplitudes are [0,1]. */
export interface OrbFrame {
  time: number;
  energy: number;
  low: number;
  listen: number;
  respond: number;
}

/**
 * The shared uniform set every concept reads from. These are live three/tsl
 * `uniform()` nodes — read them inside node graphs (`U.uEnergy.mul(2)`), and the
 * harness updates `.value` each frame:
 *  - uTime    seconds since mount (monotonic)
 *  - uEnergy  smoothed overall loudness [0,1]
 *  - uLow     smoothed low-band (bass) loudness [0,1]
 *  - uListen  1 while listening, eased
 *  - uRespond 1 while responding, eased
 *  - uAspect  viewport width/height
 *  - uAccent  surface accent as a vec3 colour (orange on the app home surface)
 */
export interface OrbUniforms {
  uTime: any;
  uEnergy: any;
  uLow: any;
  uListen: any;
  uRespond: any;
  uAspect: any;
  uAccent: any;
}

/** A built orb body. Its meshes live under the `parent` group it was handed. */
export interface VariantHandle {
  frame: (f: OrbFrame) => void;
  dispose: () => void;
}

/**
 * A concept builder: add meshes to `parent`, return a handle whose `frame`
 * animates them and whose `dispose` releases every geometry/material and removes
 * the meshes it added. `U` holds the live voice uniforms; `THREE`/`TSL` are the
 * already-imported `three/webgpu` + `three/tsl` modules.
 */
export type ConceptBuilder = (
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
) => VariantHandle;

export type ConceptFamily =
  | "artful"
  | "mood"
  | "sci-fi"
  | "geometric"
  | "abstract";

/** One selectable concept in the comparison harness. */
export interface ConceptDescriptor {
  id: string;
  label: string;
  family: ConceptFamily;
  build: ConceptBuilder;
}

/**
 * Studio-gradient equirectangular environment (bright sky → dim ground with a
 * cool bloom) so reflective/refractive surfaces get a rim and surface sheen.
 * Without an environment, glass reads as matte jelly and chrome reads as flat
 * grey. Set as `scene.environment` by the harness; concepts just reflect it.
 */
export function makeStudioEnv(THREE: WebGPUModule): any {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const sky = ctx.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, "#ffffff");
  sky.addColorStop(0.42, "#dbe4f0");
  sky.addColorStop(0.5, "#9aa3b2");
  sky.addColorStop(0.54, "#6c7480");
  sky.addColorStop(1, "#2c3038");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 512, 256);
  const bloom = ctx.createRadialGradient(150, 64, 0, 150, 64, 150);
  bloom.addColorStop(0, "rgba(236,243,255,0.9)");
  bloom.addColorStop(1, "rgba(236,243,255,0)");
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, 512, 256);
  const texture = new THREE.Texture(c);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Base prismatic transmissive glass — thick, dispersive, clear-coated. */
export function makeGlass(THREE: WebGPUModule): any {
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.transmission = 1;
  m.ior = 1.45;
  m.thickness = 1.6;
  m.roughness = 0.0;
  m.metalness = 0;
  m.dispersion = 9;
  m.clearcoat = 1;
  m.clearcoatRoughness = 0.04;
  m.envMapIntensity = 1.0;
  m.color = new THREE.Color(1, 1, 1);
  return m;
}

/**
 * Colourless cut glass: full transmission, zero dispersion (no green/orange
 * fringe), faint icy attenuation so thick parts read blue-white like real glass.
 */
export function makeCrystalGlass(THREE: WebGPUModule): any {
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.transmission = 1;
  m.ior = 1.5;
  m.thickness = 1.3;
  m.roughness = 0.02;
  m.metalness = 0;
  m.dispersion = 0;
  m.clearcoat = 1;
  m.clearcoatRoughness = 0.03;
  m.envMapIntensity = 1.0;
  m.color = new THREE.Color(1, 1, 1);
  m.attenuationColor = new THREE.Color(0.82, 0.9, 1.0);
  m.attenuationDistance = 3.0;
  return m;
}

/**
 * Crisp flat-faceted chrome gem — an opaque reflective core that the glass
 * shells refract, which is what gives a crystal real internal depth.
 */
export function makeChromeGem(THREE: WebGPUModule): any {
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.flatShading = true;
  m.metalness = 1;
  m.roughness = 0.18;
  m.envMapIntensity = 1.4;
  m.color = new THREE.Color(0.9, 0.93, 0.98);
  return m;
}

/**
 * Irregular flat-faceted icosahedron geometry.
 *
 * `IcosahedronGeometry` (a `PolyhedronGeometry`) is already non-indexed: every
 * triangle owns its three vertices. We perturb each vertex by a smooth sine
 * field of its *normalized direction* — a pure function of position, so the
 * coincident vertices shared between adjacent faces move identically and the
 * mesh stays watertight. `computeVertexNormals` then yields crisp flat facets.
 *
 * Bakes each face's centroid into an `aCenter` (vec3) attribute so shaders can
 * address whole facets (e.g. per-facet emissive, shatter offsets).
 *
 * @param radius base radius
 * @param detail icosa subdivision (0 = 20 faces, 1 = 80, 2 = 320)
 * @param lump   perturbation amount (0 = smooth platonic, ~0.12 = gently lumpy)
 */
export function makeFacetedIcosa(
  THREE: WebGPUModule,
  radius: number,
  detail: number,
  lump: number,
): any {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const gp = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < gp.count; i += 1) {
    v.fromBufferAttribute(gp, i).normalize();
    const lumps =
      Math.sin(v.x * 5.2 + v.y * 3.1) * 0.5 +
      Math.sin(v.y * 6.3 + v.z * 2.7) * 0.3 +
      Math.sin(v.z * 4.1 + v.x * 5.9) * 0.2;
    v.multiplyScalar(radius * (1 + lumps * lump));
    gp.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const centers = new Float32Array(gp.count * 3);
  for (let i = 0; i < gp.count; i += 3) {
    const mx = (gp.getX(i) + gp.getX(i + 1) + gp.getX(i + 2)) / 3;
    const my = (gp.getY(i) + gp.getY(i + 1) + gp.getY(i + 2)) / 3;
    const mz = (gp.getZ(i) + gp.getZ(i + 1) + gp.getZ(i + 2)) / 3;
    for (let k = 0; k < 3; k += 1) {
      centers[(i + k) * 3] = mx;
      centers[(i + k) * 3 + 1] = my;
      centers[(i + k) * 3 + 2] = mz;
    }
  }
  geo.setAttribute("aCenter", new THREE.BufferAttribute(centers, 3));
  return geo;
}

/**
 * GPU particle swarm orbiting the centre. Each point owns a random `aSeed`; its
 * position is computed every frame in the shader from `uTime` + seed (tilted
 * orbits at varied radii), and the whole swarm breathes outward with the voice
 * so points visibly fly off on peaks. Additive, depth-write off. Returns the
 * `THREE.Points` (caller adds it to the scene) plus a `dispose`.
 */
export function makeOrbitParticles(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  count: number,
): { points: any; dispose: () => void } {
  const { vec3, float, attribute, sin, cos } = TSL;
  const pos = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    seeds[i * 3] = Math.random();
    seeds[i * 3 + 1] = Math.random();
    seeds[i * 3 + 2] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));

  const seed = attribute("aSeed", "vec3");
  const phase = seed.x.mul(6.2831);
  const speed = seed.z.mul(0.4).add(0.12);
  const ang = U.uTime.mul(speed).add(phase);
  const yLevel = seed.y.sub(0.5).mul(2.6);
  const ringR = float(1.0)
    .sub(yLevel.mul(yLevel).mul(0.22))
    .mul(seed.x.mul(0.35).add(0.95));
  const breathe = float(1.05).add(U.uEnergy.mul(0.9)).add(U.uRespond.mul(0.4));
  const r = ringR.mul(breathe);
  const py = yLevel.add(sin(U.uTime.mul(speed.mul(1.3)).add(phase)).mul(0.12));

  const mat = new THREE.PointsNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.AdditiveBlending;
  mat.positionNode = vec3(cos(ang).mul(r), py, sin(ang).mul(r));
  mat.colorNode = vec3(0.8, 0.9, 1.0).mul(
    float(0.35).add(U.uEnergy.mul(1.3)).add(U.uRespond.mul(0.6)),
  );
  mat.sizeNode = seed.x
    .mul(0.04)
    .add(0.025)
    .mul(float(1.0).add(U.uEnergy.mul(1.8)));
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return {
    points,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
