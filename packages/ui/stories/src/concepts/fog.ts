import type {
  ConceptDescriptor,
  OrbFrame,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Calm volumetric haze. Layered translucent spheres drift and rotate slowly,
// their combined transparencies churning like soft mist. Muted, sleepy, restful.
// Deep slate-blue shells with NormalBlending so the haze reads as a soft, moody
// ball against the bright cloud sky (additive low-opacity grey washes to nothing).

// Deep cool slate-blue hues for each fog shell layer.
const SHELL_CONFIGS: readonly {
  radius: number;
  ox: number;
  oy: number;
  oz: number;
  r: number;
  g: number;
  b: number;
  opacity: number;
  spinDir: number;
  spinAxis: "x" | "y" | "z";
  spinSpeed: number;
  driftPhase: number;
}[] = [
  { radius: 1.25, ox:  0.00, oy:  0.00, oz:  0.00, r: 0.40, g: 0.48, b: 0.62, opacity: 0.10, spinDir:  1, spinAxis: "y", spinSpeed: 0.012, driftPhase: 0.0 },
  { radius: 1.15, ox:  0.08, oy: -0.05, oz:  0.04, r: 0.36, g: 0.44, b: 0.60, opacity: 0.11, spinDir: -1, spinAxis: "y", spinSpeed: 0.009, driftPhase: 1.3 },
  { radius: 1.10, ox: -0.06, oy:  0.07, oz: -0.05, r: 0.38, g: 0.47, b: 0.64, opacity: 0.12, spinDir:  1, spinAxis: "x", spinSpeed: 0.008, driftPhase: 2.6 },
  { radius: 1.05, ox:  0.05, oy:  0.06, oz:  0.03, r: 0.32, g: 0.41, b: 0.57, opacity: 0.13, spinDir: -1, spinAxis: "z", spinSpeed: 0.010, driftPhase: 0.9 },
  { radius: 0.98, ox: -0.07, oy: -0.04, oz:  0.06, r: 0.34, g: 0.43, b: 0.58, opacity: 0.14, spinDir:  1, spinAxis: "y", spinSpeed: 0.013, driftPhase: 4.1 },
  { radius: 0.92, ox:  0.04, oy:  0.08, oz: -0.04, r: 0.30, g: 0.39, b: 0.56, opacity: 0.15, spinDir: -1, spinAxis: "x", spinSpeed: 0.007, driftPhase: 5.5 },
  { radius: 0.86, ox: -0.05, oy: -0.06, oz:  0.05, r: 0.36, g: 0.45, b: 0.62, opacity: 0.14, spinDir:  1, spinAxis: "z", spinSpeed: 0.011, driftPhase: 2.2 },
  { radius: 0.80, ox:  0.06, oy:  0.05, oz: -0.06, r: 0.32, g: 0.42, b: 0.60, opacity: 0.13, spinDir: -1, spinAxis: "y", spinSpeed: 0.014, driftPhase: 3.7 },
  { radius: 0.75, ox: -0.04, oy:  0.07, oz:  0.04, r: 0.38, g: 0.47, b: 0.64, opacity: 0.12, spinDir:  1, spinAxis: "x", spinSpeed: 0.009, driftPhase: 6.0 },
  { radius: 0.70, ox:  0.07, oy: -0.05, oz: -0.03, r: 0.35, g: 0.44, b: 0.61, opacity: 0.11, spinDir: -1, spinAxis: "y", spinSpeed: 0.008, driftPhase: 1.8 },
];

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // Build the fog shell meshes.
  type ShellEntry = {
    mesh: any;
    geo: any;
    mat: any;
    cfg: (typeof SHELL_CONFIGS)[number];
  };
  const shells: ShellEntry[] = SHELL_CONFIGS.map((cfg) => {
    const geo = new THREE.SphereGeometry(cfg.radius, 24, 16);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.NormalBlending;
    mat.color = new THREE.Color(cfg.r, cfg.g, cfg.b);
    mat.opacity = cfg.opacity;
    const mesh = new THREE.Mesh(geo, mat);
    parent.add(mesh);
    return { mesh, geo, mat, cfg };
  });

  // Sparse haze motes: slow JS-driven drift particles in dim slate-blue, kept
  // faint and sluggish so they read as suspended dust without stealing focus.
  const moteCount: number = 80;
  const moteGeo = new THREE.BufferGeometry();
  const motePos = new Float32Array(moteCount * 3);
  const moteSeeds = new Float32Array(moteCount * 3);
  for (let i = 0; i < moteCount; i++) {
    // Distribute on a sphere for initial positions (overwritten each frame via JS).
    const theta: number = Math.random() * Math.PI * 2;
    const phi: number = Math.acos(2 * Math.random() - 1);
    const r: number = 0.5 + Math.random() * 0.75;
    motePos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    motePos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    motePos[i * 3 + 2] = r * Math.cos(phi);
    moteSeeds[i * 3]     = Math.random();
    moteSeeds[i * 3 + 1] = Math.random();
    moteSeeds[i * 3 + 2] = Math.random();
  }
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  const moteMat = new THREE.PointsNodeMaterial();
  moteMat.transparent = true;
  moteMat.depthWrite = false;
  moteMat.blending = THREE.NormalBlending;
  moteMat.color = new THREE.Color(0.34, 0.42, 0.56);
  moteMat.size = 0.022;
  moteMat.opacity = 0.4;
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  parent.add(motes);

  // Pre-computed per-mote drift parameters for JS animation.
  const moteDrift: { theta0: number; phi0: number; r0: number; speed: number; phase: number }[] = [];
  for (let i = 0; i < moteCount; i++) {
    moteDrift.push({
      theta0: moteSeeds[i * 3] * Math.PI * 2,
      phi0:   Math.acos(2 * moteSeeds[i * 3 + 1] - 1),
      r0:     0.5 + moteSeeds[i * 3 + 2] * 0.75,
      speed:  0.04 + moteSeeds[i * 3 + 2] * 0.06,
      phase:  moteSeeds[i * 3] * Math.PI * 2,
    });
  }
  const motePosAttr = moteGeo.attributes.position as any;

  return {
    frame(f: OrbFrame) {
      // Base scale breathes very subtly with energy (idle = stillness).
      const breatheScale: number = 1.0 + f.energy * 0.06;

      // Respond: faint cool brightening — raise opacity slightly, lighten color.
      const respondLift: number = f.respond * 0.015;
      const listenDim: number  = f.listen  * 0.008;

      for (const { mesh, mat, cfg } of shells) {
        // Slow rotation on each shell's axis in alternating directions.
        const angle: number = f.time * cfg.spinSpeed * cfg.spinDir;
        if (cfg.spinAxis === "y") {
          mesh.rotation.y = angle;
          mesh.rotation.x = Math.sin(f.time * cfg.spinSpeed * 0.7) * 0.08;
        } else if (cfg.spinAxis === "x") {
          mesh.rotation.x = angle;
          mesh.rotation.z = Math.sin(f.time * cfg.spinSpeed * 0.8) * 0.07;
        } else {
          mesh.rotation.z = angle;
          mesh.rotation.y = Math.sin(f.time * cfg.spinSpeed * 0.9) * 0.06;
        }

        // Drifting centre offset — each shell wanders slowly on sin waves.
        const drift: number = 0.025;
        mesh.position.x = cfg.ox + Math.sin(f.time * 0.11 + cfg.driftPhase) * drift;
        mesh.position.y = cfg.oy + Math.sin(f.time * 0.08 + cfg.driftPhase + 1.2) * drift;
        mesh.position.z = cfg.oz + Math.sin(f.time * 0.09 + cfg.driftPhase + 2.4) * drift;

        // Uniform scale breath.
        mesh.scale.setScalar(breatheScale);

        // Opacity: base + tiny respond lift, tiny listen dim.
        const op: number = Math.min(
          0.24,
          cfg.opacity + respondLift - listenDim,
        );
        mat.opacity = op;

        // Faint respond brightening: nudge color toward cooler blue.
        const rb: number = cfg.r + f.respond * 0.05;
        const gb: number = cfg.g + f.respond * 0.06;
        const bb: number = cfg.b + f.respond * 0.08;
        mat.color.setRGB(rb, gb, bb);
      }

      // Animate haze motes: slow spherical drift, update positions in JS.
      const pos = motePosAttr;
      for (let i = 0; i < moteCount; i++) {
        const d = moteDrift[i];
        const t: number = f.time * d.speed + d.phase;
        const theta: number = d.theta0 + t;
        const phi: number = d.phi0 + Math.sin(t * 0.37) * 0.18;
        const r: number = d.r0 + Math.sin(t * 0.23 + d.phase) * 0.08;
        pos.setXYZ(
          i,
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.cos(phi),
          r * Math.sin(phi) * Math.sin(theta),
        );
      }
      pos.needsUpdate = true;

      // Mote opacity: faint, tiny respond brightening.
      moteMat.opacity = 0.34 + f.respond * 0.12;
    },

    dispose() {
      for (const { mesh, geo, mat } of shells) {
        geo.dispose();
        mat.dispose();
        parent.remove(mesh);
      }
      moteGeo.dispose();
      moteMat.dispose();
      parent.remove(motes);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "fog",
  label: "fog",
  family: "mood",
  build,
};
