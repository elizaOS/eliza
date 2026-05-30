import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Hologram — sci-fi projected-scan aesthetic.
//
// Layers:
//   1. Cyan wireframe icosphere — the projected "3D scan" shell.
//   2. ~12 horizontal scanline rings stacked along Y, drifting upward in a loop
//      like a projector sweep passing through the form.
//   3. A faint solid inner sphere giving the projection something to read against.
//
// All animation is plain JS in frame() — no TSL node graphs — so there are zero
// shader compile risks. Reactivity is via material property writes each frame.

const CYAN_R = 0.0;
const CYAN_G = 0.92;
const CYAN_B = 1.0;

// Number of scanline rings that sweep upward through the form.
const SCAN_COUNT = 13;

// Y range over which rings are distributed: slightly wider than the sphere.
const SCAN_YMIN = -1.15;
const SCAN_YMAX = 1.15;
const SCAN_RANGE = SCAN_YMAX - SCAN_YMIN;

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // ── 1. Wireframe icosphere shell ───────────────────────────────────────────
  const icosaGeo = new THREE.IcosahedronGeometry(1.0, 2);
  const wireGeo = new THREE.WireframeGeometry(icosaGeo);
  const wireMat = new THREE.LineBasicNodeMaterial();
  wireMat.color = new THREE.Color(CYAN_R, CYAN_G, CYAN_B);
  wireMat.transparent = true;
  wireMat.opacity = 0.55;
  wireMat.depthWrite = false;
  wireMat.blending = THREE.AdditiveBlending;
  const wireframe = new THREE.LineSegments(wireGeo, wireMat);
  parent.add(wireframe);

  // ── 2. Inner ghost sphere (solid, very faint) ──────────────────────────────
  const innerGeo = new THREE.IcosahedronGeometry(0.88, 1);
  const innerMat = new THREE.MeshBasicNodeMaterial();
  innerMat.color = new THREE.Color(0.0, 0.18, 0.22);
  innerMat.transparent = true;
  innerMat.opacity = 0.18;
  innerMat.depthWrite = false;
  const innerSphere = new THREE.Mesh(innerGeo, innerMat);
  // Render behind the wireframe.
  innerSphere.renderOrder = -1;
  parent.add(innerSphere);

  // ── 3. Scanline rings ──────────────────────────────────────────────────────
  // Thin tori (tube radius very small) stacked at varying Y, all additive cyan.
  // Their Y position drifts upward each frame and wraps, creating a continuous
  // projector-sweep effect.

  interface ScanRing {
    mesh: any;
    geo: any;
    mat: any;
    // Phase offset [0,1) so each ring starts at a different point in the sweep.
    phase: number;
    // Radius of the ring at its rest Y. Pre-computed so rings fit the sphere profile.
    radius: number;
  }

  const rings: ScanRing[] = [];
  for (let i = 0; i < SCAN_COUNT; i += 1) {
    const phase = i / SCAN_COUNT;
    // Starting Y evenly distributed across the sweep range.
    const startY = SCAN_YMIN + phase * SCAN_RANGE;
    // Ring radius follows the sphere profile: r = sqrt(1 - y²), clamped > 0.
    const clampedY = Math.max(-0.98, Math.min(0.98, startY));
    const radius = Math.sqrt(1 - clampedY * clampedY) * 0.98;

    // TorusGeometry(radius, tubeRadius, radialSegs, tubularSegs)
    const geo = new THREE.TorusGeometry(radius, 0.008, 6, 48);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.color = new THREE.Color(CYAN_R, CYAN_G, CYAN_B);
    mat.transparent = true;
    mat.opacity = 0.28;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = startY;
    mesh.rotation.x = Math.PI / 2; // torus lies in the XZ plane
    parent.add(mesh);

    rings.push({ mesh, geo, mat, phase, radius });
  }

  // ── Per-frame state ────────────────────────────────────────────────────────
  // Scanline sweep speed (world-units per second along Y).
  const BASE_SWEEP_SPEED = 0.55;

  // Flicker: a simple pseudo-random state driven by sin superposition.
  let glitchCooldown = 0.0;
  let glitchAngle = 0.0;

  function frame(f: {
    time: number;
    energy: number;
    low: number;
    listen: number;
    respond: number;
  }): void {
    const { time, energy, respond } = f;

    // ── Flicker / shimmer ────────────────────────────────────────────────────
    // Layered sines with incommensurable frequencies for organic shimmer.
    const shimmer =
      Math.sin(time * 7.3) * 0.12 +
      Math.sin(time * 13.7) * 0.06 +
      Math.sin(time * 31.1) * 0.03;
    // Energy raises brightness; respond adds an extra kick.
    const energyBoost = energy * 0.4 + respond * 0.25;
    const wireOpacity = Math.max(0.1, Math.min(0.95, 0.52 + shimmer + energyBoost));
    wireMat.opacity = wireOpacity;

    // ── Colour pulse: briefly shift toward white-blue on respond ─────────────
    const rr = CYAN_R + respond * 0.15;
    const rg = CYAN_G * (0.88 + respond * 0.12);
    const rb = CYAN_B;
    wireMat.color.setRGB(rr, rg, rb);

    // ── Slow base rotation + glitch jump ─────────────────────────────────────
    wireframe.rotation.y = time * 0.07 + glitchAngle;
    wireframe.rotation.x = Math.sin(time * 0.09) * 0.06;

    // Occasional micro-glitch: snap the rotation by a small random offset then
    // decay it away. Glitch frequency scales with energy.
    glitchCooldown -= 0.016;
    if (glitchCooldown <= 0) {
      const glitchChance = 0.06 + energy * 0.18 + respond * 0.12;
      if (Math.random() < glitchChance) {
        glitchAngle = (Math.random() - 0.5) * 0.18;
      }
      glitchCooldown = 0.08 + Math.random() * 0.14;
    }
    // Decay glitch angle back to 0.
    glitchAngle *= 0.82;

    // ── Inner sphere subtle pulse ─────────────────────────────────────────────
    innerSphere.rotation.y = -time * 0.04;
    innerMat.opacity = 0.14 + energy * 0.08 + shimmer * 0.03;

    // ── Scanline sweep ────────────────────────────────────────────────────────
    // Speed increases with energy; a "pulse" on respond sends a bright ring through.
    const sweepSpeed = BASE_SWEEP_SPEED * (1 + energy * 1.2 + respond * 0.8);

    for (const ring of rings) {
      // Advance the ring's Y position.
      const elapsed = time * sweepSpeed;
      // Each ring's current position within the sweep range, phase-offset.
      const t01 = ((ring.phase + elapsed / SCAN_RANGE) % 1 + 1) % 1;
      const y = SCAN_YMIN + t01 * SCAN_RANGE;
      ring.mesh.position.y = y;

      // Recompute radius to follow the sphere profile at this Y.
      const clampedY = Math.max(-0.98, Math.min(0.98, y));
      const r = Math.sqrt(1 - clampedY * clampedY) * 0.98;
      ring.mesh.scale.set(r / ring.radius, 1, r / ring.radius);

      // Opacity: brighter near the equator, dimmer near poles; energy raises all.
      // On respond: one ring (closest to Y=0 at this moment) gets a bright pulse.
      const poleAttenuation = Math.sqrt(Math.max(0, 1 - clampedY * clampedY));
      const respondPulse = respond * (1 - Math.abs(y) / 1.15) * 0.7;
      const baseOpacity = 0.18 + energy * 0.22 + respondPulse;
      ring.mat.opacity = Math.max(0.04, Math.min(0.85, baseOpacity * poleAttenuation));

      // Scanline colour shift: tint slightly brighter on respond.
      const sg = CYAN_G * (0.9 + respond * 0.1);
      ring.mat.color.setRGB(CYAN_R, sg, CYAN_B);
    }
  }

  function dispose(): void {
    // Wireframe
    wireGeo.dispose();
    wireMat.dispose();
    parent.remove(wireframe);
    // Inner sphere
    innerGeo.dispose();
    innerMat.dispose();
    parent.remove(innerSphere);
    // Scanline rings
    for (const ring of rings) {
      ring.geo.dispose();
      ring.mat.dispose();
      parent.remove(ring.mesh);
    }
  }

  return { frame, dispose };
}

export const concept: ConceptDescriptor = {
  id: "hologram",
  label: "hologram",
  family: "sci-fi",
  build,
};
