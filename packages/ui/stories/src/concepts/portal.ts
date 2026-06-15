import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Number of hoops in the tunnel funnel.
const HOOP_COUNT = 20;
// Tunnel recedes along -Z (viewer looks into it from +Z). Front hoop sits at
// z=0, hoops are spaced and shrink so the funnel reads as perspective depth.
const FRONT_Z = 0.0;
const BACK_Z = -2.2;
// Front hoop radius; back hoop is much smaller to sell the depth illusion.
const FRONT_R = 1.08;
const BACK_R = 0.18;
// Hoop tube radius (thin wire look).
const TUBE_R = 0.018;

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // ---- tunnel hoops -------------------------------------------------------
  // Each hoop is a thin TorusGeometry with its own emissive material so we can
  // color them independently and drive emissiveIntensity per-frame.
  type HoopEntry = {
    mesh: any;
    geo: any;
    mat: any;
    baseRoll: number; // initial Z rotation so spiral-staggering is baked in
    zOffset: number; // starting Z position (recycled during pull-in animation)
    recycleZ: number; // the Z value at which we snap this hoop back to the rear
  };

  const hoops: HoopEntry[] = [];

  for (let i = 0; i < HOOP_COUNT; i++) {
    const t: number = i / (HOOP_COUNT - 1); // 0 = front, 1 = back
    const radius: number = FRONT_R + (BACK_R - FRONT_R) * t;
    const zPos: number = FRONT_Z + (BACK_Z - FRONT_Z) * t;

    const geo = new THREE.TorusGeometry(radius, TUBE_R, 8, 80);
    const mat = new THREE.MeshStandardNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    // NormalBlending so the saturated indigo-violet rings read against the
    // bright sky; additive emissive rings wash to white on it.
    mat.blending = THREE.NormalBlending;
    // Deep violet → bright indigo near the front; rims cool near the back.
    const brightness: number = 1.0 - t * 0.55;
    mat.color = new THREE.Color(0.0, 0.0, 0.0);
    mat.emissive = new THREE.Color(
      0.34 * brightness,
      0.12 * brightness,
      0.95 * brightness,
    );
    mat.emissiveIntensity = 0.85 + (1.0 - t) * 0.5;
    mat.opacity = 0.6 + (1.0 - t) * 0.35;
    mat.roughness = 0.4;
    mat.metalness = 0.0;

    const mesh = new THREE.Mesh(geo, mat);
    // Bake a spiral roll so adjacent rings are offset; tilted slightly for depth.
    const roll: number = (i / HOOP_COUNT) * Math.PI * 1.4;
    mesh.rotation.z = roll;
    mesh.rotation.x = 0.08 + t * 0.18; // slight tilt toward viewer
    mesh.position.z = zPos;
    parent.add(mesh);

    hoops.push({
      mesh,
      geo,
      mat,
      baseRoll: roll,
      zOffset: zPos,
      recycleZ: BACK_Z - (BACK_Z - FRONT_Z) / HOOP_COUNT, // snap-to depth
    });
  }

  // ---- event-horizon disc (glowing center at deep z) ----------------------
  const horizonGeo = new THREE.CircleGeometry(BACK_R * 1.8, 48);
  const horizonMat = new THREE.MeshStandardNodeMaterial();
  horizonMat.transparent = true;
  horizonMat.depthWrite = false;
  horizonMat.blending = THREE.NormalBlending;
  horizonMat.color = new THREE.Color(0.0, 0.0, 0.0);
  horizonMat.emissive = new THREE.Color(0.55, 0.3, 1.0);
  horizonMat.emissiveIntensity = 1.4;
  horizonMat.opacity = 0.92;
  horizonMat.roughness = 0.0;
  horizonMat.metalness = 0.0;
  const horizon = new THREE.Mesh(horizonGeo, horizonMat);
  horizon.position.z = BACK_Z - 0.05;
  parent.add(horizon);

  // ---- hot core at the singularity ----------------------------------------
  const coreGeo = new THREE.CircleGeometry(BACK_R * 0.65, 32);
  const coreMat = new THREE.MeshStandardNodeMaterial();
  coreMat.transparent = true;
  coreMat.depthWrite = false;
  coreMat.blending = THREE.NormalBlending;
  coreMat.color = new THREE.Color(0.0, 0.0, 0.0);
  coreMat.emissive = new THREE.Color(0.85, 0.78, 1.0);
  coreMat.emissiveIntensity = 2.0;
  coreMat.opacity = 1.0;
  coreMat.roughness = 0.0;
  coreMat.metalness = 0.0;
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.z = BACK_Z - 0.06;
  parent.add(core);

  // ---- funnel group (whole tunnel spins as a unit) ------------------------
  // All hoops + horizon + core are already added to parent; we spin via the
  // individual hoop rotations so we avoid an extra Group nesting level.

  // Pull-in: each hoop streams toward the viewer (toward +Z) then snaps back to
  // the rear. Track each hoop's live Z offset separately so they stay evenly
  // distributed as they travel.
  const hoopLiveZ: number[] = hoops.map((h) => h.zOffset);
  const TUNNEL_LENGTH: number = Math.abs(BACK_Z - FRONT_Z);
  const Z_STEP: number = TUNNEL_LENGTH / HOOP_COUNT;

  // ---- spiral arm lines (3 twisted strands) -------------------------------
  // Each arm is a LineSegments with HOOP_COUNT segments spiraling inward.
  type ArmEntry = { line: any; geo: any; mat: any };
  const ARM_COUNT = 3;
  const VERTS_PER_ARM = HOOP_COUNT + 1;

  const arms: ArmEntry[] = [];
  for (let a = 0; a < ARM_COUNT; a++) {
    const armGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(VERTS_PER_ARM * 3);
    armGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const armMat = new THREE.LineBasicNodeMaterial();
    armMat.transparent = true;
    armMat.depthWrite = false;
    armMat.blending = THREE.NormalBlending;
    armMat.color = new THREE.Color(0.4, 0.18, 0.92);
    armMat.opacity = 0.6;
    const line = new THREE.Line(armGeo, armMat);
    line.frustumCulled = false;
    parent.add(line);
    arms.push({ line, geo: armGeo, mat: armMat });
  }

  // ---- frame ---------------------------------------------------------------
  // Persistent state across frames.
  let globalSpin: number = 0.0;
  let respondPulse: number = 0.0; // smoothed respond value for pulse wave

  function frame(f: {
    time: number;
    energy: number;
    low: number;
    listen: number;
    respond: number;
  }): void {
    const energy: number = f.energy;
    const respond: number = f.respond;

    // Smooth respond pulse for the bright wave that travels down the tunnel.
    respondPulse += (respond - respondPulse) * 0.12;

    // Base swirl speed + energy boost.
    const swirlSpeed: number = 0.28 + energy * 0.55 + respond * 0.35;
    globalSpin += swirlSpeed * 0.016; // ~60fps delta approximation

    // Pull-in drift speed: rings travel toward +Z (the viewer), then snap back.
    const driftSpeed: number = (0.18 + energy * 0.38 + respond * 0.22) * 0.016;

    // Update each hoop.
    for (let i = 0; i < HOOP_COUNT; i++) {
      const h = hoops[i];

      // Advance Z (toward +Z = toward viewer).
      hoopLiveZ[i] += driftSpeed;

      // Recycle: when a hoop crosses the front plane, snap it back to the rear.
      if (hoopLiveZ[i] > FRONT_Z + Z_STEP * 0.5) {
        hoopLiveZ[i] = BACK_Z;
      }

      // Parametric t (0 = back, 1 = front) based on live Z.
      const t: number = Math.max(
        0.0,
        Math.min(1.0, (hoopLiveZ[i] - BACK_Z) / TUNNEL_LENGTH),
      );
      const radius: number = BACK_R + (FRONT_R - BACK_R) * t;

      h.mesh.position.z = hoopLiveZ[i];
      h.mesh.scale.setScalar(
        radius /
          (BACK_R +
            ((FRONT_R - BACK_R) * (h.zOffset - BACK_Z)) / TUNNEL_LENGTH),
      );

      // Counter-spin every other ring so adjacent rings churn against each other.
      const dir: number = i % 2 === 0 ? 1.0 : -1.3;
      h.mesh.rotation.z = h.baseRoll + globalSpin * dir;

      // Emissive: brighter at the front (high t), pulsed by energy. Kept modest
      // so NormalBlending preserves the indigo hue instead of clipping to white.
      const baseBright: number = 0.55 + t * 0.6;
      const energyBoost: number = energy * 0.5 + respond * 0.4;

      // Pulse wave: a bright band that travels down the tunnel on f.respond.
      // The wave front is keyed to the normalized position of each hoop.
      const wavePhase: number = (f.time * 1.8) % 1.0; // front of wave, 0→1 (front→back)
      const hoopT: number = 1.0 - t; // 0=front, 1=back for wave indexing
      const waveDist: number = Math.abs(hoopT - wavePhase);
      const waveFall: number = Math.max(0.0, 1.0 - waveDist * 8.0);
      const waveFlash: number = waveFall * respondPulse * 1.0;

      h.mat.emissiveIntensity = baseBright + energyBoost + waveFlash;

      // Fade near-back hoops slightly (they'll snap soon and we don't want a pop).
      const fadeEdge: number = Math.min(
        1.0,
        (hoopLiveZ[i] - BACK_Z) / (Z_STEP * 1.5),
      );
      const fadeFront: number = Math.min(
        1.0,
        (FRONT_Z - hoopLiveZ[i] + Z_STEP) / Z_STEP,
      );
      h.mat.opacity = 0.35 + t * 0.45 * Math.min(fadeEdge, fadeFront);
    }

    // Event horizon glow: rises strongly on respond and energy.
    const horizonPulse: number = Math.sin(f.time * 5.2) * 0.15 + 0.85;
    horizonMat.emissiveIntensity =
      (1.2 + energy * 0.8 + respondPulse * 1.2) * horizonPulse;
    horizonMat.emissive.setRGB(
      0.3 + respondPulse * 0.55,
      0.12 + energy * 0.25,
      0.9 + respondPulse * 0.1,
    );

    // Hot core: flares white on respond.
    const corePulse: number = Math.sin(f.time * 9.3) * 0.2 + 0.8;
    coreMat.emissiveIntensity =
      (1.3 + energy * 0.6 + respondPulse * 1.2) * corePulse;
    coreMat.emissive.setRGB(
      0.7 + respondPulse * 0.3,
      0.6 + respondPulse * 0.4,
      1.0,
    );

    // Spiral arms: recompute vertex positions every frame.
    for (let a = 0; a < ARM_COUNT; a++) {
      const baseAngle: number = (a / ARM_COUNT) * Math.PI * 2.0;
      const pos: any = arms[a].geo.attributes.position;

      for (let v = 0; v < VERTS_PER_ARM; v++) {
        const vt: number = v / (VERTS_PER_ARM - 1); // 0=front, 1=back
        const vz: number = FRONT_Z + (BACK_Z - FRONT_Z) * vt;
        const vr: number = FRONT_R * (1.0 - vt) + BACK_R * vt;
        // Spiral twist increases toward the back.
        const twist: number = vt * Math.PI * 3.2;
        const angle: number = baseAngle + twist + globalSpin * 1.5;
        pos.setXYZ(v, Math.cos(angle) * vr, Math.sin(angle) * vr, vz);
      }
      pos.needsUpdate = true;

      // Arm brightness rises with energy.
      arms[a].mat.opacity = 0.22 + energy * 0.42 + respondPulse * 0.3;
    }
  }

  function dispose(): void {
    for (const h of hoops) {
      h.geo.dispose();
      h.mat.dispose();
      parent.remove(h.mesh);
    }
    horizonGeo.dispose();
    horizonMat.dispose();
    parent.remove(horizon);
    coreGeo.dispose();
    coreMat.dispose();
    parent.remove(core);
    for (const arm of arms) {
      arm.geo.dispose();
      arm.mat.dispose();
      parent.remove(arm.line);
    }
  }

  return { frame, dispose };
}

export const concept: ConceptDescriptor = {
  id: "portal",
  label: "portal",
  family: "sci-fi",
  build,
};
