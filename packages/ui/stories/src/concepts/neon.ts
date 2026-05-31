import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Synthwave neon tubes — a TorusKnotGeometry rendered as luminous glowing edges.
// Each edge set is rendered twice: a thin bright core line and a slightly larger
// halo copy (scale 1.04) drawn behind it as a wider outline for tube depth.
// Palette: hot magenta core / electric cyan halo, cycling hue over time.
// NormalBlending (not additive) so the saturated magenta/cyan read against the
// bright cloud sky instead of washing to white.
// Reactivity: glow pumps on energy; hue pulses and bloom swells on respond;
// whole shape scales gently with low (bass). No TSL node graphs used.

// Magenta and cyan as [r,g,b] pairs for quick lerp. Deep-saturated so they read
// against the bright sky under NormalBlending (pale cyan washes out on it).
const MAGENTA: [number, number, number] = [1.0, 0.08, 0.72];
const CYAN: [number, number, number] = [0.0, 0.78, 0.95];

function build(THREE: WebGPUModule, _TSL: TSLModule, _U: OrbUniforms, parent: any): VariantHandle {
  // Primary torus-knot shape: p=2,q=3 gives a classic trefoil knot.
  const knotGeo = new THREE.TorusKnotGeometry(0.68, 0.22, 128, 16, 2, 3);
  const edgesGeo = new THREE.EdgesGeometry(knotGeo);

  // Core line: thin, bright, hot magenta.
  const coreMat = new THREE.LineBasicNodeMaterial({
    color: new THREE.Color(MAGENTA[0], MAGENTA[1], MAGENTA[2]),
    transparent: true,
    blending: THREE.NormalBlending,
  });
  coreMat.opacity = 0.95;
  coreMat.depthWrite = false;
  const coreLines = new THREE.LineSegments(edgesGeo, coreMat);
  coreLines.renderOrder = 1;

  // Halo copy: slightly scaled up, electric cyan, drawn behind as a wider outline.
  const haloEdgesGeo = new THREE.EdgesGeometry(knotGeo);
  const haloMat = new THREE.LineBasicNodeMaterial({
    color: new THREE.Color(CYAN[0], CYAN[1], CYAN[2]),
    transparent: true,
    blending: THREE.NormalBlending,
  });
  haloMat.opacity = 0.5;
  haloMat.depthWrite = false;
  const haloLines = new THREE.LineSegments(haloEdgesGeo, haloMat);
  haloLines.scale.setScalar(1.04);
  haloLines.renderOrder = 0;

  parent.add(haloLines);
  parent.add(coreLines);

  // State for hue oscillation between magenta and cyan.
  let hueCycle: number = 0.0; // 0 = magenta core, 1 = flipped

  return {
    frame(f) {
      // --- Rotation: slow tumble on Y, gentle wobble on X ---
      const rotY: number = f.time * 0.14;
      const rotX: number = Math.sin(f.time * 0.09) * 0.18;
      const rotZ: number = Math.cos(f.time * 0.07) * 0.08;
      coreLines.rotation.y = rotY;
      coreLines.rotation.x = rotX;
      coreLines.rotation.z = rotZ;
      haloLines.rotation.y = rotY;
      haloLines.rotation.x = rotX;
      haloLines.rotation.z = rotZ;

      // --- Beat scale: whole shape pulses with bass (f.low) ---
      const beatScale: number = 1.0 + f.low * 0.12;
      coreLines.scale.setScalar(beatScale);
      haloLines.scale.setScalar(beatScale * 1.04);

      // --- Hue cycle: on respond, hueCycle ramps toward 1.0; idles back ---
      const hueCycleTarget: number = f.respond > 0.05 ? (Math.sin(f.time * 2.8) * 0.5 + 0.5) : 0.0;
      hueCycle += (hueCycleTarget - hueCycle) * 0.06;

      // Lerp core between magenta and cyan based on hueCycle.
      const coreR: number = MAGENTA[0] + (CYAN[0] - MAGENTA[0]) * hueCycle;
      const coreG: number = MAGENTA[1] + (CYAN[1] - MAGENTA[1]) * hueCycle;
      const coreB: number = MAGENTA[2] + (CYAN[2] - MAGENTA[2]) * hueCycle;
      // Halo is the opposite hue from core.
      const haloR: number = CYAN[0] + (MAGENTA[0] - CYAN[0]) * hueCycle;
      const haloG: number = CYAN[1] + (MAGENTA[1] - CYAN[1]) * hueCycle;
      const haloB: number = CYAN[2] + (MAGENTA[2] - CYAN[2]) * hueCycle;

      // NormalBlending: keep the hue saturated (a >1 glow multiply clips toward
      // white and washes out on the bright sky); drive intensity via opacity.
      coreMat.color.setRGB(coreR, coreG, coreB);
      coreMat.opacity = Math.min(1.0, 0.85 + f.energy * 0.12 + f.respond * 0.08);

      // Halo: wider outline behind the core; brightens with energy/respond.
      haloMat.color.setRGB(haloR, haloG, haloB);
      haloMat.opacity = Math.min(0.8, 0.5 + f.energy * 0.2 + f.respond * 0.18);
    },

    dispose() {
      knotGeo.dispose();
      edgesGeo.dispose();
      haloEdgesGeo.dispose();
      coreMat.dispose();
      haloMat.dispose();
      parent.remove(coreLines);
      parent.remove(haloLines);
    },
  };
}

export const concept: ConceptDescriptor = { id: "neon", label: "neon", family: "abstract", build };
