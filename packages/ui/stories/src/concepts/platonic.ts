/**
 * Morphing platonic solids — sacred geometry transmutation.
 *
 * Five platonic solids (tetra → cube → octa → dodeca → icosa) each rendered as
 * a faint crystal-glass body + crisp glowing edge lines. One solid is visible at
 * a time; every few seconds they cross-fade: the outgoing solid scales/fades to 0
 * while the incoming scales/fades from 0. The whole form slow-rotates, quickening
 * on energy. On respond the transition snaps and edges flare brighter.
 */

import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";
import { makeCrystalGlass } from "../orb-kit.ts";

// Seconds each solid dwells before cross-fading to the next.
const BASE_DWELL = 3.2;
// Seconds the cross-fade lasts at rest.
const BASE_FADE = 0.9;

interface SolidEntry {
  body: any;
  edges: any;
  bodyGeo: any;
  bodyMat: any;
  edgesGeo: any;
  edgesMat: any;
}

function build(
  THREE: WebGPUModule,
  _TSL: TSLModule,
  _U: OrbUniforms,
  parent: any,
): VariantHandle {
  // Radius chosen so every solid fits inside ~1.3 world units.
  const R = 0.95;

  // Platonic solid geometries. Cube side = 2*R/sqrt(3) so its circumradius = R.
  const cubeSide: number = (2 * R) / Math.sqrt(3);
  const rawGeos: any[] = [
    new THREE.TetrahedronGeometry(R, 0),
    new THREE.BoxGeometry(cubeSide, cubeSide, cubeSide),
    new THREE.OctahedronGeometry(R, 0),
    new THREE.DodecahedronGeometry(R, 0),
    new THREE.IcosahedronGeometry(R, 0),
  ];

  const solids: SolidEntry[] = rawGeos.map((rawGeo: any) => {
    const bodyMat: any = makeCrystalGlass(THREE);
    bodyMat.transparent = true;
    bodyMat.opacity = 0.18;
    bodyMat.side = THREE.DoubleSide;
    // Reduce transmission so it reads as a faint shell rather than invisible.
    bodyMat.transmission = 0.7;
    bodyMat.roughness = 0.05;
    const body: any = new THREE.Mesh(rawGeo, bodyMat);

    const edgesGeo: any = new THREE.EdgesGeometry(rawGeo);
    const edgesMat: any = new THREE.LineBasicNodeMaterial();
    edgesMat.color = new THREE.Color(1, 1, 1);
    edgesMat.transparent = true;
    edgesMat.opacity = 0.85;
    const edges: any = new THREE.LineSegments(edgesGeo, edgesMat);

    body.visible = false;
    edges.visible = false;
    parent.add(body);
    parent.add(edges);

    return { body, edges, bodyGeo: rawGeo, bodyMat, edgesGeo, edgesMat };
  });

  // Accent color sampled once — orange on the app home surface.
  const accentR = 1.0;
  const accentG = 0.34;
  const accentB = 0.0;

  // State.
  let currentIdx: number = 0;
  let nextIdx: number = 1;
  let phase: "dwell" | "fade" = "dwell";
  let phaseStart: number = 0;
  let rotX: number = 0;
  let rotY: number = 0;

  // Show the first solid immediately.
  solids[0].body.visible = true;
  solids[0].edges.visible = true;

  return {
    frame(f) {
      const energy: number = f.energy;
      const respond: number = f.respond;
      const time: number = f.time;

      // Rotation speed: base + energy boost + respond snap.
      const rotSpeed: number = 0.18 + energy * 0.35 + respond * 0.2;
      rotY += rotSpeed * 0.016;
      rotX = Math.sin(time * 0.11) * 0.22;

      // Morph cadence: respond snaps it faster.
      const dwell: number = BASE_DWELL / (1 + energy * 0.6 + respond * 1.2);
      const fadeDur: number = BASE_FADE / (1 + respond * 2.0);

      if (phaseStart === 0) phaseStart = time;
      const elapsed: number = time - phaseStart;

      let outScale: number = 1;
      let inScale: number = 0;
      let outOpacity: number = 1;
      let inOpacity: number = 0;

      if (phase === "dwell") {
        if (elapsed >= dwell) {
          phase = "fade";
          phaseStart = time;
        }
      } else {
        // fade
        const t: number = Math.min(elapsed / Math.max(fadeDur, 0.05), 1);
        // Smooth-step easing.
        const s: number = t * t * (3 - 2 * t);
        outScale = 1 - s * 0.55;
        outOpacity = 1 - s;
        inScale = 0.45 + s * 0.55;
        inOpacity = s;

        if (t >= 1) {
          // Commit transition.
          solids[currentIdx].body.visible = false;
          solids[currentIdx].edges.visible = false;
          currentIdx = nextIdx;
          nextIdx = (nextIdx + 1) % solids.length;
          phase = "dwell";
          phaseStart = time;
          outScale = 1;
          outOpacity = 1;
          inScale = 0;
          inOpacity = 0;
        }
      }

      // Edges rest as crisp dark ink so the wireframe reads against the bright
      // sky (white-on-white was invisible), then flare toward accent on respond.
      const restR = 0.1;
      const restG = 0.1;
      const restB = 0.14;
      const flare: number = Math.min(1, respond);
      const er: number = restR + (accentR - restR) * flare;
      const eg: number = restG + (accentG - restG) * flare;
      const eb: number = restB + (accentB - restB) * flare;
      const edgeBrightness: number = 0.92 + energy * 0.08;

      // Apply to all solids.
      solids.forEach((s: SolidEntry, i: number) => {
        const isCurrent: boolean = i === currentIdx;
        const isNext: boolean = i === nextIdx && phase === "fade";

        if (!isCurrent && !isNext) {
          s.body.visible = false;
          s.edges.visible = false;
          return;
        }

        const sc: number = isCurrent ? outScale : inScale;
        const op: number = isCurrent ? outOpacity : inOpacity;

        s.body.visible = true;
        s.edges.visible = true;

        s.body.rotation.x = rotX;
        s.body.rotation.y = rotY;
        s.edges.rotation.x = rotX;
        s.edges.rotation.y = rotY;

        s.body.scale.setScalar(sc);
        s.edges.scale.setScalar(sc);

        s.bodyMat.opacity = op * 0.28;
        s.edgesMat.opacity = op * edgeBrightness;
        s.edgesMat.color.setRGB(er, eg, eb);
      });
    },

    dispose() {
      solids.forEach((s: SolidEntry) => {
        s.bodyGeo.dispose();
        s.bodyMat.dispose();
        s.edgesGeo.dispose();
        s.edgesMat.dispose();
        parent.remove(s.body);
        parent.remove(s.edges);
      });
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "platonic",
  label: "platonic",
  family: "geometric",
  build,
};
