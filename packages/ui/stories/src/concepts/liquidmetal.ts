import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";
import { makeChromeGem } from "../orb-kit.ts";

// Three superimposed sine-wave axes for the mercury undulation.
// Each wave has a fixed axis direction (normalized), frequency, phase, and
// contribution weight. Using varied axes keeps the displacement from looking
// like simple x/y/z scale pulsing.
interface WaveDesc {
  ax: number;
  ay: number;
  az: number; // axis direction (pre-normalized)
  freq: number;
  phase: number;
  weight: number;
}

const WAVES: WaveDesc[] = [
  { ax: 0.577, ay: 0.577, az: 0.577, freq: 1.1, phase: 0.0, weight: 0.5 },
  { ax: 0.0, ay: 0.894, az: 0.447, freq: 1.7, phase: 2.09, weight: 0.32 },
  { ax: 0.707, ay: 0.0, az: 0.707, freq: 2.3, phase: 4.19, weight: 0.18 },
];

function build(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  // ---- body: smooth chrome sphere, tuned for liquid-mirror look --------------
  const BASE_RADIUS = 0.95;
  const bodyGeo = new THREE.SphereGeometry(BASE_RADIUS, 48, 32);
  const bodyMat = makeChromeGem(THREE);
  // Override the defaults from makeChromeGem for a mirror finish.
  bodyMat.flatShading = false; // smooth normals essential for liquid look
  bodyMat.roughness = 0.03; // near-perfect mirror
  bodyMat.metalness = 1.0;
  bodyMat.envMapIntensity = 1.8;
  bodyMat.color = new THREE.Color(0.95, 0.97, 1.0);

  // ---- accent fresnel rim: faint respond sheen using TSL (safe pattern) ------
  const { vec3, float, mix, normalView, positionViewDirection } = TSL;
  const fresnel: any = normalView
    .dot(positionViewDirection)
    .abs()
    .oneMinus()
    .pow(3.0);
  // Rim is only visible when responding; accent colour bleeds in from the edge.
  bodyMat.emissiveNode = U.uAccent.mul(
    fresnel.mul(float(0.08).add(U.uRespond.mul(0.55))),
  );

  const body = new THREE.Mesh(bodyGeo, bodyMat);
  parent.add(body);

  // Cache base vertex positions + their normalized directions once.
  const posAttr: { array: Float32Array; count: number; needsUpdate: boolean } =
    bodyGeo.attributes.position;
  const vertCount: number = posAttr.count;
  const base = new Float32Array(vertCount * 3);
  const dir = new Float32Array(vertCount * 3); // unit direction from origin

  for (let i = 0; i < vertCount; i++) {
    const x: number = posAttr.getX(i);
    const y: number = posAttr.getY(i);
    const z: number = posAttr.getZ(i);
    base[i * 3] = x;
    base[i * 3 + 1] = y;
    base[i * 3 + 2] = z;
    // Unit sphere so length = BASE_RADIUS; normalize to get direction.
    const len: number = Math.sqrt(x * x + y * y + z * z) || 1.0;
    dir[i * 3] = x / len;
    dir[i * 3 + 1] = y / len;
    dir[i * 3 + 2] = z / len;
  }

  const MAX_DISP = 0.12; // ±0.12 displacement → max radius 1.07, within 1.3 limit

  return {
    frame(f) {
      // Energy scales amplitude + speed; respond briefly sharpens/spikes.
      const amp: number = MAX_DISP * (0.3 + f.energy * 0.9 + f.respond * 0.35);
      const speed: number = 0.55 + f.energy * 1.1 + f.respond * 0.6;
      const t: number = f.time * speed;

      const pos: Float32Array = posAttr.array as Float32Array;

      for (let i = 0; i < vertCount; i++) {
        const dx: number = dir[i * 3];
        const dy: number = dir[i * 3 + 1];
        const dz: number = dir[i * 3 + 2];

        // Sum three sine waves, each projected onto a different axis.
        let disp: number = 0;
        for (const w of WAVES) {
          const proj: number = dx * w.ax + dy * w.ay + dz * w.az;
          disp +=
            Math.sin(proj * w.freq * Math.PI * 2 + t + w.phase) * w.weight;
        }
        // Normalize contribution range to [-1, 1] (weights sum to 1.0).
        // Spike sharpening on respond: raise to power for sharper crests.
        const sharpened: number =
          f.respond > 0.01
            ? Math.sign(disp) * Math.abs(disp) ** (0.65 + f.respond * 0.35)
            : disp;

        const d: number = sharpened * amp;
        pos[i * 3] = base[i * 3] + dx * d;
        pos[i * 3 + 1] = base[i * 3 + 1] + dy * d;
        pos[i * 3 + 2] = base[i * 3 + 2] + dz * d;
      }

      posAttr.needsUpdate = true;
      bodyGeo.computeVertexNormals();

      // Gentle continuous rotation — mercury blob drifts slowly.
      body.rotation.y = f.time * 0.08;
      body.rotation.x = Math.sin(f.time * 0.055) * 0.14;
    },

    dispose() {
      bodyGeo.dispose();
      bodyMat.dispose();
      parent.remove(body);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "liquidmetal",
  label: "liquid",
  family: "abstract",
  build,
};
