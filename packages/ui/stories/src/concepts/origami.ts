import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Two interlocked tetrahedra — one upright, one inverted — counter-rotate
// slowly to mimic a folded-paper sculpture. Each is flat-shaded and paper-
// white so the studio key light reads every facet as a distinct shade of cream.
// A gentle sin(time) oscillation opens/closes the scale and rotation amplitude
// so the form seems to breathe. f.respond widens the unfold; f.energy brightens
// the emissive edge catch.

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // Paper-white material — high roughness, flat shading, faint warm tint.
  function makePaperMat(): any {
    const m = new THREE.MeshStandardNodeMaterial();
    m.flatShading = true;
    m.roughness = 0.86;
    m.metalness = 0.0;
    m.color = new THREE.Color(0.97, 0.95, 0.91);
    m.emissive = new THREE.Color(0.0, 0.0, 0.0);
    m.emissiveIntensity = 0.0;
    m.transparent = false;
    return m;
  }

  // --- upright tetrahedron (radius 0.9) ----------------------------------------
  const geoA = new THREE.TetrahedronGeometry(0.9, 0);
  const matA = makePaperMat();
  const meshA = new THREE.Mesh(geoA, matA);

  // --- inverted tetrahedron (radius 0.78, slightly smaller for visual contrast) --
  const geoB = new THREE.TetrahedronGeometry(0.78, 0);
  const matB = makePaperMat();
  // Warm the inner solid ever so slightly — a touch more ivory.
  matB.color = new THREE.Color(0.99, 0.96, 0.90);
  const meshB = new THREE.Mesh(geoB, matB);
  // Invert it by flipping on X so it nests point-down inside the upright one.
  meshB.rotation.x = Math.PI;

  // --- crease lines: dark edges so the folds read against a bright sky ----------
  // Paper-white facets on a white cloud backdrop have almost no silhouette; crisp
  // charcoal edges give every fold a readable contour.
  function makeCreaseLines(geo: any): {
    lines: any;
    edgesGeo: any;
    edgesMat: any;
  } {
    const edgesGeo = new THREE.EdgesGeometry(geo);
    const edgesMat = new THREE.LineBasicNodeMaterial();
    edgesMat.color = new THREE.Color(0.14, 0.12, 0.1);
    edgesMat.transparent = true;
    edgesMat.opacity = 0.9;
    const lines = new THREE.LineSegments(edgesGeo, edgesMat);
    return { lines, edgesGeo, edgesMat };
  }
  const creaseA = makeCreaseLines(geoA);
  const creaseB = makeCreaseLines(geoB);
  // Parent the lines to the meshes so they inherit each solid's transform.
  meshA.add(creaseA.lines);
  meshB.add(creaseB.lines);

  // --- pivot groups so each solid rotates about its own centre -----------------
  const pivotA = new THREE.Group();
  const pivotB = new THREE.Group();
  pivotA.add(meshA);
  pivotB.add(meshB);

  parent.add(pivotA);
  parent.add(pivotB);

  // Neutral emissive colour: warm white edge catch.
  const edgeColor = new THREE.Color(1.0, 0.97, 0.88);
  // Shared scratch color to avoid per-frame allocation.
  const scratchColor = new THREE.Color();

  return {
    frame(f) {
      // Base slow counter-rotation (Y axis).
      const baseSpeedA = 0.09;
      const baseSpeedB = -0.07;

      // Breathe amplitude: gentle sin pulse, opens further when responding.
      const breatheAmp = 0.06 + f.respond * 0.14;
      const breathe = Math.sin(f.time * 0.8) * breatheAmp;

      // Unfold wobble: a secondary tilt that grows with f.respond.
      const unfoldAmp = 0.08 + f.respond * 0.22;
      const unfold = Math.sin(f.time * 0.55 + 0.4) * unfoldAmp;

      // Scale: breathes between ~0.92 and ~1.08; opens on respond.
      const scaleA = 1.0 + breathe + f.respond * 0.06;
      const scaleB = 1.0 - breathe * 0.7 + f.respond * 0.04;
      pivotA.scale.setScalar(scaleA);
      pivotB.scale.setScalar(scaleB);

      // Rotation: steady base spin + unfold wobble.
      pivotA.rotation.y = f.time * baseSpeedA + unfold;
      pivotA.rotation.x = Math.sin(f.time * 0.32) * (0.06 + f.respond * 0.1);
      pivotB.rotation.y = f.time * baseSpeedB - unfold * 0.6;
      pivotB.rotation.x = Math.PI + Math.sin(f.time * 0.28 + 1.1) * (0.05 + f.respond * 0.08);

      // Emissive edge catch: brightens on energy — warm paper-white flare.
      const ei = f.energy * 0.35 + f.respond * 0.12;
      scratchColor.copy(edgeColor);
      matA.emissive = scratchColor;
      matA.emissiveIntensity = ei;
      matB.emissive = scratchColor;
      matB.emissiveIntensity = ei * 0.7;

      // Crease lines rest charcoal, flaring toward warm accent on respond.
      const flare = Math.min(1, f.respond);
      const cr = 0.14 + (1.0 - 0.14) * flare;
      const cg = 0.12 + (0.34 - 0.12) * flare;
      const cb = 0.1 + (0.0 - 0.1) * flare;
      creaseA.edgesMat.color.setRGB(cr, cg, cb);
      creaseB.edgesMat.color.setRGB(cr, cg, cb);
    },

    dispose() {
      geoA.dispose();
      matA.dispose();
      geoB.dispose();
      matB.dispose();
      creaseA.edgesGeo.dispose();
      creaseA.edgesMat.dispose();
      creaseB.edgesGeo.dispose();
      creaseB.edgesMat.dispose();
      parent.remove(pivotA);
      parent.remove(pivotB);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "origami",
  label: "origami",
  family: "artful",
  build,
};
