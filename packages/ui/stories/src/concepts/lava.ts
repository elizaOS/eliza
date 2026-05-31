import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";
import { makeCrystalGlass } from "../orb-kit.ts";

// Per-blob tuning data stored in a flat Float32Array.
// Layout (BLOB_STRIDE = 6 floats per blob): phase, ySpeed, xDrift, yCenter, radius, swirlAmp
const BLOB_COUNT = 7;
const BLOB_STRIDE = 6;

// Warm palette: deep crimson → blood orange → amber (one entry per blob).
const BLOB_COLORS: readonly [number, number, number][] = [
  [0.72, 0.04, 0.01], // deep crimson
  [0.82, 0.10, 0.01], // dark red
  [0.90, 0.20, 0.01], // red-orange
  [0.95, 0.30, 0.02], // orange-red
  [0.98, 0.42, 0.02], // orange
  [0.72, 0.06, 0.02], // crimson (slightly different)
  [0.88, 0.16, 0.01], // warm red
] as const;

const BLOB_RADII: readonly number[] = [0.42, 0.38, 0.45, 0.36, 0.40, 0.43, 0.37] as const;

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // --- containment glass shell -----------------------------------------------
  const shellGeo = new THREE.SphereGeometry(1.05, 48, 48);
  const shellMat = makeCrystalGlass(THREE);
  // Warmer attenuation tint so thick glass reads amber-gold rather than icy blue.
  shellMat.attenuationColor = new THREE.Color(1.0, 0.72, 0.3);
  shellMat.attenuationDistance = 2.5;
  const shell = new THREE.Mesh(shellGeo, shellMat);
  parent.add(shell);

  // --- lava blobs ------------------------------------------------------------
  // Each blob is a SphereGeometry driven entirely by JS in frame().
  // Radii, y-center positions, phases, and speeds are staggered so blobs are
  // always at different stages of rising / sinking simultaneously.
  const blobData = new Float32Array(BLOB_COUNT * BLOB_STRIDE);
  const blobMeshes: any[] = [];
  const blobGeos: any[] = [];
  const blobMats: any[] = [];

  for (let i = 0; i < BLOB_COUNT; i += 1) {
    const phase = (i / BLOB_COUNT) * Math.PI * 2 + Math.random() * 0.8;
    const ySpeed = 0.18 + (i % 3) * 0.07 + Math.random() * 0.06; // 0.18–0.38 rad/s
    const xDrift = (Math.random() - 0.5) * 0.5;
    const yCenter = (Math.random() - 0.5) * 0.7;
    const radius: number = BLOB_RADII[i];
    const swirlAmp = 0.18 + Math.random() * 0.18;

    blobData[i * BLOB_STRIDE + 0] = phase;
    blobData[i * BLOB_STRIDE + 1] = ySpeed;
    blobData[i * BLOB_STRIDE + 2] = xDrift;
    blobData[i * BLOB_STRIDE + 3] = yCenter;
    blobData[i * BLOB_STRIDE + 4] = radius;
    blobData[i * BLOB_STRIDE + 5] = swirlAmp;

    const geo = new THREE.SphereGeometry(radius, 22, 22);
    const mat = new THREE.MeshStandardNodeMaterial();
    const [cr, cg, cb] = BLOB_COLORS[i];
    mat.color = new THREE.Color(cr * 0.6, cg * 0.6, cb * 0.6);
    mat.emissive = new THREE.Color(cr, cg, cb);
    mat.emissiveIntensity = 0.8;
    mat.roughness = 0.42;
    mat.metalness = 0.0;
    mat.transparent = false;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      xDrift + (Math.random() - 0.5) * 0.3,
      yCenter,
      (Math.random() - 0.5) * 0.3,
    );
    parent.add(mesh);
    blobMeshes.push(mesh);
    blobGeos.push(geo);
    blobMats.push(mat);
  }

  // --- rising bubble specks --------------------------------------------------
  // Small additive Points that drift upward and cycle, reading as released gas.
  const BUBBLE_COUNT = 28;
  const bubbleData = new Float32Array(BUBBLE_COUNT * 4); // phase, x, z, speed
  for (let i = 0; i < BUBBLE_COUNT; i += 1) {
    bubbleData[i * 4 + 0] = Math.random() * Math.PI * 2;
    bubbleData[i * 4 + 1] = (Math.random() - 0.5) * 1.1;
    bubbleData[i * 4 + 2] = (Math.random() - 0.5) * 1.1;
    bubbleData[i * 4 + 3] = 0.14 + Math.random() * 0.16;
  }

  const bubblePos = new Float32Array(BUBBLE_COUNT * 3);
  const bubbleGeo = new THREE.BufferGeometry();
  bubbleGeo.setAttribute("position", new THREE.BufferAttribute(bubblePos, 3));
  const bubbleMat = new THREE.PointsNodeMaterial();
  bubbleMat.color = new THREE.Color(1.0, 0.65, 0.2);
  bubbleMat.transparent = true;
  bubbleMat.opacity = 0.55;
  bubbleMat.depthWrite = false;
  bubbleMat.blending = THREE.AdditiveBlending;
  bubbleMat.size = 0.022;
  bubbleMat.sizeAttenuation = true;
  const bubblePoints = new THREE.Points(bubbleGeo, bubbleMat);
  bubblePoints.frustumCulled = false;
  parent.add(bubblePoints);

  const bubblePosAttr = bubbleGeo.attributes.position as {
    setXYZ: (i: number, x: number, y: number, z: number) => void;
    needsUpdate: boolean;
  };

  // Accumulated shell rotation so it doesn't reset on re-entry.
  let shellAngle = 0;

  return {
    frame(f) {
      // Voice reactivity: blobs churn faster + glow hotter on energy/respond.
      const churnSpeed = (1.0 + f.energy * 1.4) * (1.0 + f.respond * 0.8);

      // --- animate blobs -----------------------------------------------------
      for (let i = 0; i < BLOB_COUNT; i += 1) {
        const phase: number = blobData[i * BLOB_STRIDE + 0];
        const ySpeed: number = blobData[i * BLOB_STRIDE + 1];
        const xDrift: number = blobData[i * BLOB_STRIDE + 2];
        const yCenter: number = blobData[i * BLOB_STRIDE + 3];
        const radius: number = blobData[i * BLOB_STRIDE + 4];
        const swirlAmp: number = blobData[i * BLOB_STRIDE + 5];

        const t = f.time * ySpeed * churnSpeed + phase;
        // Vertical: slow sine rise-and-sink within the lamp.
        const py = yCenter + Math.sin(t) * 0.55;
        // Lateral: secondary sines at different frequencies give gloopy swirl.
        const px = xDrift + Math.sin(t * 0.53 + phase) * swirlAmp * 0.6;
        const pz = Math.cos(t * 0.61 + phase) * swirlAmp * 0.5;

        // Keep blobs inside the shell (radius 1.05 minus blob radius and a gap).
        const maxR = 0.9 - radius * 0.5;
        const lenXZ = Math.sqrt(px * px + pz * pz);
        const clampedX = lenXZ > maxR ? (px / lenXZ) * maxR : px;
        const clampedZ = lenXZ > maxR ? (pz / lenXZ) * maxR : pz;
        const clampedY = Math.max(-0.85, Math.min(0.85, py));

        const mesh = blobMeshes[i];
        mesh.position.set(clampedX, clampedY, clampedZ);

        // Blobs swell on energy (gloopy expansion) with a subtle micro-pulse.
        mesh.scale.setScalar(1.0 + f.energy * 0.22 + Math.sin(t * 1.3) * 0.04);

        // Emissive intensity heats up with energy and respond.
        const mat = blobMats[i];
        mat.emissiveIntensity = 0.7 + f.energy * 0.55 + f.respond * 0.25;

        // Shift colour slightly warmer (more orange) while responding.
        const warmth = f.respond * 0.15;
        const [cr, cg, cb] = BLOB_COLORS[i];
        mat.emissive.setRGB(
          Math.min(1.0, cr + warmth),
          Math.min(1.0, cg + warmth * 0.4),
          cb,
        );
      }

      // --- animate rising bubbles --------------------------------------------
      const riseBoost = 1.0 + f.energy * 0.7 + f.respond * 0.5;
      for (let i = 0; i < BUBBLE_COUNT; i += 1) {
        const bPhase: number = bubbleData[i * 4 + 0];
        const bx: number = bubbleData[i * 4 + 1];
        const bz: number = bubbleData[i * 4 + 2];
        const bSpeed: number = bubbleData[i * 4 + 3];

        // Sine of the accumulated angle maps [0, 2π] → [-0.85, 0.85] smoothly.
        const by = Math.sin((f.time * bSpeed * riseBoost + bPhase) % (Math.PI * 2)) * 0.85;
        const rXZ = Math.sqrt(bx * bx + bz * bz);
        const maxBR = 0.82;
        const nbx = rXZ > maxBR ? (bx / rXZ) * maxBR : bx;
        const nbz = rXZ > maxBR ? (bz / rXZ) * maxBR : bz;
        bubblePosAttr.setXYZ(i, nbx, by, nbz);
      }
      bubblePosAttr.needsUpdate = true;
      bubbleMat.opacity = 0.4 + f.energy * 0.45 + f.respond * 0.15;

      // --- slow shell rotation -----------------------------------------------
      shellAngle += 0.0035;
      shell.rotation.y = shellAngle;
      shell.rotation.x = Math.sin(f.time * 0.07) * 0.04;
    },

    dispose() {
      shellGeo.dispose();
      shellMat.dispose();
      parent.remove(shell);

      for (let i = 0; i < BLOB_COUNT; i += 1) {
        blobGeos[i].dispose();
        blobMats[i].dispose();
        parent.remove(blobMeshes[i]);
      }

      bubbleGeo.dispose();
      bubbleMat.dispose();
      parent.remove(bubblePoints);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "lava",
  label: "lava",
  family: "mood",
  build,
};
