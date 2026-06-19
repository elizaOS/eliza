import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Jewel hues: ruby, sapphire, emerald, amber, amethyst, cobalt, crimson.
// Each triple is [r, g, b] in linear (0–1). Kept slightly desaturated so
// emissive swells read without blowing out.
const JEWEL_PALETTE: [number, number, number][] = [
  [0.82, 0.06, 0.1], // ruby
  [0.06, 0.18, 0.82], // sapphire
  [0.05, 0.7, 0.22], // emerald
  [0.9, 0.52, 0.04], // amber
  [0.55, 0.1, 0.8], // amethyst
  [0.04, 0.4, 0.82], // cobalt
  [0.8, 0.08, 0.35], // crimson
];

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // ---- outer jewel sphere: flat-shaded facets, per-vertex color ----
  // IcosahedronGeometry(r, detail=1) produces 80 flat triangles,
  // already non-indexed — each face owns its 3 vertices independently.
  const paneGeo = new THREE.IcosahedronGeometry(1.0, 1);
  const posAttr = paneGeo.attributes.position as {
    count: number;
    getX(i: number): number;
    getY(i: number): number;
    getZ(i: number): number;
  };
  const vertCount: number = posAttr.count;
  const faceCount: number = vertCount / 3;

  // Per-face jewel color + base emissive swell amounts stored in parallel arrays.
  const faceColors: [number, number, number][] = [];
  const colorData = new Float32Array(vertCount * 3);
  for (let fi = 0; fi < faceCount; fi += 1) {
    const pick = JEWEL_PALETTE[
      Math.floor(Math.random() * JEWEL_PALETTE.length)
    ] as [number, number, number];
    faceColors.push(pick);
    // Assign identical color to all 3 verts of each face for flat look.
    for (let k = 0; k < 3; k += 1) {
      const vi = fi * 3 + k;
      colorData[vi * 3] = pick[0];
      colorData[vi * 3 + 1] = pick[1];
      colorData[vi * 3 + 2] = pick[2];
    }
  }
  paneGeo.setAttribute("color", new THREE.BufferAttribute(colorData, 3));

  const paneMat = new THREE.MeshStandardNodeMaterial();
  paneMat.vertexColors = true;
  paneMat.flatShading = true;
  paneMat.roughness = 0.28;
  paneMat.metalness = 0.0;
  paneMat.transparent = true;
  paneMat.opacity = 0.92;
  paneMat.emissive = new THREE.Color(0.12, 0.12, 0.12);
  paneMat.emissiveIntensity = 0.6;
  const panes = new THREE.Mesh(paneGeo, paneMat);
  parent.add(panes);

  // ---- lead cames: wireframe slightly larger than the pane sphere ----
  const leadGeo = new THREE.WireframeGeometry(
    new THREE.IcosahedronGeometry(1.005, 1),
  );
  const leadMat = new THREE.LineBasicNodeMaterial();
  leadMat.color = new THREE.Color(0.04, 0.03, 0.04);
  const leads = new THREE.LineSegments(leadGeo, leadMat);
  parent.add(leads);

  // ---- emissive inner core: bright point of light that "pours through" ----
  const coreGeo = new THREE.IcosahedronGeometry(0.22, 1);
  const coreMat = new THREE.MeshStandardNodeMaterial();
  coreMat.color = new THREE.Color(1.0, 0.96, 0.88);
  coreMat.emissive = new THREE.Color(1.0, 0.94, 0.8);
  coreMat.emissiveIntensity = 2.8;
  coreMat.roughness = 0.0;
  coreMat.metalness = 0.0;
  const core = new THREE.Mesh(coreGeo, coreMat);
  parent.add(core);

  // Base emissive color per face, reused each frame to avoid allocation.
  const _faceBase = new THREE.Color();

  return {
    frame(f) {
      // Slow majestic cathedral rotation.
      panes.rotation.y = f.time * 0.055;
      panes.rotation.x = Math.sin(f.time * 0.038) * 0.14;
      panes.rotation.z = Math.cos(f.time * 0.027) * 0.06;
      leads.rotation.copy(panes.rotation);

      // Core inner light: brightens with energy, warms toward accent on respond.
      // uAccent is orange (1, 0.34, 0) on the home surface.
      const coreBase = 2.8 + f.energy * 3.2 + f.respond * 1.4;
      coreMat.emissiveIntensity = coreBase;
      // Warm flush: core color shifts toward amber/orange when responding.
      const warmR = 1.0;
      const warmG = 0.94 - f.respond * 0.18;
      const warmB = 0.8 - f.respond * 0.5;
      coreMat.emissive.setRGB(warmR, warmG, warmB);
      core.scale.setScalar(1.0 + f.energy * 0.28 + f.respond * 0.12);
      core.rotation.y = -f.time * 0.11;

      // Pane emissive swell on energy + respond: all facets glow warmer together.
      // On respond, nudge hues toward amber — blend each jewel color toward (0.9, 0.5, 0.1).
      const energySwell = 0.5 + f.energy * 1.8 + f.respond * 0.9;
      const respondLerp = f.respond * 0.45;
      paneMat.emissiveIntensity = energySwell;
      // Emissive tint: cool white base → warm amber-ish on respond.
      const er = 0.12 + respondLerp * (0.9 - 0.12);
      const eg = 0.12 + respondLerp * (0.5 - 0.12);
      const eb = 0.12 - respondLerp * 0.1;
      paneMat.emissive.setRGB(er, eg, eb);

      // Listen: subtle brightness dip (holding breath).
      if (f.listen > 0.01) {
        paneMat.emissiveIntensity = energySwell * (1.0 - f.listen * 0.2);
      }
    },
    dispose() {
      paneGeo.dispose();
      paneMat.dispose();
      leadGeo.dispose();
      leadMat.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      parent.remove(panes);
      parent.remove(leads);
      parent.remove(core);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "stainedglass",
  label: "stained",
  family: "artful",
  build,
};
