import type {
  ConceptDescriptor,
  OrbFrame,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";
import { makeChromeGem } from "../orb-kit.ts";

// Gyroscopic data core: 3 concentric chrome torus rings (radii 0.55 / 0.8 / 1.05)
// each on its own axis and spin speed, plus a faceted icosahedron nucleus that
// pulses cyan-to-amber with the voice. Energy scales ring speeds; respond snaps
// rings toward a shared alignment ("lock") then lets them drift apart again.

/** Rotation state for one ring: current Euler angles and target angles. */
interface RingState {
  rx: number;
  ry: number;
  rz: number;
  txRest: number; // natural rest x-tilt (radians)
  tzRest: number; // natural rest z-tilt (radians)
  spinAxis: "x" | "y" | "z"; // which axis the ring spins around
  spinSpeed: number; // radians per second at rest
}

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // --- torus rings -----------------------------------------------------------
  // Three concentric rings, each tilted on a different axis with a different
  // orbital spin speed — classic nested gyroscope.
  const ringDefs: { radius: number; tube: number; state: RingState }[] = [
    {
      radius: 0.55,
      tube: 0.028,
      state: {
        rx: 0,
        ry: 0,
        rz: Math.PI * 0.5,
        txRest: Math.PI * 0.5,
        tzRest: 0,
        spinAxis: "y",
        spinSpeed: 0.72,
      },
    },
    {
      radius: 0.8,
      tube: 0.022,
      state: {
        rx: Math.PI * 0.28,
        ry: 0,
        rz: Math.PI * 0.14,
        txRest: Math.PI * 0.28,
        tzRest: Math.PI * 0.14,
        spinAxis: "x",
        spinSpeed: 0.48,
      },
    },
    {
      radius: 1.05,
      tube: 0.018,
      state: {
        rx: Math.PI * 0.12,
        ry: 0,
        rz: Math.PI * 0.62,
        txRest: Math.PI * 0.12,
        tzRest: Math.PI * 0.62,
        spinAxis: "z",
        spinSpeed: 0.31,
      },
    },
  ];

  const rings: { mesh: any; geo: any; mat: any; state: RingState }[] = [];

  for (const def of ringDefs) {
    const geo = new THREE.TorusGeometry(def.radius, def.tube, 12, 80);
    const mat = makeChromeGem(THREE);
    // faint cyan emissive base
    mat.emissive = new THREE.Color(0.0, 0.55, 0.72);
    mat.emissiveIntensity = 0.18;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = def.state.txRest;
    mesh.rotation.z = def.state.tzRest;
    def.state.rx = def.state.txRest;
    def.state.rz = def.state.tzRest;
    parent.add(mesh);
    rings.push({ mesh, geo, mat, state: def.state });
  }

  // --- nucleus ---------------------------------------------------------------
  // Small faceted icosahedron at the centre — emissive cyan/amber that pulses.
  const nucleusGeo = new THREE.IcosahedronGeometry(0.18, 1);
  const nucleusMat = new THREE.MeshStandardNodeMaterial();
  nucleusMat.metalness = 0.6;
  nucleusMat.roughness = 0.25;
  nucleusMat.color = new THREE.Color(0.1, 0.6, 0.8);
  nucleusMat.emissive = new THREE.Color(0.0, 0.8, 1.0);
  nucleusMat.emissiveIntensity = 0.9;
  const nucleus = new THREE.Mesh(nucleusGeo, nucleusMat);
  parent.add(nucleus);

  // --- inner accent ring (decorative; very thin, fast) ----------------------
  const accentGeo = new THREE.TorusGeometry(0.32, 0.012, 8, 60);
  const accentMat = makeChromeGem(THREE);
  accentMat.emissive = new THREE.Color(0.8, 0.45, 0.0);
  accentMat.emissiveIntensity = 0.3;
  const accentRing = new THREE.Mesh(accentGeo, accentMat);
  accentRing.rotation.x = Math.PI * 0.3;
  parent.add(accentRing);

  // Respond lock: track respond value to detect rising/falling edges and
  // manage the alignment ease-back timer.
  let lastRespond = 0;
  let lockTimer = 0; // seconds until we start easing back to natural orbits

  function frame(f: OrbFrame): void {
    const dt = 0.016; // fixed step; good enough for this animation

    // Detect respond onset to reset lock timer.
    if (f.respond > 0.5 && lastRespond <= 0.5) {
      lockTimer = 1.2; // hold lock for 1.2 s after respond peaks
    }
    lastRespond = f.respond;
    if (lockTimer > 0) lockTimer -= dt;

    const locking = f.respond > 0.1; // respond is currently active
    const locked = locking || lockTimer > 0;

    // Energy boosts spin speed; respond flares the rings to full orbit then
    // eases them into a shared plane ("lock") while responding.
    const speedMul = 1 + f.energy * 1.4;

    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const s = r.state;

      // Accumulate spin on each ring's natural axis.
      const spinDelta = s.spinSpeed * speedMul * dt;

      if (s.spinAxis === "y") {
        s.ry += spinDelta;
      } else if (s.spinAxis === "x") {
        s.rx += spinDelta;
      } else {
        s.rz += spinDelta;
      }

      // Tilt easing: on lock, smoothly pull toward rx=0, rz=0 (shared plane).
      // When lock releases, ease back toward each ring's natural rest tilt.
      const easeRate = locked ? 0.06 : 0.025;
      const targetX = locked ? 0 : s.txRest;
      const targetZ = locked ? 0 : s.tzRest;

      // Only ease the non-spin axes (avoid fighting the spin accumulator).
      if (s.spinAxis !== "x") {
        s.rx += (targetX - s.rx) * easeRate;
      }
      if (s.spinAxis !== "z") {
        s.rz += (targetZ - s.rz) * easeRate;
      }

      r.mesh.rotation.x = s.rx;
      r.mesh.rotation.y = s.ry;
      r.mesh.rotation.z = s.rz;

      // Emissive: cyan base, flares brighter with energy; on respond, shifts
      // toward amber and spikes intensity.
      const cyanR = 0.0;
      const cyanG = 0.55 + f.energy * 0.3;
      const cyanB = 0.72 + f.energy * 0.28;
      // Amber shift during respond
      const ambR = 0.9;
      const ambG = 0.5;
      const ambB = 0.1;
      const t = f.respond * 0.7;
      r.mat.emissive.setRGB(
        cyanR + (ambR - cyanR) * t,
        cyanG + (ambG - cyanG) * t,
        cyanB + (ambB - cyanB) * t,
      );
      r.mat.emissiveIntensity = 0.18 + f.energy * 0.55 + f.respond * 0.45;
    }

    // Accent ring — fast spin around its own axis, warm amber.
    accentRing.rotation.z += 0.022 * (1 + f.energy * 2.0);
    accentMat.emissiveIntensity = 0.3 + f.energy * 0.6 + f.respond * 0.4;

    // Nucleus: pulse scale with energy, spin slowly, flare on respond.
    const pulse = 1 + Math.sin(f.time * 3.8) * 0.06 + f.energy * 0.22;
    const flare = f.respond * 0.25;
    nucleus.scale.setScalar(pulse + flare);
    nucleus.rotation.y = f.time * 0.4;
    nucleus.rotation.x = f.time * 0.27;

    // Nucleus emissive: cyan at rest, amber on respond.
    const nCyanR = 0.0;
    const nCyanG = 0.8;
    const nCyanB = 1.0;
    const nAmbR = 1.0;
    const nAmbG = 0.55;
    const nAmbB = 0.05;
    const nt = f.respond * 0.8;
    nucleusMat.emissive.setRGB(
      nCyanR + (nAmbR - nCyanR) * nt,
      nCyanG + (nAmbG - nCyanG) * nt,
      nCyanB + (nAmbB - nCyanB) * nt,
    );
    nucleusMat.emissiveIntensity =
      0.9 + f.energy * 1.4 + f.respond * 1.2 + Math.sin(f.time * 5.1) * 0.15;
  }

  function dispose(): void {
    for (const r of rings) {
      r.geo.dispose();
      r.mat.dispose();
      parent.remove(r.mesh);
    }
    nucleusGeo.dispose();
    nucleusMat.dispose();
    parent.remove(nucleus);
    accentGeo.dispose();
    accentMat.dispose();
    parent.remove(accentRing);
  }

  return { frame, dispose };
}

export const concept: ConceptDescriptor = {
  id: "datacore",
  label: "datacore",
  family: "sci-fi",
  build,
};
