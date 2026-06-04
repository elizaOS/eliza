// Tessellation — tectonic facets breathing in traveling sine waves.
//
// IcosahedronGeometry(1,2), non-indexed, flat-shaded. At build, base vertex
// positions and their normalized radial directions are cached in Float32Arrays.
// Each frame, every vertex is displaced outward along its direction by the sum
// of two traveling sine waves whose ridgelines sweep across the globe over time.
// computeVertexNormals() after each update keeps the flat facets crisp.
// Wave amplitude and speed grow with energy; a sharp pulse on respond flares
// emissive intensity and spikes amplitude briefly; accent tint bleeds in on respond.

import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // Non-indexed icosahedron (detail 2 = 320 faces, ~960 verts). Non-indexed
  // means every face owns its 3 verts, so flat shading just works.
  const geo: any = new THREE.IcosahedronGeometry(1, 2);

  // Cache base positions and normalized radial directions.
  const posAttr: any = geo.attributes.position;
  const count: number = posAttr.count;
  const basePos: Float32Array = new Float32Array(count * 3);
  const dirs: Float32Array = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const x: number = posAttr.getX(i);
    const y: number = posAttr.getY(i);
    const z: number = posAttr.getZ(i);
    basePos[i * 3] = x;
    basePos[i * 3 + 1] = y;
    basePos[i * 3 + 2] = z;
    // Normalize to get the outward direction.
    const len: number = Math.sqrt(x * x + y * y + z * z) || 1;
    dirs[i * 3] = x / len;
    dirs[i * 3 + 1] = y / len;
    dirs[i * 3 + 2] = z / len;
  }

  // Slate/teal base. A faint self-illumination that brightens on ridges via
  // emissiveIntensity tweaked each frame — no per-vertex color needed.
  const mat: any = new THREE.MeshStandardNodeMaterial();
  mat.flatShading = true;
  mat.color = new THREE.Color(0.18, 0.38, 0.52); // cool slate-teal
  mat.emissive = new THREE.Color(0.3, 0.72, 0.9); // icy cyan glow on ridges
  mat.emissiveIntensity = 0.08;
  mat.roughness = 0.55;
  mat.metalness = 0.25;

  const mesh: any = new THREE.Mesh(geo, mat);
  parent.add(mesh);

  // Optional faint inner sphere so the core reads as solid depth.
  const innerGeo: any = new THREE.IcosahedronGeometry(0.62, 1);
  const innerMat: any = new THREE.MeshStandardNodeMaterial();
  innerMat.flatShading = true;
  innerMat.color = new THREE.Color(0.08, 0.18, 0.28);
  innerMat.roughness = 0.8;
  innerMat.metalness = 0.1;
  const inner: any = new THREE.Mesh(innerGeo, innerMat);
  parent.add(inner);

  // Two wave axes that slowly drift — rotated in frame() so ridges sweep.
  // Stored as [x,y,z] components updated each frame.
  let axis1x: number = 0.6;
  let axis1y: number = 0.8;
  let axis1z: number = 0.0;
  let axis2x: number = -0.7;
  let axis2y: number = 0.2;
  let axis2z: number = 0.68;

  // Accumulated rotation angles for the two axes (slow drift around Y/X).
  let driftAngle1: number = 0;
  let driftAngle2: number = 0;

  // Smoothed respond for flash decay.
  let respondSmooth: number = 0;

  // Working array for displaced positions — reuse each frame.
  const posArray: Float32Array = posAttr.array as Float32Array;

  return {
    frame(f) {
      const energy: number = f.energy;
      const respond: number = f.respond;
      const t: number = f.time;

      // Smooth respond for a flash that decays.
      respondSmooth += (respond - respondSmooth) * 0.18;

      // Wave parameters react to voice.
      const ampBase: number = 0.055 + energy * 0.125 + respondSmooth * 0.09;
      const speed1: number = 0.55 + energy * 0.6 + respondSmooth * 0.4;
      const speed2: number = 0.38 + energy * 0.4 + respondSmooth * 0.3;
      const freq1: number = 3.8;
      const freq2: number = 5.1;
      const amp1: number = ampBase * 0.6;
      const amp2: number = ampBase * 0.4;

      // Slowly rotate wave axes to sweep ridges around the globe.
      driftAngle1 += 0.0045 + energy * 0.003;
      driftAngle2 -= 0.0032 + energy * 0.002;

      const c1: number = Math.cos(driftAngle1);
      const s1: number = Math.sin(driftAngle1);
      // Rotate axis1 around Y.
      const a1x: number = axis1x * c1 + axis1z * s1;
      const a1y: number = axis1y;
      const a1z: number = -axis1x * s1 + axis1z * c1;
      axis1x = a1x;
      axis1y = a1y;
      axis1z = a1z;

      // Rotate axis2 around X.
      const c2: number = Math.cos(driftAngle2);
      const s2: number = Math.sin(driftAngle2);
      const a2x: number = axis2x;
      const a2y: number = axis2y * c2 - axis2z * s2;
      const a2z: number = axis2y * s2 + axis2z * c2;
      axis2x = a2x;
      axis2y = a2y;
      axis2z = a2z;

      // Displace each vertex outward by the sum of two traveling sine waves.
      for (let i = 0; i < count; i++) {
        const di: number = i * 3;
        const dx: number = dirs[di];
        const dy: number = dirs[di + 1];
        const dz: number = dirs[di + 2];

        // Dot the normalized direction with each wave axis.
        const dot1: number = dx * a1x + dy * a1y + dz * a1z;
        const dot2: number = dx * a2x + dy * a2y + dz * a2z;

        // Traveling wave: disp = amp * sin(dot*freq - time*speed).
        const w1: number = amp1 * Math.sin(dot1 * freq1 - t * speed1);
        const w2: number = amp2 * Math.sin(dot2 * freq2 - t * speed2);
        const disp: number = w1 + w2;

        posArray[di] = basePos[di] + dx * disp;
        posArray[di + 1] = basePos[di + 1] + dy * disp;
        posArray[di + 2] = basePos[di + 2] + dz * disp;
      }

      posAttr.needsUpdate = true;
      geo.computeVertexNormals();

      // Emissive intensity: base glow + ridge brightening via energy + flash on respond.
      mat.emissiveIntensity = 0.08 + energy * 0.28 + respondSmooth * 0.55;

      // On respond: blend emissive toward accent (orange). Accent is ~(1, 0.34, 0).
      const accentR: number = 1.0;
      const accentG: number = 0.34;
      const accentB: number = 0.0;
      const baseR: number = 0.3;
      const baseG: number = 0.72;
      const baseB: number = 0.9;
      const blend: number = respondSmooth * 0.7;
      mat.emissive.setRGB(
        baseR + (accentR - baseR) * blend,
        baseG + (accentG - baseG) * blend,
        baseB + (accentB - baseB) * blend,
      );

      // Slow base rotation, quickens with energy.
      mesh.rotation.y = t * (0.055 + energy * 0.06);
      mesh.rotation.x = Math.sin(t * 0.09) * 0.13;
      inner.rotation.y = -t * 0.04;
    },

    dispose() {
      geo.dispose();
      mat.dispose();
      innerGeo.dispose();
      innerMat.dispose();
      parent.remove(mesh);
      parent.remove(inner);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "tessellation",
  label: "tessellation",
  family: "geometric",
  build,
};
