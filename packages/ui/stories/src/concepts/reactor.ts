import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";
import { makeChromeGem, makeOrbitParticles } from "../orb-kit.ts";

function build(THREE: WebGPUModule, TSL: TSLModule, U: OrbUniforms, parent: any): VariantHandle {
  // --- nucleus: small icosahedron with electric blue-white emissive ---
  const nucGeo = new THREE.IcosahedronGeometry(0.22, 1);
  const nucMat = new THREE.MeshStandardNodeMaterial();
  nucMat.color = new THREE.Color(0.55, 0.82, 1.0);
  nucMat.emissive = new THREE.Color(0.55, 0.82, 1.0);
  nucMat.emissiveIntensity = 3.5;
  nucMat.roughness = 0.15;
  nucMat.metalness = 0.1;
  const nucleus = new THREE.Mesh(nucGeo, nucMat);
  parent.add(nucleus);

  // --- hot white inner core glow (smaller, brighter) ---
  const coreGeo = new THREE.SphereGeometry(0.10, 12, 12);
  const coreMat = new THREE.MeshStandardNodeMaterial();
  coreMat.color = new THREE.Color(0.9, 0.96, 1.0);
  coreMat.emissive = new THREE.Color(0.9, 0.96, 1.0);
  coreMat.emissiveIntensity = 6.0;
  coreMat.roughness = 0.0;
  coreMat.metalness = 0.0;
  const core = new THREE.Mesh(coreGeo, coreMat);
  parent.add(core);

  // --- containment rings (3 toruses, each on a different axis) ---
  const ringSpecs: Array<{ rx: number; ry: number; rz: number; speed: number }> = [
    { rx: 0,           ry: 0,           rz: 0,           speed: 0.55 }, // equatorial
    { rx: Math.PI / 2, ry: 0,           rz: 0,           speed: -0.38 }, // polar
    { rx: Math.PI / 4, ry: Math.PI / 4, rz: 0,           speed: 0.28 }, // tilted
  ];

  const ringMeshes: any[] = [];
  const ringBaseRX: number[] = [];
  const ringBaseRY: number[] = [];
  const ringBaseRZ: number[] = [];
  const ringSpeeds: number[] = [];

  for (const spec of ringSpecs) {
    const geo = new THREE.TorusGeometry(0.72, 0.022, 8, 64);
    const mat = makeChromeGem(THREE);
    // Tint chrome rings slightly blue
    mat.color = new THREE.Color(0.72, 0.88, 1.0);
    mat.emissive = new THREE.Color(0.12, 0.28, 0.55);
    mat.emissiveIntensity = 0.6;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = spec.rx;
    mesh.rotation.y = spec.ry;
    mesh.rotation.z = spec.rz;
    ringBaseRX.push(spec.rx);
    ringBaseRY.push(spec.ry);
    ringBaseRZ.push(spec.rz);
    ringSpeeds.push(spec.speed);
    parent.add(mesh);
    ringMeshes.push({ mesh, geo, mat });
  }

  // --- spark field: orbit particles recolored electric blue-white ---
  const sparks = makeOrbitParticles(THREE, TSL, U, 180);
  // Override color to electric blue-white via TSL
  const { vec3, float } = TSL;
  sparks.points.material.colorNode = vec3(0.6, 0.88, 1.0).mul(
    float(0.5).add(U.uEnergy.mul(1.6)).add(U.uRespond.mul(0.8)),
  );
  sparks.points.material.sizeNode = float(0.02).add(
    float(0.03).mul(float(1.0).add(U.uEnergy.mul(2.0)).add(U.uRespond.mul(1.0))),
  );
  parent.add(sparks.points);

  // --- arc line segments: 6 arcs flickering around the core ---
  const ARC_COUNT = 6;
  const arcPositions = new Float32Array(ARC_COUNT * 2 * 3); // 2 verts per segment
  const arcGeo = new THREE.BufferGeometry();
  arcGeo.setAttribute("position", new THREE.BufferAttribute(arcPositions, 3));

  // Randomized arc endpoints
  const arcSeeds: Array<{ phi: number; theta: number; len: number }> = [];
  for (let i = 0; i < ARC_COUNT; i++) {
    arcSeeds.push({
      phi: Math.random() * Math.PI * 2,
      theta: Math.random() * Math.PI,
      len: 0.25 + Math.random() * 0.4,
    });
  }

  const arcMat = new THREE.LineBasicNodeMaterial();
  arcMat.transparent = true;
  arcMat.depthWrite = false;
  arcMat.blending = THREE.AdditiveBlending;
  arcMat.colorNode = vec3(0.55, 0.88, 1.0);
  const arcs = new THREE.LineSegments(arcGeo, arcMat);
  arcs.frustumCulled = false;
  parent.add(arcs);

  // Per-arc flickering phases
  const arcFlicker: number[] = Array.from({ length: ARC_COUNT }, () => Math.random() * 6.28);

  function frame(f: { time: number; energy: number; low: number; listen: number; respond: number }): void {
    const boost = 1.0 + f.respond * 0.7 + f.energy * 0.35;
    const spinBoost = 1.0 + f.respond * 1.4 + f.energy * 0.5;

    // Nucleus pulses with sin wave + energy + respond boost
    const pulse = Math.sin(f.time * 3.8) * 0.5 + 0.5;
    const nucScale = (1.0 + f.energy * 0.45 + f.respond * 0.35) * (0.92 + pulse * 0.16);
    nucleus.scale.setScalar(nucScale);
    nucMat.emissiveIntensity = (2.5 + pulse * 1.5 + f.energy * 3.0 + f.respond * 2.5) * boost;

    // Inner core hot white flash
    const corePulse = Math.sin(f.time * 7.1) * 0.5 + 0.5;
    coreMat.emissiveIntensity = 5.0 + corePulse * 4.0 + f.respond * 5.0 + f.energy * 4.0;
    core.scale.setScalar(0.85 + corePulse * 0.3 + f.respond * 0.4 + f.energy * 0.25);

    // Rings spin at different speeds, faster on respond/energy
    for (let i = 0; i < ringMeshes.length; i++) {
      const m = ringMeshes[i].mesh;
      const s = ringSpeeds[i] * spinBoost;
      m.rotation.x = ringBaseRX[i] + f.time * s;
      m.rotation.y = ringBaseRY[i] + f.time * s * 0.61;
      m.rotation.z = ringBaseRZ[i] + f.time * s * 0.37;
      ringMeshes[i].mat.emissiveIntensity = 0.4 + f.energy * 1.2 + f.respond * 1.0;
    }

    // Arcs: recompute endpoints each frame with jitter and flicker
    const pos = arcGeo.attributes.position;
    for (let i = 0; i < ARC_COUNT; i++) {
      const seed = arcSeeds[i];
      // Flicker: re-randomize direction slightly each frame
      const jitterPhi = seed.phi + Math.sin(f.time * 4.3 + arcFlicker[i]) * 0.6;
      const jitterTheta = seed.theta + Math.cos(f.time * 3.7 + arcFlicker[i] * 1.3) * 0.4;
      const arcLen = seed.len * (0.6 + f.energy * 0.8 + f.respond * 0.5);
      const sinT = Math.sin(jitterTheta);
      const cosT = Math.cos(jitterTheta);
      const sinP = Math.sin(jitterPhi);
      const cosP = Math.cos(jitterPhi);
      // Start near nucleus surface
      const r0 = 0.24 * nucScale;
      const r1 = r0 + arcLen;
      const base = i * 2;
      pos.setXYZ(base,     sinT * cosP * r0, cosT * r0, sinT * sinP * r0);
      pos.setXYZ(base + 1, sinT * cosP * r1, cosT * r1, sinT * sinP * r1);
    }
    pos.needsUpdate = true;

    // Arc opacity flickers based on energy + time noise
    const arcBrightness = 0.3 + f.energy * 1.2 + f.respond * 0.9 + Math.sin(f.time * 11.0) * 0.15;
    arcMat.opacity = Math.min(1.0, arcBrightness);

    // Nucleus slow rotation
    nucleus.rotation.y = f.time * 0.4;
    nucleus.rotation.x = f.time * 0.22;
  }

  function dispose(): void {
    nucGeo.dispose();
    nucMat.dispose();
    coreGeo.dispose();
    coreMat.dispose();
    arcGeo.dispose();
    arcMat.dispose();
    sparks.dispose();
    for (const { geo, mat } of ringMeshes) {
      geo.dispose();
      mat.dispose();
    }
    parent.remove(nucleus);
    parent.remove(core);
    parent.remove(arcs);
    parent.remove(sparks.points);
    for (const { mesh } of ringMeshes) {
      parent.remove(mesh);
    }
  }

  return { frame, dispose };
}

export const concept: ConceptDescriptor = {
  id: "reactor",
  label: "reactor",
  family: "sci-fi",
  build,
};
