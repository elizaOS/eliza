/**
 * Nebula orb concept: TSL shader module + uniforms for the voice-orb gallery.
 */
import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Nebula — cosmic dust cloud / small galaxy.
// ~560 dust points clustered toward centre (radius = rand^0.6), colored
// deep purple→blue→magenta by radius via per-point vertex colors, additive.
// ~40 near-white star points scattered in the cloud for depth.
// A tiny bright core sphere anchors the centre.
// All animation runs in JS: swirl (rotation.y), breathe (points.scale),
// twinkle (starMat.opacity jitter), magenta flush (color lerp on respond).
// No TSL node graphs used.

const DUST_COUNT = 680;
const STAR_COUNT = 44;

// Purple/blue/magenta palette as [r, g, b] in 0-1 — keyed by normalised radius.
// r=0 → deep violet core, r=0.5 → vivid indigo-blue, r=1 → dim magenta edge.
function dustColor(r: number): [number, number, number] {
  if (r < 0.35) {
    // core: deep violet → indigo
    const t = r / 0.35;
    return [
      0.38 + t * 0.08, // r: 0.38 → 0.46
      0.05 + t * 0.1, // g: 0.05 → 0.15
      0.72 + t * 0.22, // b: 0.72 → 0.94
    ];
  }
  if (r < 0.7) {
    // mid: indigo-blue → blue-cyan
    const t = (r - 0.35) / 0.35;
    return [
      0.46 - t * 0.28, // r: 0.46 → 0.18
      0.15 + t * 0.12, // g: 0.15 → 0.27
      0.94 - t * 0.1, // b: 0.94 → 0.84
    ];
  }
  // outer: blue → dim magenta edge
  const t = (r - 0.7) / 0.3;
  return [
    0.18 + t * 0.42, // r: 0.18 → 0.60
    0.27 - t * 0.2, // g: 0.27 → 0.07
    0.84 - t * 0.26, // b: 0.84 → 0.58
  ];
}

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // ---- Dust cloud ----
  const dustPosArr = new Float32Array(DUST_COUNT * 3);
  const dustColArr = new Float32Array(DUST_COUNT * 3);
  // Cache base positions for breathe animation (scale read directly from points.scale).
  const dustBase = new Float32Array(DUST_COUNT * 3);

  for (let i = 0; i < DUST_COUNT; i += 1) {
    // Cluster toward centre: radius = rand^0.6 → denser in middle.
    const rawR = Math.random();
    const r = rawR ** 0.6 * 1.28; // max radius 1.28, within 1.3
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const sinPhi = Math.sin(phi);
    const x = r * sinPhi * Math.cos(theta);
    const y = r * sinPhi * Math.sin(theta);
    const z = r * Math.cos(phi);
    dustPosArr[i * 3] = x;
    dustPosArr[i * 3 + 1] = y;
    dustPosArr[i * 3 + 2] = z;
    dustBase[i * 3] = x;
    dustBase[i * 3 + 1] = y;
    dustBase[i * 3 + 2] = z;

    // Color by normalised radius [0,1]
    const rn = r / 1.28;
    const [cr, cg, cb] = dustColor(rn);
    // Keep outer points fairly vivid so the cloud reads on the bright sky.
    const fade = 1.0 - rn * 0.3;
    dustColArr[i * 3] = cr * fade;
    dustColArr[i * 3 + 1] = cg * fade;
    dustColArr[i * 3 + 2] = cb * fade;
  }

  const dustGeo = new THREE.BufferGeometry();
  const dustPosAttr = new THREE.BufferAttribute(dustPosArr, 3);
  dustGeo.setAttribute("position", dustPosAttr);
  dustGeo.setAttribute("color", new THREE.BufferAttribute(dustColArr, 3));

  // NormalBlending (not additive): additive dust adds toward white and vanishes
  // against the bright cloud sky. Solid saturated pigment reads instead.
  const dustMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  dustMat.vertexColors = true;
  dustMat.size = 0.075;
  dustMat.sizeAttenuation = true;
  dustMat.opacity = 0.92;

  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  parent.add(dust);

  // ---- Star points (near-white, slightly larger, scattered throughout) ----
  const starPosArr = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i += 1) {
    const r = 0.08 + Math.random() * 1.18; // range 0.08..1.26
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const sinPhi = Math.sin(phi);
    starPosArr[i * 3] = r * sinPhi * Math.cos(theta);
    starPosArr[i * 3 + 1] = r * sinPhi * Math.sin(theta);
    starPosArr[i * 3 + 2] = r * Math.cos(phi);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPosArr, 3));

  const starMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  // Bright magenta-pink sparkles — near-white stars disappear on the pale sky.
  starMat.color = new THREE.Color(1.0, 0.52, 0.86);
  starMat.size = 0.055;
  starMat.sizeAttenuation = true;
  starMat.opacity = 0.9;

  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  parent.add(stars);

  // ---- Soft glowing core — a few large very-dim additive points at origin ----
  const corePosArr = new Float32Array(9); // 3 points at tiny offsets
  corePosArr[0] = 0.0;
  corePosArr[1] = 0.0;
  corePosArr[2] = 0.0;
  corePosArr[3] = 0.01;
  corePosArr[4] = 0.0;
  corePosArr[5] = 0.01;
  corePosArr[6] = -0.01;
  corePosArr[7] = 0.01;
  corePosArr[8] = 0.0;
  const coreGeo = new THREE.BufferGeometry();
  coreGeo.setAttribute("position", new THREE.BufferAttribute(corePosArr, 3));

  const coreMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  coreMat.color = new THREE.Color(0.42, 0.16, 0.78);
  coreMat.size = 0.42;
  coreMat.sizeAttenuation = true;
  coreMat.opacity = 0.5;

  const corePoints = new THREE.Points(coreGeo, coreMat);
  corePoints.frustumCulled = false;
  parent.add(corePoints);

  // Differential tilt group for slow galactic-plane tilt effect
  dust.rotation.x = 0.22;
  stars.rotation.x = 0.18;

  // Track previous twinkle value for smoothing
  let twinklePhase = 0;

  return {
    frame(f) {
      // --- Swirl: base slow rotation + energy boost ---
      const swirlSpeed = 0.055 + f.energy * 0.18;
      dust.rotation.y = f.time * swirlSpeed;
      stars.rotation.y = f.time * (swirlSpeed * 0.65);
      corePoints.rotation.y = f.time * swirlSpeed * 1.1;

      // Gentle differential drift on x/z axes for galactic depth
      dust.rotation.z = Math.sin(f.time * 0.07) * 0.06;
      stars.rotation.z = Math.cos(f.time * 0.05) * 0.05;

      // --- Breathe: scale cloud outward on respond ---
      const breathe = 1.0 + f.respond * 0.12 + f.energy * 0.06;
      dust.scale.setScalar(breathe);
      stars.scale.setScalar(0.98 + f.respond * 0.1 + f.energy * 0.04);

      // --- Brightness: energy pulses overall opacity ---
      dustMat.opacity = 0.62 + f.energy * 0.32 + f.respond * 0.08;

      // --- Star twinkle: jitter opacity on respond ---
      twinklePhase += 0.09;
      const twinkle =
        0.72 +
        Math.sin(twinklePhase * 2.3) * 0.18 +
        Math.cos(twinklePhase * 3.7) * 0.08;
      starMat.opacity = twinkle * (0.7 + f.respond * 0.35 + f.energy * 0.25);

      // --- Magenta flush: shift dust color on respond ---
      // We lerp the color attribute toward magenta-pink by re-scaling the color buffer.
      // Simple approach: shift mat color tint (vertexColors combine multiplicatively with .color).
      // On respond, flush from white tint toward bright magenta; neutral otherwise.
      const magenta = f.respond;
      // PointsNodeMaterial.color multiplies vertex colors; use it as a tint.
      dustMat.color.setRGB(
        1.0 + magenta * 0.35, // boost red channel
        1.0 - magenta * 0.28, // suppress green
        1.0 + magenta * 0.18, // slight blue boost
      );

      // Core pulses on energy/respond
      coreMat.opacity = 0.22 + f.energy * 0.28 + f.respond * 0.22;
      coreMat.size = 0.38 + f.energy * 0.18 + f.respond * 0.12;
    },

    dispose() {
      dustGeo.dispose();
      dustMat.dispose();
      starGeo.dispose();
      starMat.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      parent.remove(dust);
      parent.remove(stars);
      parent.remove(corePoints);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "nebula",
  label: "nebula",
  family: "abstract",
  build,
};
