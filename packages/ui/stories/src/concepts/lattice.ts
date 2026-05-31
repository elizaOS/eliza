// Geodesic strut frame — a glowing architectural wireframe cage.
//
// Takes an IcosahedronGeometry(1,2), renders its edges as cool-white/cyan
// LineSegments (the "struts"), and places a small emissive node sphere at
// every unique vertex via a single InstancedMesh. A brightness wave phases
// each node by its dot with a sweep axis so a pulse visibly rolls across the
// lattice. Reacts to voice: nodes brighten on energy, pulse speeds up and
// the whole frame scales/breathes on respond, accent tint on respond.

import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

/** Deduplicate an IcosahedronGeometry's vertices by rounded key. */
function uniqueVertices(THREE: WebGPUModule, radius: number, detail: number): number[][] {
  const geo: any = new THREE.IcosahedronGeometry(radius, detail);
  const pos: any = geo.attributes.position;
  const seen = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const x: number = pos.getX(i);
    const y: number = pos.getY(i);
    const z: number = pos.getZ(i);
    // Round to 4 decimal places to merge coincident verts.
    const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    if (!seen.has(key)) seen.set(key, [x, y, z]);
  }
  geo.dispose();
  return Array.from(seen.values());
}

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // ── strut cage ──────────────────────────────────────────────────────────────
  // Use detail=2 (80 faces, 42 unique verts) — dense but well under budget.
  const strutRadius = 1.0;
  const cageGeo: any = new THREE.IcosahedronGeometry(strutRadius, 2);
  const edgesGeo: any = new THREE.EdgesGeometry(cageGeo);
  cageGeo.dispose(); // edges has its own copy of the data

  const strutMat: any = new THREE.LineBasicNodeMaterial();
  strutMat.color = new THREE.Color(0.55, 0.88, 1.0);
  strutMat.transparent = true;
  strutMat.opacity = 0.55;

  const struts: any = new THREE.LineSegments(edgesGeo, strutMat);
  parent.add(struts);

  // ── node spheres at vertices ─────────────────────────────────────────────
  const verts: number[][] = uniqueVertices(THREE, strutRadius, 2);
  const nodeCount: number = verts.length;

  // Store each vertex as a Vector3 for the pulse phase computation.
  const nodePositions: Array<{ x: number; y: number; z: number }> = verts.map(
    ([x, y, z]) => ({ x, y, z }),
  );

  // Each node is a tiny icosahedron sphere.
  const nodeGeo: any = new THREE.IcosahedronGeometry(0.045, 0);
  const nodeMat: any = new THREE.MeshStandardNodeMaterial();
  nodeMat.color = new THREE.Color(0.0, 0.0, 0.0); // all light comes from emissive
  nodeMat.emissive = new THREE.Color(0.4, 0.9, 1.0);
  nodeMat.emissiveIntensity = 1.8;
  nodeMat.roughness = 0.5;
  nodeMat.metalness = 0.0;

  const nodes: any = new THREE.InstancedMesh(nodeGeo, nodeMat, nodeCount);
  nodes.frustumCulled = false;

  // Dummy object used to build per-instance matrices.
  const dummy: any = new THREE.Object3D();

  // Set initial instance matrices (identity scale + vertex position).
  for (let i = 0; i < nodeCount; i++) {
    const p = nodePositions[i];
    dummy.position.set(p.x, p.y, p.z);
    dummy.scale.setScalar(1.0);
    dummy.updateMatrix();
    nodes.setMatrixAt(i, dummy.matrix);
  }
  nodes.instanceMatrix.needsUpdate = true;
  parent.add(nodes);

  // Pre-compute per-node phase: dot of normalised position with sweep axis (0,1,0).
  // This gives a gradient from south pole (-1) to north pole (+1).
  const nodePhase: Float64Array = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const p = nodePositions[i];
    const len: number = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 1;
    // Tilted sweep axis so the wave hits diagonally — more interesting visually.
    nodePhase[i] = (p.y * 0.7 + p.x * 0.5 + p.z * 0.3) / len;
  }

  // ── shared rotation state ────────────────────────────────────────────────
  let rotY: number = 0;
  let rotX: number = 0;

  // Reusable scratch matrix (avoid per-frame allocation).
  const mat4: any = new THREE.Matrix4();

  return {
    frame(f) {
      const time: number = f.time;
      const energy: number = f.energy;
      const respond: number = f.respond;

      // Slow rotation; quickens on respond.
      const rotSpeed: number = 0.06 + respond * 0.12;
      rotY = time * rotSpeed;
      rotX = Math.sin(time * 0.09) * 0.14;

      struts.rotation.y = rotY;
      struts.rotation.x = rotX;
      nodes.rotation.y = rotY;
      nodes.rotation.x = rotX;

      // Breathing scale: base 1, expands on respond.
      const breathe: number = 1.0 + respond * 0.12 + energy * 0.04;
      struts.scale.setScalar(breathe);
      nodes.scale.setScalar(breathe);

      // Strut color and opacity rise with energy; accent tint on respond.
      const strutBright: number = 0.55 + energy * 0.6 + respond * 0.4;
      // Lerp strut color from cool cyan toward orange accent on respond.
      const sr: number = 0.55 + respond * (1.0 - 0.55);
      const sg: number = 0.88 - respond * (0.88 - 0.34);
      const sb: number = 1.0 - respond * 1.0;
      strutMat.color.setRGB(sr * strutBright, sg * strutBright, sb * strutBright);
      strutMat.opacity = Math.min(1, 0.4 + energy * 0.45 + respond * 0.25);

      // Pulse wave: phase each node by nodePhase, runs faster on respond.
      const pulseSpeed: number = 2.0 + respond * 3.5 + energy * 1.5;
      const pulseT: number = time * pulseSpeed;

      // Node emissive base intensity.
      const baseIntensity: number = 1.2 + energy * 2.5 + respond * 1.5;

      // Emissive color: cool cyan, accent tint on respond.
      const nr: number = 0.4 + respond * (1.0 - 0.4);
      const ng: number = 0.9 - respond * (0.9 - 0.34);
      const nb: number = 1.0 - respond * 1.0;
      nodeMat.emissive.setRGB(nr, ng, nb);

      // Update per-instance matrices for wave brightness via scale oscillation.
      // We encode brightness purely in emissiveIntensity (uniform), and
      // encode per-node oscillation by varying the node sphere size in the matrix.
      for (let i = 0; i < nodeCount; i++) {
        const wave: number = 0.5 + 0.5 * Math.sin(pulseT + nodePhase[i] * Math.PI * 2.2);
        // Node size scales 0.7–1.3 with the wave.
        const nodeScale: number = 0.7 + wave * 0.6;

        const p = nodePositions[i];
        dummy.position.set(p.x, p.y, p.z);
        dummy.scale.setScalar(nodeScale);
        dummy.updateMatrix();
        nodes.setMatrixAt(i, dummy.matrix);
        void mat4; // silence unused-variable lint
      }
      nodes.instanceMatrix.needsUpdate = true;

      // Global emissive intensity responds to energy and wave average.
      nodeMat.emissiveIntensity = baseIntensity;
    },

    dispose() {
      edgesGeo.dispose();
      strutMat.dispose();
      nodeGeo.dispose();
      nodeMat.dispose();
      parent.remove(struts);
      parent.remove(nodes);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "lattice",
  label: "lattice",
  family: "geometric",
  build,
};
