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
  // --- body: soft matte near-black sphere -----------------------------------
  const bodyGeo = new THREE.SphereGeometry(0.88, 48, 48);
  const bodyMat = new THREE.MeshStandardNodeMaterial();
  bodyMat.color = new THREE.Color(0.045, 0.045, 0.05);
  bodyMat.roughness = 0.92;
  bodyMat.metalness = 0.0;
  bodyMat.emissive = new THREE.Color(0.0, 0.0, 0.0);
  bodyMat.emissiveIntensity = 0;
  const body = new THREE.Mesh(bodyGeo, bodyMat);

  // --- ink cloud: slow JS-driven charcoal swarm orbiting the body -----------
  const INK_COUNT = 220;
  const inkPos = new Float32Array(INK_COUNT * 3);
  // per-particle state: [phase, speed, yBand, baseR]
  const inkData = new Float32Array(INK_COUNT * 4);
  for (let i = 0; i < INK_COUNT; i += 1) {
    inkData[i * 4 + 0] = Math.random() * Math.PI * 2; // phase
    inkData[i * 4 + 1] = 0.06 + Math.random() * 0.08; // orbit speed (slow)
    inkData[i * 4 + 2] = (Math.random() - 0.5) * 2.2; // y band
    inkData[i * 4 + 3] = 0.88 + Math.random() * 0.38; // base ring radius
  }

  const inkGeo = new THREE.BufferGeometry();
  inkGeo.setAttribute("position", new THREE.BufferAttribute(inkPos, 3));
  // NormalBlending charcoal: additive dark vanishes on the bright sky, but
  // solid charcoal points read as drifting ink wisps.
  const inkMat = new THREE.PointsNodeMaterial();
  inkMat.color = new THREE.Color(0.1, 0.1, 0.13);
  inkMat.transparent = true;
  inkMat.opacity = 0.6;
  inkMat.depthWrite = false;
  inkMat.blending = THREE.NormalBlending;
  inkMat.size = 0.03;
  inkMat.sizeAttenuation = true;
  const inkPoints = new THREE.Points(inkGeo, inkMat);
  inkPoints.frustumCulled = false;

  // --- hanko seal: deep vermilion stamp -------------------------------------
  // Low emissive so it reads as a crisp inked stamp, not a glowing pink blob.
  const sealGeo = new THREE.SphereGeometry(0.12, 24, 24);
  const sealMat = new THREE.MeshStandardNodeMaterial();
  sealMat.color = new THREE.Color(0.78, 0.1, 0.07);
  sealMat.emissive = new THREE.Color(0.7, 0.06, 0.04);
  sealMat.emissiveIntensity = 0.25;
  sealMat.roughness = 0.45;
  sealMat.metalness = 0.05;
  const seal = new THREE.Mesh(sealGeo, sealMat);
  // Offset seal to lower-right of body face
  seal.position.set(0.62, -0.52, 0.42);

  parent.add(body);
  parent.add(inkPoints);
  parent.add(seal);

  const posAttr = inkGeo.attributes.position as {
    setXYZ: (i: number, x: number, y: number, z: number) => void;
    needsUpdate: boolean;
  };

  return {
    frame(f) {
      // Calligraphic slow rotation of body
      body.rotation.y = f.time * 0.045;
      body.rotation.x = Math.sin(f.time * 0.032) * 0.06;

      // Subtle body scale rise on energy — like ink spreading
      const bodyScale = 1.0 + f.energy * 0.07;
      body.scale.setScalar(bodyScale);

      // Ink cloud: update JS-driven particle positions
      const breathe = 1.0 + f.energy * 0.55;
      for (let i = 0; i < INK_COUNT; i += 1) {
        const phase: number = inkData[i * 4 + 0];
        const speed: number = inkData[i * 4 + 1];
        const yBand: number = inkData[i * 4 + 2];
        const baseR: number = inkData[i * 4 + 3];

        const ang = f.time * speed + phase;
        const r = baseR * breathe;
        const py = yBand + Math.sin(f.time * speed * 1.2 + phase) * 0.11;
        posAttr.setXYZ(i, Math.cos(ang) * r, py, Math.sin(ang) * r);
      }
      posAttr.needsUpdate = true;

      // Slow ink cloud rotation
      inkPoints.rotation.y = f.time * 0.018;

      // Hanko seal: emissive lifts modestly on respond — stays a deep stamp.
      const respondPulse = 0.25 + f.respond * 0.6 + Math.sin(f.time * 1.8) * 0.06 * f.respond;
      sealMat.emissiveIntensity = respondPulse;

      // Seal gently bobs
      seal.position.y = -0.52 + Math.sin(f.time * 0.5) * 0.025;
    },

    dispose() {
      bodyGeo.dispose();
      bodyMat.dispose();
      inkGeo.dispose();
      inkMat.dispose();
      sealGeo.dispose();
      sealMat.dispose();
      parent.remove(body);
      parent.remove(inkPoints);
      parent.remove(seal);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "ink",
  label: "ink",
  family: "artful",
  build,
};
