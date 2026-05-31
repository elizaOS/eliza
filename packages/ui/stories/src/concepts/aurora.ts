import type {
  ConceptDescriptor,
  OrbUniforms,
  TSLModule,
  VariantHandle,
  WebGPUModule,
} from "../orb-kit.ts";

// Aurora borealis — 5 translucent flowing ribbons orbiting a dark core.
// Each ribbon is a tall thin PlaneGeometry bent once at build time into a
// curved vertical sheet; per-frame we rotate/tilt/undulate purely in JS.
// A faint star-point cloud drifts above for depth. No TSL node graphs used.

// Hues for the 5 ribbons: greens, teals, violets. Each is [r,g,b] in 0-1.
const RIBBON_HUES: [number, number, number][] = [
  [0.05, 0.88, 0.55], // bright green
  [0.0,  0.72, 0.82], // cyan-teal
  [0.12, 0.55, 0.75], // deep teal-blue
  [0.45, 0.18, 0.88], // violet
  [0.68, 0.12, 0.72], // magenta-violet
];

// Per-ribbon orbit offsets and animation parameters.
const RIBBON_PARAMS = [
  { orbitY: 0.0,  orbitR: 0.82, speed: 0.38, phase: 0.0 },
  { orbitY: 0.18, orbitR: 0.90, speed: 0.29, phase: 1.26 },
  { orbitY: -0.14,orbitR: 0.86, speed: 0.44, phase: 2.51 },
  { orbitY: 0.08, orbitR: 0.95, speed: 0.33, phase: 3.77 },
  { orbitY: -0.22,orbitR: 0.78, speed: 0.41, phase: 5.03 },
];

function build(THREE: WebGPUModule, _TSL: TSLModule, _U: OrbUniforms, parent: any): VariantHandle {
  // --- Build curved ribbon geometries once at construction ---
  // PlaneGeometry(width, height, wSegs, hSegs): width=0.22, height=2.2, hSegs=36
  // We walk the Y-column of vertices and displace X,Z into an arc so the ribbon
  // wraps ~90° of a cylinder. The width stays flat (wSegs=1).
  const RIBBON_W = 0.22;
  const RIBBON_H = 2.2;
  const H_SEGS = 36;

  type RibbonEntry = {
    mesh: any;
    geo: any;
    mat: any;
    param: typeof RIBBON_PARAMS[number];
    baseR: number;
    baseG: number;
    baseB: number;
  };

  const ribbons: RibbonEntry[] = [];

  for (let ri = 0; ri < RIBBON_HUES.length; ri += 1) {
    const hue = RIBBON_HUES[ri]!;
    const param = RIBBON_PARAMS[ri]!;

    // Build a PlaneGeometry and bend it into an arc around the orb center.
    const geo = new THREE.PlaneGeometry(RIBBON_W, RIBBON_H, 1, H_SEGS);
    const pos = geo.attributes.position;
    const arcAngle = Math.PI * 0.55; // ~99° arc spread for each ribbon

    for (let vi = 0; vi < pos.count; vi += 1) {
      const rawX: number = pos.getX(vi);
      const rawY: number = pos.getY(vi);
      const rawZ: number = pos.getZ(vi);

      // Map Y from [-H/2, H/2] to arc parameter t in [-arcAngle/2, arcAngle/2].
      const t = (rawY / (RIBBON_H / 2)) * (arcAngle / 2);
      const arcRadius = param.orbitR;

      // Cylinder bend: X becomes the arc curve, Z is depth into the arc.
      const curveX = Math.sin(t) * arcRadius;
      const curveZ = (Math.cos(t) - 1) * arcRadius * 0.5;

      // Keep a thin width (rawX stays as a lateral offset in the ribbon plane).
      pos.setXYZ(vi, curveX + rawX * Math.cos(t), rawY + param.orbitY * 0.0, curveZ + rawZ);
      // Suppress unused variable warning — rawZ is zero for PlaneGeometry
      void rawZ;
    }
    geo.computeVertexNormals();

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    // NormalBlending: additive ribbons wash to white on the bright cloud sky.
    mat.blending = THREE.NormalBlending;
    mat.color = new THREE.Color(hue[0], hue[1], hue[2]);
    mat.opacity = 0.45;

    const mesh = new THREE.Mesh(geo, mat);
    // Tilt each ribbon slightly on X so they don't all lie in the XZ plane
    mesh.rotation.x = (ri % 2 === 0 ? 1 : -1) * 0.18 + ri * 0.07;
    parent.add(mesh);

    ribbons.push({
      mesh,
      geo,
      mat,
      param,
      baseR: hue[0],
      baseG: hue[1],
      baseB: hue[2],
    });
  }

  // --- Star points: small cool dots drifting around for depth ---
  const STAR_COUNT = 60;
  const starPositions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i += 1) {
    // Distribute stars in a shell between r=0.5 and r=1.25
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 0.5 + Math.random() * 0.75;
    starPositions[i * 3    ] = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    starPositions[i * 3 + 2] = r * Math.cos(phi);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  const starMat = new THREE.PointsNodeMaterial();
  starMat.transparent = true;
  starMat.depthWrite = false;
  // NormalBlending cool sparkles — white additive stars vanish on the sky.
  starMat.blending = THREE.NormalBlending;
  starMat.color = new THREE.Color(0.55, 0.72, 0.95);
  starMat.opacity = 0.7;
  starMat.size = 0.02;
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  parent.add(stars);

  return {
    frame(f) {
      for (let ri = 0; ri < ribbons.length; ri += 1) {
        const rb = ribbons[ri]!;
        const { mesh, mat, param } = rb;

        // Spread ribbons evenly around Y as standing curtains; they sway rather
        // than spin so the form reads as vertical sheets, not an orbiting X.
        const baseAngle = (ri / ribbons.length) * Math.PI * 2;
        const sway = Math.sin(f.time * param.speed * 0.6 + param.phase) * 0.4;
        mesh.rotation.y = baseAngle + sway;

        // Undulation: gentle tilt on Z that sweeps like a curtain swaying.
        const undulateAmp = 0.1 + f.energy * 0.22;
        mesh.rotation.z =
          Math.sin(f.time * param.speed * 0.7 + param.phase) * undulateAmp;

        // Keep ribbons near-vertical with a small drifting tilt for depth.
        const baseTiltX = (ri % 2 === 0 ? 1 : -1) * 0.1;
        mesh.rotation.x = baseTiltX + Math.cos(f.time * 0.13 + param.phase) * 0.05;

        // Vertical position drift for the orbitY offset.
        mesh.position.y =
          param.orbitY + Math.sin(f.time * 0.19 + param.phase * 0.5) * 0.04;

        // Each ribbon keeps its own hue — brighten on respond/energy instead of
        // collapsing every ribbon to the same magenta.
        const lift = 1.0 + f.respond * 0.25 + f.energy * 0.18;
        mat.color.setRGB(
          Math.min(rb.baseR * lift, 1.0),
          Math.min(rb.baseG * lift, 1.0),
          Math.min(rb.baseB * lift, 1.0),
        );
        mat.opacity = Math.min(0.42 + f.energy * 0.2 + f.respond * 0.14, 0.7);
      }

      // Stars drift gently and brighten with energy.
      stars.rotation.y = f.time * 0.04;
      stars.rotation.x = f.time * 0.02;
      starMat.opacity = 0.5 + f.energy * 0.3 + f.respond * 0.12;
    },

    dispose() {
      for (const rb of ribbons) {
        rb.geo.dispose();
        rb.mat.dispose();
        parent.remove(rb.mesh);
      }
      starGeo.dispose();
      starMat.dispose();
      parent.remove(stars);
    },
  };
}

export const concept: ConceptDescriptor = {
  id: "aurora",
  label: "aurora",
  family: "mood",
  build,
};
