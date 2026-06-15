import type {
  ConceptDescriptor,
  OrbFrame,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Nanobot swarm: ~120 metallic shards (TetrahedronGeometry) distributed on a
// unit sphere. At rest they sit on a tight shell (~r 0.95), gently jittering
// and spinning as a coherent drone-ball. On energy they fly outward and tumble
// faster; on respond they scatter further and a ripple of orange emissive
// brightness sweeps through them by instance index. Purely JS-animated via
// InstancedMesh + Object3D dummy — no TSL node graphs, zero shader-compile risk.

const COUNT = 120;

// Fibonacci-lattice unit-sphere distribution — evenly spaced, no poles.
function fibonacciSphere(n: number): Float32Array {
  const dirs = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    dirs[i * 3] = Math.cos(theta) * r;
    dirs[i * 3 + 1] = y;
    dirs[i * 3 + 2] = Math.sin(theta) * r;
  }
  return dirs;
}

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // Per-instance precomputed data.
  const baseDirs: Float32Array = fibonacciSphere(COUNT);
  const phases: number[] = new Array<number>(COUNT);
  const spinAxes: number[] = new Array<number>(COUNT * 3);
  const spinSpeeds: number[] = new Array<number>(COUNT);
  const jitterSeeds: number[] = new Array<number>(COUNT * 3);

  for (let i = 0; i < COUNT; i++) {
    phases[i] = Math.random() * Math.PI * 2;
    // Random unit vector for per-shard spin axis.
    const ax = Math.random() * 2 - 1;
    const ay = Math.random() * 2 - 1;
    const az = Math.random() * 2 - 1;
    const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    spinAxes[i * 3] = ax / al;
    spinAxes[i * 3 + 1] = ay / al;
    spinAxes[i * 3 + 2] = az / al;
    spinSpeeds[i] = 0.4 + Math.random() * 1.0;
    jitterSeeds[i * 3] = Math.random() * 6.28;
    jitterSeeds[i * 3 + 1] = Math.random() * 6.28;
    jitterSeeds[i * 3 + 2] = Math.random() * 6.28;
  }

  // Thin tetrahedral shard — TetrahedronGeometry radius 0.07.
  const geo = new THREE.TetrahedronGeometry(0.07, 0);

  // Polished metal: metalness 1, roughness 0.25, faint orange emissive base.
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.metalness = 1;
  mat.roughness = 0.25;
  mat.color = new THREE.Color(0.82, 0.84, 0.88);
  // Start with a dim orange-tinted emissive; brightened per-frame on the shared mat.
  mat.emissive = new THREE.Color(1.0, 0.34, 0.0);
  mat.emissiveIntensity = 0.04;

  const inst = new THREE.InstancedMesh(geo, mat, COUNT);
  inst.frustumCulled = false;

  // Accent-tinted emissive ring shell (BackSide sphere) that subtly rings the
  // whole swarm and pulses with energy — drawn behind everything.
  const ringGeo = new THREE.SphereGeometry(1.02, 24, 12);
  const ringMat = new THREE.MeshBasicNodeMaterial();
  ringMat.color = new THREE.Color(1.0, 0.34, 0.0);
  ringMat.transparent = true;
  ringMat.opacity = 0.0; // driven each frame
  ringMat.side = THREE.BackSide;
  ringMat.depthWrite = false;
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.renderOrder = -1;

  parent.add(ring);
  parent.add(inst);

  const dummy = new THREE.Object3D();
  // Quaternion scratch for per-shard spin — avoids Euler gimbal noise.
  const quat = new THREE.Quaternion();
  const axis = new THREE.Vector3();

  return {
    frame(f: OrbFrame): void {
      const t: number = f.time;
      const energy: number = f.energy;
      const respond: number = f.respond;

      // Shell radius: resting 0.95, expands outward with energy + respond.
      const shellR: number = 0.95 + energy * 0.55 + respond * 0.25;

      // Global tumble speed scales with energy.
      const tumble: number = 1.0 + energy * 2.5;

      // Respond ripple: a phase wave sweeping from index 0 → COUNT over time.
      // Each shard's wave = how "lit" it is. Wave speed ∝ respond.
      const waveSpeed: number = 3.0;

      for (let i = 0; i < COUNT; i++) {
        const ix: number = i * 3;
        const bx: number = baseDirs[ix];
        const by: number = baseDirs[ix + 1];
        const bz: number = baseDirs[ix + 2];
        const ph: number = phases[i];

        // Jitter: small sinusoidal wobble in all three axes at rest.
        const jx: number = jitterSeeds[ix];
        const jy: number = jitterSeeds[ix + 1];
        const jz: number = jitterSeeds[ix + 2];
        const jitterAmt: number = 0.018 + energy * 0.012;
        const jitterX: number = Math.sin(t * 1.1 + jx) * jitterAmt;
        const jitterY: number = Math.sin(t * 0.9 + jy) * jitterAmt;
        const jitterZ: number = Math.sin(t * 1.3 + jz) * jitterAmt;

        // Radius per-instance: base shell + jitter radial offset.
        const radialJitter: number =
          Math.sin(t * 0.7 + ph) * 0.012 * (1 + energy);
        const r: number = shellR + radialJitter;

        dummy.position.set(
          bx * r + jitterX,
          by * r + jitterY,
          bz * r + jitterZ,
        );

        // Per-shard spin on its own random axis — speed ramps with energy.
        const spinAngle: number = t * spinSpeeds[i] * tumble + ph;
        axis.set(spinAxes[ix], spinAxes[ix + 1], spinAxes[ix + 2]);
        quat.setFromAxisAngle(axis, spinAngle);
        dummy.quaternion.copy(quat);

        // Scale: slight pulse with energy, tiny variation per shard.
        const scaleBase: number = 0.85 + 0.15 * ((i & 7) / 7);
        dummy.scale.setScalar(scaleBase * (1 + energy * 0.35));

        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;

      // Respond emissive ripple: sweep a brightness wave through the shard
      // emissive. Because InstancedMesh shares one material the ripple is
      // expressed as a global brightness surge timed to respond onset.
      const ripplePhase: number = (t * waveSpeed) % (Math.PI * 2);
      const ripplePulse: number = Math.max(0, Math.sin(ripplePhase)) * respond;
      const baseEmissive: number = 0.04 + energy * 0.18 + ripplePulse * 0.55;
      mat.emissiveIntensity = baseEmissive;

      // Ring shell opacity breathes with energy and respond.
      ringMat.opacity = 0.025 + energy * 0.06 + respond * 0.04;
    },

    dispose(): void {
      geo.dispose();
      mat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      parent.remove(inst);
      parent.remove(ring);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "swarmbot",
  label: "swarmbot",
  family: "sci-fi",
  build,
};
