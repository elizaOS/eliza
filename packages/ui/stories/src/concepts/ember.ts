import type {
  ConceptDescriptor,
  OrbFrame,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";
import { makeFacetedIcosa, makeOrbitParticles } from "../orb-kit.ts";

function build(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  // --- charcoal body: dark flat-faceted icosahedron ----------------------------
  const bodyGeo = makeFacetedIcosa(THREE, 1.0, 2, 0.1);
  const bodyMat = new THREE.MeshStandardNodeMaterial();
  bodyMat.flatShading = true;
  bodyMat.color = new THREE.Color(0.04, 0.03, 0.02);
  bodyMat.roughness = 0.95;
  bodyMat.metalness = 0.0;
  bodyMat.emissive = new THREE.Color(0.18, 0.04, 0.0);
  bodyMat.emissiveIntensity = 0.4;
  const body = new THREE.Mesh(bodyGeo, bodyMat);

  // --- lava crack overlay: wireframe of the same icosahedron -------------------
  // WireframeGeometry traces every edge, reading as a web of glowing cracks
  // between the dark charcoal facets.
  const wireGeo = new THREE.WireframeGeometry(bodyGeo);
  const wireMat = new THREE.LineBasicNodeMaterial();
  wireMat.color = new THREE.Color(1.0, 0.28, 0.0);
  wireMat.transparent = true;
  wireMat.opacity = 0.85;
  wireMat.depthWrite = false;
  const cracks = new THREE.LineSegments(wireGeo, wireMat);

  // --- inner furnace glow: deep red emissive sphere ----------------------------
  const coreGeo = new THREE.IcosahedronGeometry(0.52, 1);
  const coreMat = new THREE.MeshStandardNodeMaterial();
  coreMat.color = new THREE.Color(0.0, 0.0, 0.0);
  coreMat.emissive = new THREE.Color(0.55, 0.06, 0.0);
  coreMat.emissiveIntensity = 1.2;
  coreMat.roughness = 1.0;
  coreMat.metalness = 0.0;
  coreMat.transparent = true;
  coreMat.opacity = 0.72;
  const core = new THREE.Mesh(coreGeo, coreMat);

  // --- ember sparks: recolored orbit particles ---------------------------------
  const sparks = makeOrbitParticles(THREE, TSL, U, 90);
  sparks.points.material.color = new THREE.Color(1.0, 0.3, 0.02);

  parent.add(body);
  parent.add(cracks);
  parent.add(core);
  parent.add(sparks.points);

  // Transient flare state for respond pulse
  let flareDecay: number = 0.0;

  return {
    frame(f: OrbFrame): void {
      // Slow smouldering rotation with a subtle wobble
      const wobble: number = Math.sin(f.time * 0.31) * 0.08;
      body.rotation.y = f.time * 0.04;
      body.rotation.x = wobble;
      cracks.rotation.y = body.rotation.y;
      cracks.rotation.x = body.rotation.x;
      core.rotation.y = -f.time * 0.07;

      // Heat breath: slow sin pulse + energy reactivity
      const breath: number = Math.sin(f.time * 0.7) * 0.5 + 0.5; // [0,1]
      const heatBase: number = 0.35 + breath * 0.25;
      const energyBoost: number = f.energy * 1.4;

      // Respond flare: spike on leading edge, decay over ~1.2s
      if (f.respond > 0.7 && flareDecay < 0.1) {
        flareDecay = 1.0;
      }
      flareDecay = Math.max(0.0, flareDecay - 0.016 * 0.85);

      const totalHeat: number = Math.min(1.0, heatBase + energyBoost + flareDecay * 0.8);

      // Cracks: cool = deep red-orange, hot = bright yellow-orange
      // Interpolate hue by totalHeat: r stays 1.0, g shifts 0.18→0.65
      const crackG: number = 0.18 + totalHeat * 0.47;
      const crackB: number = totalHeat * 0.05;
      wireMat.color.setRGB(1.0, crackG, crackB);
      wireMat.opacity = 0.5 + totalHeat * 0.45;

      // Body emissive glow: charcoal darkens under low heat, brightens on peak
      const bodyEmissiveR: number = 0.08 + totalHeat * 0.22;
      const bodyEmissiveG: number = totalHeat * 0.04;
      bodyMat.emissive.setRGB(bodyEmissiveR, bodyEmissiveG, 0.0);
      bodyMat.emissiveIntensity = 0.3 + totalHeat * 0.7;

      // Inner furnace: breathes red-orange from core
      const coreR: number = 0.4 + totalHeat * 0.55;
      const coreG: number = 0.03 + totalHeat * 0.12;
      coreMat.emissive.setRGB(coreR, coreG, 0.0);
      coreMat.emissiveIntensity = 0.8 + totalHeat * 1.4;
      coreMat.opacity = 0.55 + totalHeat * 0.3;

      // Scale breathing: subtle pulsation on energy
      const scalePulse: number = 1.0 + f.energy * 0.06 + flareDecay * 0.04;
      body.scale.setScalar(scalePulse);
      cracks.scale.setScalar(scalePulse * 1.001); // hair above body to prevent z-fight
      core.scale.setScalar(0.9 + totalHeat * 0.15);

      // Sparks orbit slowly, speed up with energy
      sparks.points.rotation.y = f.time * (0.05 + f.energy * 0.12);
      sparks.points.rotation.x = Math.sin(f.time * 0.18) * 0.2;
    },

    dispose(): void {
      bodyGeo.dispose();
      bodyMat.dispose();
      wireGeo.dispose();
      wireMat.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      sparks.dispose();
      parent.remove(body);
      parent.remove(cracks);
      parent.remove(core);
      parent.remove(sparks.points);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "ember",
  label: "ember",
  family: "mood",
  build,
};
