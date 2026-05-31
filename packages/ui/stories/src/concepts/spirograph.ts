// Harmonic Lissajous / spirograph curves — thick white glass tubes over the
// solid orange field, each with a per-tube fresnel rim glow.
//
// 5 closed 3D curves, each traced by parametric harmonics over t in [0, 2π]:
//   x = sin(a*t + φx), y = sin(b*t + φy), z = sin(c*t + φz)
// Each closed curve is resampled into a CatmullRom path and swept into a real
// TubeGeometry (so the strands have genuine thickness — THREE.Line ignores
// linewidth on WebGPU). An unlit white material drives its opacity from a
// view-angle fresnel term: opaque bright silhouette, translucent core letting
// the orange show through, so every thread reads as a glowing glass tube.
//
// The whole bundle turns very slowly; each tube also drifts on its own axis.
// Respond spreads the tubes apart and pumps overall opacity. Hue stays white.

import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Control points sampled along each closed curve (fed to CatmullRom).
const SEGMENTS = 240;
// Tube sweep resolution.
const TUBULAR_SEGMENTS = 480;
const RADIAL_SEGMENTS = 8;
// Tube radius in world units — the bundle spans ~1.84, so this reads as a
// clearly thick thread (vs the original 1px line).
const TUBE_RADIUS = 0.017;

// Frequency triplets (a, b, c) for each curve — coprime / near-coprime so the
// closed Lissajous figures each have a distinct shape.
const FREQS: [number, number, number][] = [
  [3, 2, 5],
  [5, 4, 3],
  [4, 3, 7],
  [7, 5, 4],
  [2, 5, 6],
];

// Phase offsets (φx, φy, φz) per curve — shift the figures so they don't all
// start at the same point and the bundle looks full from the first frame.
const PHASES: [number, number, number][] = [
  [0.0, 0.7, 1.4],
  [1.0, 0.3, 2.1],
  [2.0, 1.6, 0.5],
  [0.5, 2.4, 1.1],
  [1.8, 0.9, 2.7],
];

interface CurveEntry {
  mesh: any;
  geo: any;
  mat: any;
  // Slow per-tube drift axis (baked at build time).
  axisX: number;
  axisY: number;
  axisZ: number;
  // Radial spread direction used when respond pushes the tubes apart.
  spreadX: number;
  spreadY: number;
  spreadZ: number;
}

// Sample one closed Lissajous figure as Vector3 control points (no duplicate
// endpoint — the CatmullRom curve is built closed).
function buildCurveVecs(
  THREE: WebGPUModule,
  a: number,
  b: number,
  c: number,
  px: number,
  py: number,
  pz: number,
  radius: number,
): any[] {
  const pts: any[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const t = (i / SEGMENTS) * Math.PI * 2;
    pts.push(
      new THREE.Vector3(
        Math.sin(a * t + px) * radius,
        Math.sin(b * t + py) * radius,
        Math.sin(c * t + pz) * radius,
      ),
    );
  }
  return pts;
}

function build(
  THREE: WebGPUModule,
  TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // Curve radius — each Lissajous figure spans [−R, +R] per axis, so R ~0.92
  // fills the orb space without overflowing the ~1.3 world-unit boundary.
  const BASE_RADIUS = 0.92;

  const { vec3, normalView, positionViewDirection, uniform } = TSL;

  // Shared opacity uniform — frame pumps it with energy/respond.
  const uOpacity = uniform(0.8);

  // Per-tube fresnel: glancing silhouette → ~1, camera-facing core → ~0.
  // Sharpened, then remapped to [0.35, 1] so the tubes keep body while their
  // rims glow bright white.
  const fres = normalView.dot(positionViewDirection).abs().oneMinus().pow(2.0);
  const fresOpacity = uOpacity.mul(fres.mul(0.65).add(0.35));

  const curves: CurveEntry[] = FREQS.map(([a, b, c], i) => {
    const [px, py, pz] = PHASES[i];

    const pts = buildCurveVecs(THREE, a, b, c, px, py, pz, BASE_RADIUS);
    const curve = new THREE.CatmullRomCurve3(pts, true);
    const geo = new THREE.TubeGeometry(
      curve,
      TUBULAR_SEGMENTS,
      TUBE_RADIUS,
      RADIAL_SEGMENTS,
      true,
    );

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = vec3(1, 1, 1);
    mat.opacityNode = fresOpacity;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.blending = THREE.NormalBlending;

    const mesh = new THREE.Mesh(geo, mat);
    parent.add(mesh);

    // Deterministic per-tube drift axis from the index.
    const angle0 = (i / FREQS.length) * Math.PI * 2;
    const angle1 = (i * 1.618) % (Math.PI * 2);
    const axisX = Math.sin(angle0) * Math.cos(angle1);
    const axisY = Math.sin(angle0) * Math.sin(angle1);
    const axisZ = Math.cos(angle0);

    // Spread direction — push each tube radially from origin on respond.
    const spreadAngle = (i / FREQS.length) * Math.PI * 2;
    const spreadX = Math.cos(spreadAngle) * 0.7;
    const spreadY = Math.sin(spreadAngle) * 0.4;
    const spreadZ = Math.sin(spreadAngle + 1.0) * 0.5;

    return { mesh, geo, mat, axisX, axisY, axisZ, spreadX, spreadY, spreadZ };
  });

  // Per-tube rotation accumulator.
  const rotAccum: number[] = FREQS.map(() => 0);
  // Bundle rotation.
  let bundleRotY = 0;
  let bundleRotX = 0;

  return {
    frame(f) {
      const energy: number = f.energy;
      const respond: number = f.respond;
      const time: number = f.time;

      // Very slow bundle drift (~¼ of the original speed).
      const bundleSpeed: number = 0.011 + energy * 0.02 + respond * 0.016;
      bundleRotY += bundleSpeed * 0.016;
      bundleRotX = Math.sin(time * 0.02) * 0.16;
      parent.rotation.y = bundleRotY;
      parent.rotation.x = bundleRotX;

      // Each tube drifts slowly around its own axis (also ~¼ speed).
      const curveSpeed: number = 0.024 + energy * 0.035 + respond * 0.028;

      curves.forEach((cv: CurveEntry, i: number) => {
        const speedMult: number = 0.7 + i * 0.12;
        rotAccum[i] += curveSpeed * speedMult * 0.016;

        cv.mesh.rotation.x = Math.sin(rotAccum[i] * 0.8 + i) * 0.9;
        cv.mesh.rotation.y = rotAccum[i];
        cv.mesh.rotation.z = Math.cos(rotAccum[i] * 0.6 + i * 0.7) * 0.6;

        // Spread on respond — move each tube's pivot away from origin.
        const spread: number = respond * 0.28;
        cv.mesh.position.x = cv.spreadX * spread;
        cv.mesh.position.y = cv.spreadY * spread;
        cv.mesh.position.z = cv.spreadZ * spread;
      });

      // White stays white; energy/respond pump overall opacity via the uniform.
      uOpacity.value = Math.min(0.95, 0.72 + energy * 0.18 + respond * 0.16);
    },

    dispose() {
      curves.forEach((cv: CurveEntry) => {
        cv.geo.dispose();
        cv.mat.dispose();
        parent.remove(cv.mesh);
      });
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "spirograph",
  label: "spirograph",
  family: "geometric",
  build,
};
