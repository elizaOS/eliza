import type {
  ConceptDescriptor,
  OrbFrame,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Saturated watercolor hues for the 6 shells: rose, coral, violet, jade, ocean,
// amber. Pale pastels washed out completely against the bright cloud backdrop,
// so these are deepened to mid-saturation pigments that still bleed softly when
// layered. Stored as [r, g, b] linear-ish sRGB components.
const SHELL_HUES: [number, number, number][] = [
  [0.92, 0.34, 0.46], // rose
  [0.96, 0.50, 0.30], // coral
  [0.56, 0.36, 0.84], // violet
  [0.20, 0.70, 0.54], // jade
  [0.24, 0.56, 0.86], // ocean
  [0.90, 0.66, 0.20], // amber
];

// Per-shell animation parameters baked at build time.
interface ShellDef {
  radius: number;
  baseOpacity: number;
  // drift offsets so shells don't all float in lock-step
  driftPhaseX: number;
  driftPhaseY: number;
  driftPhaseZ: number;
  driftSpeedX: number;
  driftSpeedY: number;
  driftSpeedZ: number;
  driftAmpX: number;
  driftAmpY: number;
  driftAmpZ: number;
  // slow independent spin
  spinSpeed: number;
  spinAxis: number; // 0=y, 1=z alternating
}

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  const meshes: any[] = [];
  const geos: any[] = [];
  const mats: any[] = [];
  const defs: ShellDef[] = [];

  // 6 shells spanning radii 0.60 → 1.25, each a sphere with many segments so
  // the overlapping translucent edges stay smooth.
  const shellCount = SHELL_HUES.length;
  for (let i = 0; i < shellCount; i += 1) {
    const t: number = i / (shellCount - 1); // 0 → 1
    const radius: number = 0.60 + t * 0.65; // 0.60 … 1.25

    // Outermost shells are slightly more opaque so the depth reads.
    const baseOpacity: number = 0.20 + t * 0.10;

    const geo = new THREE.SphereGeometry(radius, 40, 40);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.color = new THREE.Color(...SHELL_HUES[i]!);
    mat.transparent = true;
    mat.opacity = baseOpacity;
    mat.depthWrite = false;
    mat.blending = THREE.NormalBlending;
    mat.side = THREE.FrontSide;

    const mesh = new THREE.Mesh(geo, mat);
    parent.add(mesh);

    geos.push(geo);
    mats.push(mat);
    meshes.push(mesh);

    // Randomised drift parameters — seeded deterministically per shell so the
    // motion is consistent across hot-reloads.
    const s: number = i + 1; // seed scalar
    defs.push({
      radius,
      baseOpacity,
      driftPhaseX: s * 1.31,
      driftPhaseY: s * 0.73,
      driftPhaseZ: s * 2.17,
      driftSpeedX: 0.07 + (s % 3) * 0.018,
      driftSpeedY: 0.055 + (s % 4) * 0.012,
      driftSpeedZ: 0.062 + (s % 5) * 0.015,
      driftAmpX: 0.045 + (i % 3) * 0.018,
      driftAmpY: 0.038 + (i % 4) * 0.015,
      driftAmpZ: 0.042 + (i % 5) * 0.016,
      spinSpeed: 0.008 + i * 0.003,
      spinAxis: i % 2,
    });
  }

  // Warm peach/accent target colour for respond state, blended per shell.
  // Accent is orange-ish (1, 0.34, 0) in the harness; we lean toward warm peach.
  const RESPOND_R = 1.0;
  const RESPOND_G = 0.75;
  const RESPOND_B = 0.55;

  return {
    frame(f: OrbFrame) {
      for (let i = 0; i < shellCount; i += 1) {
        const def = defs[i]!;
        const mat = mats[i];
        const mesh = meshes[i]!;
        const hue = SHELL_HUES[i]!;

        // --- position drift: slow sinusoidal wander so shells bleed together ---
        const px: number =
          Math.sin(f.time * def.driftSpeedX + def.driftPhaseX) * def.driftAmpX;
        const py: number =
          Math.sin(f.time * def.driftSpeedY + def.driftPhaseY) * def.driftAmpY;
        const pz: number =
          Math.sin(f.time * def.driftSpeedZ + def.driftPhaseZ) * def.driftAmpZ;
        mesh.position.set(px, py, pz);

        // --- slow spin for dreamy rotation ------------------------------------
        if (def.spinAxis === 0) {
          mesh.rotation.y = f.time * def.spinSpeed;
        } else {
          mesh.rotation.z = f.time * def.spinSpeed;
        }

        // --- scale: breathes gently on energy, innermost shells react most ----
        const energyBoost: number = f.energy * (1.0 - i * 0.08);
        const scale: number = 1.0 + energyBoost * 0.18;
        mesh.scale.setScalar(scale);

        // --- opacity: rises with energy, capped so layered shells stay washy ---
        const opBase: number = def.baseOpacity + f.energy * 0.14;
        mat.opacity = Math.min(opBase, 0.52);

        // --- colour: warm toward peach/accent on respond ----------------------
        const r0: number = hue[0]!;
        const g0: number = hue[1]!;
        const b0: number = hue[2]!;
        const rc: number = f.respond;
        mat.color.setRGB(
          r0 + (RESPOND_R - r0) * rc * 0.55,
          g0 + (RESPOND_G - g0) * rc * 0.55,
          b0 + (RESPOND_B - b0) * rc * 0.55,
        );
      }
    },

    dispose() {
      for (let i = 0; i < shellCount; i += 1) {
        geos[i].dispose();
        mats[i].dispose();
        parent.remove(meshes[i]);
      }
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "watercolor",
  label: "watercolor",
  family: "artful",
  build,
};
