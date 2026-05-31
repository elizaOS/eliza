import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@ui-src/styles.ts";
import {
  type FrequencyAnalyser,
  sampleFrequencyLevels,
  summarizeLevels,
  type VoiceWaveformMode,
} from "@ui-src/components/voice/VoiceWaveform.tsx";
import { makeOscillatingAnalyser } from "./stories/voice.tsx";
import {
  type ConceptBuilder,
  type ConceptDescriptor,
  type ConceptFamily,
  makeChromeGem,
  makeCrystalGlass,
  makeFacetedIcosa,
  makeGlass,
  makeOrbitParticles,
  makeStudioEnv,
  type OrbUniforms,
  type TSLModule,
  type VariantHandle,
  type WebGPUModule,
} from "./orb-kit.ts";
import { CONCEPTS } from "./concepts/index.ts";
import "./stories.css";

// Home accent so every variant is judged under the real surface accent.
document.documentElement.style.setProperty("--accent-rgb", "255, 88, 0");

// Camera framing constants shared by the orb sizing math.
const CAMERA_Z = 4.6;
const FOV_DEG = 35;
const HALF_FOV_TAN = Math.tan(((FOV_DEG / 2) * Math.PI) / 180);

/** World units per screen pixel at the z=0 focal plane for the orb camera. */
function worldPerPixel(heightPx: number): number {
  return (2 * CAMERA_Z * HALF_FOV_TAN) / Math.max(1, heightPx);
}

// --- reference variant 1: swarm — glass gem inside an orbiting particle halo --
// A clean nested glass gem (refractive shell + chrome heart) wrapped in a GPU
// particle swarm that orbits on tilted rings and breathes outward with the
// voice, so points fly off on peaks. Slow spin throughout.
function buildSwarm(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const shellGeo = makeFacetedIcosa(THREE, 1, 1, 0.1);
  const shellMat = makeCrystalGlass(THREE);
  shellMat.flatShading = true;
  const shell = new THREE.Mesh(shellGeo, shellMat);

  const midGeo = new THREE.IcosahedronGeometry(0.5, 1);
  const midMat = makeChromeGem(THREE);
  const mid = new THREE.Mesh(midGeo, midMat);

  const swarm = makeOrbitParticles(THREE, TSL, U, 240);

  parent.add(shell);
  parent.add(mid);
  parent.add(swarm.points);
  return {
    frame(f) {
      shell.rotation.y = f.time * 0.06;
      shell.rotation.x = Math.sin(f.time * 0.08) * 0.12;
      mid.rotation.y = -f.time * 0.1;
      swarm.points.rotation.y = f.time * 0.04;
    },
    dispose() {
      shellGeo.dispose();
      shellMat.dispose();
      midGeo.dispose();
      midMat.dispose();
      swarm.dispose();
      parent.remove(shell);
      parent.remove(mid);
      parent.remove(swarm.points);
    },
  };
}

// --- reference variant 2: intense glass — thick, high-IOR, dispersive --------
// Maximal glass: thick walls, a high index of refraction and strong dispersion
// so the clouds bend hard and split into spectral fire at the facet edges. A
// reflective gem inside reads through the heavy refraction. Slow spin.
function buildIntense(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const shellGeo = makeFacetedIcosa(THREE, 1, 1, 0.12);
  const shellMat = makeGlass(THREE);
  shellMat.flatShading = true;
  shellMat.ior = 1.7;
  shellMat.thickness = 2.4;
  shellMat.dispersion = 6;
  shellMat.envMapIntensity = 1.2;
  shellMat.attenuationColor = new THREE.Color(0.8, 0.88, 1.0);
  shellMat.attenuationDistance = 2.0;
  const shell = new THREE.Mesh(shellGeo, shellMat);

  const innerGeo = makeFacetedIcosa(THREE, 0.55, 1, 0.12);
  const innerMat = makeChromeGem(THREE);
  const inner = new THREE.Mesh(innerGeo, innerMat);

  parent.add(shell);
  parent.add(inner);
  return {
    frame(f) {
      shell.rotation.y = f.time * 0.05;
      shell.rotation.z = Math.sin(f.time * 0.06) * 0.1;
      inner.rotation.y = -f.time * 0.08;
      inner.scale.setScalar(1 + f.energy * 0.1);
    },
    dispose() {
      shellGeo.dispose();
      shellMat.dispose();
      innerGeo.dispose();
      innerMat.dispose();
      parent.remove(shell);
      parent.remove(inner);
    },
  };
}

// --- reference variant 3: fresnel — clear glass with a view-angle rim glow ----
// Colourless glass whose facets stay transparent face-on but flare with a
// fresnel rim at grazing angles — a bright cool edge that warms toward the
// accent while responding. A chrome heart anchors the centre. Slow spin.
function buildFresnel(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const { vec3, float, mix, normalView, positionViewDirection } = TSL;
  const shellGeo = makeFacetedIcosa(THREE, 1, 1, 0.1);
  const shellMat = makeCrystalGlass(THREE);
  shellMat.flatShading = true;
  const fresnel = normalView
    .dot(positionViewDirection)
    .abs()
    .oneMinus()
    .pow(2.5);
  const rimColor = mix(vec3(0.7, 0.85, 1.0), U.uAccent, U.uRespond.mul(0.6));
  shellMat.emissiveNode = rimColor.mul(
    fresnel.mul(float(0.5).add(U.uEnergy.mul(1.4)).add(U.uRespond.mul(0.8))),
  );
  const shell = new THREE.Mesh(shellGeo, shellMat);

  const midGeo = new THREE.IcosahedronGeometry(0.5, 0);
  const midMat = makeChromeGem(THREE);
  const mid = new THREE.Mesh(midGeo, midMat);

  parent.add(shell);
  parent.add(mid);
  return {
    frame(f) {
      shell.rotation.y = f.time * 0.06;
      shell.rotation.x = Math.sin(f.time * 0.07) * 0.1;
      mid.rotation.y = -f.time * 0.09;
    },
    dispose() {
      shellGeo.dispose();
      shellMat.dispose();
      midGeo.dispose();
      midMat.dispose();
      parent.remove(shell);
      parent.remove(mid);
    },
  };
}

// --- reference variant 4: refract — balanced transparency and reflection -----
// Real glass tuned for both at once: high transmission so you see the clouds
// through it, high env reflection so the facets carry crisp mirror highlights.
// Chrome gem plus a pulsing nucleus for depth. Slow spin.
function buildRefract(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const { vec3, float } = TSL;
  const shellGeo = makeFacetedIcosa(THREE, 1, 1, 0.1);
  const shellMat = makeCrystalGlass(THREE);
  shellMat.flatShading = true;
  shellMat.transmission = 0.92;
  shellMat.roughness = 0.04;
  shellMat.envMapIntensity = 1.6;
  shellMat.ior = 1.52;
  const shell = new THREE.Mesh(shellGeo, shellMat);

  const midGeo = new THREE.IcosahedronGeometry(0.58, 1);
  const midMat = makeChromeGem(THREE);
  const mid = new THREE.Mesh(midGeo, midMat);

  const coreGeo = new THREE.IcosahedronGeometry(0.3, 0);
  const coreMat = new THREE.MeshBasicNodeMaterial();
  coreMat.colorNode = vec3(0.82, 0.9, 1.0).mul(
    float(0.4).add(U.uEnergy.mul(1.4)).add(U.uRespond.mul(0.6)),
  );
  const core = new THREE.Mesh(coreGeo, coreMat);

  parent.add(shell);
  parent.add(mid);
  parent.add(core);
  return {
    frame(f) {
      shell.rotation.y = f.time * 0.06;
      shell.rotation.x = Math.sin(f.time * 0.05) * 0.1;
      mid.rotation.y = -f.time * 0.1;
      core.rotation.y = f.time * 0.14;
      core.scale.setScalar(1 + f.energy * 0.2 - f.listen * 0.08);
    },
    dispose() {
      shellGeo.dispose();
      shellMat.dispose();
      midGeo.dispose();
      midMat.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      parent.remove(shell);
      parent.remove(mid);
      parent.remove(core);
    },
  };
}

// --- reference variant 5: shards — everything at once ------------------------
// The combined showcase: colourless glass with a fresnel rim, a chrome heart,
// and an orbiting particle swarm that flies off on peaks. Slowest spin so the
// refraction and the particle motion both read clearly.
function buildShards(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const { vec3, float, mix, normalView, positionViewDirection } = TSL;
  const shellGeo = makeFacetedIcosa(THREE, 1, 1, 0.12);
  const shellMat = makeCrystalGlass(THREE);
  shellMat.flatShading = true;
  shellMat.envMapIntensity = 1.4;
  const fresnel = normalView
    .dot(positionViewDirection)
    .abs()
    .oneMinus()
    .pow(2.5);
  shellMat.emissiveNode = mix(
    vec3(0.7, 0.85, 1.0),
    U.uAccent,
    U.uRespond.mul(0.6),
  ).mul(fresnel.mul(float(0.4).add(U.uEnergy.mul(1.2)).add(U.uRespond.mul(0.7))));
  const shell = new THREE.Mesh(shellGeo, shellMat);

  const midGeo = new THREE.IcosahedronGeometry(0.5, 1);
  const midMat = makeChromeGem(THREE);
  const mid = new THREE.Mesh(midGeo, midMat);

  const swarm = makeOrbitParticles(THREE, TSL, U, 260);

  parent.add(shell);
  parent.add(mid);
  parent.add(swarm.points);
  return {
    frame(f) {
      shell.rotation.y = f.time * 0.05;
      shell.rotation.z = Math.sin(f.time * 0.06) * 0.08;
      mid.rotation.y = -f.time * 0.09;
      swarm.points.rotation.y = f.time * 0.03;
    },
    dispose() {
      shellGeo.dispose();
      shellMat.dispose();
      midGeo.dispose();
      midMat.dispose();
      swarm.dispose();
      parent.remove(shell);
      parent.remove(mid);
      parent.remove(swarm.points);
    },
  };
}

// The five original glass references, shown as their own selector row ahead of
// the 20 authored concepts.
const REFERENCE_VARIANTS: { id: string; label: string; build: ConceptBuilder }[] =
  [
    { id: "swarm", label: "swarm", build: buildSwarm },
    { id: "intense", label: "intense", build: buildIntense },
    { id: "fresnel", label: "fresnel", build: buildFresnel },
    { id: "refract", label: "refract", build: buildRefract },
    { id: "shards", label: "shards", build: buildShards },
  ];

// id → builder for every selectable orb (references + authored concepts).
const BUILDERS: Map<string, ConceptBuilder> = new Map();
for (const v of REFERENCE_VARIANTS) BUILDERS.set(v.id, v.build);
for (const c of CONCEPTS) BUILDERS.set(c.id, c.build);

const DEFAULT_VARIANT = "shards";

// Selector rows: the reference set, then the authored concepts grouped by family
// in a fixed order. Empty families are skipped so the harness stays tidy before
// every concept exists.
const FAMILY_ORDER: ConceptFamily[] = [
  "artful",
  "mood",
  "sci-fi",
  "geometric",
  "abstract",
];
interface SelectorRow {
  label: string;
  items: { id: string; label: string }[];
}
const SELECTOR_ROWS: SelectorRow[] = [
  { label: "ref", items: REFERENCE_VARIANTS.map((v) => ({ id: v.id, label: v.label })) },
  ...FAMILY_ORDER.map((family) => ({
    label: family,
    items: CONCEPTS.filter((c) => c.family === family).map((c) => ({
      id: c.id,
      label: c.label,
    })),
  })).filter((row) => row.items.length > 0),
];

/**
 * Build a concept body under its own holder group so a throw can't leave half a
 * concept attached, and a per-frame or build error can't kill the shared stage.
 * The harness runs authored concept code that can't be exercised before it's
 * loaded here, so the guard is the thing that keeps every *other* concept
 * selectable when one is malformed.
 */
function safeBuild(
  build: ConceptBuilder,
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const holder = new THREE.Group();
  parent.add(holder);
  try {
    const handle = build(THREE, TSL, U, holder);
    let frameDead = false;
    return {
      frame(f) {
        if (frameDead) return;
        try {
          handle.frame(f);
        } catch (err) {
          frameDead = true;
          console.error("[orb] concept frame threw; freezing it", err);
        }
      },
      dispose() {
        try {
          handle.dispose();
        } catch (err) {
          console.error("[orb] concept dispose threw", err);
        }
        parent.remove(holder);
      },
    };
  } catch (err) {
    console.error("[orb] concept build threw", err);
    parent.remove(holder);
    return { frame() {}, dispose() {} };
  }
}

interface StageHandle {
  setVariant: (variant: string) => void;
  setMode: (mode: VoiceWaveformMode) => void;
  resize: (width: number, height: number) => void;
  dispose: () => void;
}

/**
 * Full-bleed comparison stage: the shared volumetric cloudscape (iq XslGRr,
 * ported to TSL) with a swappable orb variant in front, refracting it. The
 * cloud backdrop, env, rim glow, camera and renderer are built once; switching
 * variants only rebuilds the orb body.
 */
async function mountStage(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  initialVariant: string,
  initialMode: VoiceWaveformMode,
  analyser: FrequencyAnalyser,
): Promise<StageHandle> {
  const [THREE, TSL] = await Promise.all([
    import("three/webgpu"),
    import("three/tsl"),
  ]);
  const {
    Fn,
    Loop,
    Break,
    If,
    uniform,
    vec3,
    vec4,
    float,
    screenUV,
    normalView,
    positionViewDirection,
    mix,
    clamp,
    max,
    normalize,
    mx_fractal_noise_float,
  } = TSL;

  const U: OrbUniforms = {
    uTime: uniform(0),
    uEnergy: uniform(0),
    uLow: uniform(0),
    uListen: uniform(initialMode === "listening" ? 1 : 0),
    uRespond: uniform(initialMode === "responding" ? 1 : 0),
    uAspect: uniform(width / Math.max(1, height)),
    uAccent: uniform(new THREE.Color(1, 0.34, 0)),
  };

  // --- shared volumetric cloud backdrop (iq XslGRr, ported to TSL) ----------
  type Vec3Node = ReturnType<typeof vec3>;
  const densityAt = (p: Vec3Node) => {
    const wind = vec3(U.uTime.mul(0.08), U.uTime.mul(-0.006), U.uTime.mul(0.022));
    const noise = mx_fractal_noise_float(p.mul(0.62).add(wind), 4, 2.02, 0.5)
      .mul(0.5)
      .add(0.5);
    const slab = float(1.0).sub(p.y.sub(3.0).abs().div(1.7)).clamp(0, 1);
    return noise.mul(slab).sub(0.34).mul(1.7).clamp(0, 1);
  };
  const sunDir = normalize(vec3(0.55, 0.62, -0.55));
  const cloudColor = Fn(() => {
    const ndc = screenUV.sub(0.5).mul(2.0);
    const rd = normalize(
      vec3(ndc.x.mul(U.uAspect).mul(0.62), ndc.y.mul(0.62).add(0.12), float(-1.0)),
    );
    const ro = vec3(U.uTime.mul(0.03), 1.25, 6.0);
    const horizon = clamp(screenUV.y.sub(0.18).mul(1.4), 0, 1);
    const sky = mix(vec3(0.74, 0.86, 1.0), vec3(0.2, 0.45, 0.86), horizon.pow(0.7));
    const sum = vec4(0.0).toVar();
    const t = float(1.2).toVar();
    Loop(32, () => {
      If(sum.w.greaterThan(0.985), () => {
        Break();
      });
      const pos = ro.add(rd.mul(t));
      const den = densityAt(pos);
      If(den.greaterThan(0.01), () => {
        const lit = clamp(den.sub(densityAt(pos.add(sunDir.mul(0.45)))).mul(2.6), 0, 1);
        const base = mix(vec3(0.42, 0.5, 0.62), vec3(1.0, 1.0, 1.0), den.oneMinus());
        const sun = vec3(1.0, 0.92, 0.78).mul(lit.mul(1.15));
        const a = den.mul(0.46);
        sum.addAssign(vec4(base.add(sun).mul(a), a).mul(sum.w.oneMinus()));
      });
      t.addAssign(max(0.12, t.mul(0.025)));
    });
    return vec3(sky.mul(sum.w.oneMinus()).add(sum.xyz));
  });

  // The cloud raymarch is the dominant cost — and transmission makes it run
  // twice a frame at full res. Instead, raymarch into a small offscreen target a
  // few times a second; the visible backdrop and the gem's refraction source
  // both sample that cheap texture, so the heavy shader never runs at full res.
  const CLOUD_SCALE = 0.4;
  const CLOUD_EVERY = 2;
  const cloudRT = new THREE.RenderTarget(
    Math.max(2, Math.round(width * CLOUD_SCALE)),
    Math.max(2, Math.round(height * CLOUD_SCALE)),
    { depthBuffer: false },
  );
  const cloudScene = new THREE.Scene();
  const cloudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const cloudQuadGeo = new THREE.PlaneGeometry(2, 2);
  const cloudQuadMat = new THREE.MeshBasicNodeMaterial();
  cloudQuadMat.colorNode = cloudColor();
  cloudQuadMat.depthTest = false;
  cloudQuadMat.depthWrite = false;
  const cloudQuad = new THREE.Mesh(cloudQuadGeo, cloudQuadMat);
  cloudScene.add(cloudQuad);

  const bgGeo = new THREE.PlaneGeometry(120, 120);
  const bgMat = new THREE.MeshBasicNodeMaterial();
  // Vibrant orange field with a very slow, very smooth noise drift: the color
  // gently oscillates between a deep orange and a warmer tangerine over time
  // (an animated flow-noise gradient). Two low octaves keep it buttery-smooth;
  // the slow time term keeps the motion gentle. Linear RGB is chosen so the
  // sRGB output lands on a punchy ~#ff5d00 ↔ ~#ff7c12 instead of pale amber.
  const orangeField = Fn(() => {
    const t = U.uTime.mul(0.045);
    const q1 = vec3(screenUV.x.mul(1.1), screenUV.y.mul(1.1), t);
    const n1 = mx_fractal_noise_float(q1, 2, 2.0, 0.5).mul(0.5).add(0.5);
    const q2 = vec3(
      screenUV.x.mul(0.6).add(7.2),
      screenUV.y.mul(0.6).sub(3.1),
      t.mul(0.7).add(2.0),
    );
    const n2 = mx_fractal_noise_float(q2, 2, 2.0, 0.5).mul(0.5).add(0.5);
    const deep = vec3(1.0, 0.12, 0.0);
    const tangerine = vec3(1.0, 0.2, 0.015);
    const base = mix(deep, tangerine, n1);
    // Gentle brightness breath (±~7%) on a second, even slower noise channel.
    return base.mul(float(0.93).add(n2.mul(0.14)));
  });
  bgMat.colorNode = orangeField();
  const backdrop = new THREE.Mesh(bgGeo, bgMat);
  backdrop.position.set(0, 0, -10);

  // --- shared rim glow: back-faced fresnel shell bleeding the accent ---------
  const glowGeo = new THREE.SphereGeometry(1.06, 48, 48);
  const glowMat = new THREE.MeshBasicNodeMaterial();
  glowMat.transparent = true;
  glowMat.depthWrite = false;
  glowMat.side = THREE.BackSide;
  const haloFresnel = normalView.dot(positionViewDirection).abs().oneMinus().pow(2.2);
  glowMat.colorNode = U.uAccent;
  glowMat.opacityNode = haloFresnel.mul(
    float(0.04).add(U.uEnergy.mul(0.3)).add(U.uRespond.mul(0.16)).add(U.uListen.mul(0.08)),
  );
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.renderOrder = 2;
  // Every variant is now a self-lit glass gem, so the shared accent halo stays
  // off — kept only as scaffolding for quick A/B experiments.
  glow.visible = false;

  // orbGroup carries the pixel-stable scale; the swappable orb body lives in a
  // child contentGroup so a variant switch never disturbs the glow or scale.
  const contentGroup = new THREE.Group();
  const orbGroup = new THREE.Group();
  orbGroup.add(contentGroup);
  orbGroup.add(glow);

  const scene = new THREE.Scene();
  const envTexture = makeStudioEnv(THREE);
  scene.environment = envTexture;
  scene.add(backdrop);
  scene.add(orbGroup);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2.5, 3, 4);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(FOV_DEG, width / height, 0.1, 100);
  camera.position.set(0, 0, CAMERA_Z);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGPURenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(1);

  function applyOrbScale(h: number) {
    const targetPx = Math.min(Math.max(h * 0.46, 180), 360);
    orbGroup.scale.setScalar((targetPx * worldPerPixel(h)) / 2);
  }
  renderer.setSize(width, height, false);
  applyOrbScale(height);
  await renderer.init();

  function resolveBuild(variant: string): ConceptBuilder {
    return BUILDERS.get(variant) ?? BUILDERS.get(DEFAULT_VARIANT) ?? buildShards;
  }

  let current: VariantHandle = safeBuild(
    resolveBuild(initialVariant),
    THREE,
    TSL,
    U,
    contentGroup,
  );
  let mode = initialMode;
  let t = 0;
  let energy = 0;
  let low = 0;
  let listen: number = U.uListen.value;
  let respond: number = U.uRespond.value;
  let frame = 0;
  // A concept whose node graph fails to compile makes the main render throw; log
  // it once (reset on each variant switch) so the loop and backdrop survive and
  // the next concept is still selectable.
  let renderErrorLogged = false;

  renderer.setAnimationLoop(() => {
    t += 0.016;
    const s = summarizeLevels(sampleFrequencyLevels(analyser, 32));
    energy += (s.energy - energy) * 0.16;
    low += (s.low - low) * 0.2;
    listen += ((mode === "listening" ? 1 : 0) - listen) * 0.08;
    respond += ((mode === "responding" ? 1 : 0) - respond) * 0.08;
    U.uTime.value = t;
    U.uEnergy.value = energy;
    U.uLow.value = low;
    U.uListen.value = listen;
    U.uRespond.value = respond;
    current.frame({ time: t, energy, low, listen, respond });
    // The backdrop shader is concept-independent, so it always renders even when
    // a concept poisons the main pass.
    if (frame % CLOUD_EVERY === 0) {
      renderer.setRenderTarget(cloudRT);
      renderer.render(cloudScene, cloudCam);
      renderer.setRenderTarget(null);
    }
    frame += 1;
    try {
      renderer.render(scene, camera);
    } catch (err) {
      if (!renderErrorLogged) {
        renderErrorLogged = true;
        console.error("[orb] main render threw (likely a concept node graph)", err);
      }
    }
  });

  return {
    setVariant(variant) {
      current.dispose();
      renderErrorLogged = false;
      current = safeBuild(resolveBuild(variant), THREE, TSL, U, contentGroup);
    },
    setMode(next) {
      mode = next;
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      U.uAspect.value = w / Math.max(1, h);
      cloudRT.setSize(
        Math.max(2, Math.round(w * CLOUD_SCALE)),
        Math.max(2, Math.round(h * CLOUD_SCALE)),
      );
      applyOrbScale(h);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      current.dispose();
      bgGeo.dispose();
      bgMat.dispose();
      cloudRT.dispose();
      cloudQuadGeo.dispose();
      cloudQuadMat.dispose();
      glowGeo.dispose();
      glowMat.dispose();
      envTexture.dispose();
      renderer.dispose();
    },
  };
}

const MODES: VoiceWaveformMode[] = ["idle", "listening", "responding"];

function ComparisonStage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<StageHandle | null>(null);
  const [variant, setVariant] = useState<string>(DEFAULT_VARIANT);
  const [mode, setMode] = useState<VoiceWaveformMode>("responding");

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const analyser = makeOscillatingAnalyser();
    let disposed = false;
    const rect = wrap.getBoundingClientRect();
    void mountStage(
      canvas,
      Math.round(rect.width),
      Math.round(rect.height),
      DEFAULT_VARIANT,
      "responding",
      analyser,
    ).then((h) => {
      if (disposed) {
        h.dispose();
        return;
      }
      handleRef.current = h;
    });
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      handleRef.current?.resize(
        Math.round(e.contentRect.width),
        Math.round(e.contentRect.height),
      );
    });
    ro.observe(wrap);
    return () => {
      disposed = true;
      ro.disconnect();
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    handleRef.current?.setVariant(variant);
  }, [variant]);

  useEffect(() => {
    handleRef.current?.setMode(mode);
  }, [mode]);

  return (
    <div ref={wrapRef} style={{ position: "fixed", inset: 0, background: "#07080b" }}>
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 16,
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          alignItems: "center",
          maxWidth: "94vw",
        }}
      >
        {SELECTOR_ROWS.map((row) => (
          <div key={row.label} style={pillRowStyle}>
            <span style={rowLabelStyle}>{row.label}</span>
            {row.items.map((it) => (
              <button
                key={it.id}
                type="button"
                data-variant={it.id}
                onClick={() => setVariant(it.id)}
                style={pillStyle(it.id === variant)}
              >
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 28,
          transform: "translateX(-50%)",
        }}
      >
        <div style={pillRowStyle}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              data-mode={m}
              onClick={() => setMode(m)}
              style={pillStyle(m === mode)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const pillRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  alignItems: "center",
  gap: 6,
  padding: 6,
  borderRadius: 12,
  background: "rgba(10,10,14,0.5)",
  backdropFilter: "blur(8px)",
};

const rowLabelStyle: CSSProperties = {
  color: "rgba(255,255,255,0.4)",
  fontFamily: "Poppins, system-ui, sans-serif",
  fontWeight: 600,
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  padding: "0 4px",
  minWidth: 48,
  textAlign: "right",
};

function pillStyle(active: boolean): CSSProperties {
  return {
    background: active ? "var(--accent-primary, #ff5800)" : "transparent",
    border: "1px solid rgba(255,255,255,0.22)",
    borderRadius: 8,
    color: active ? "#fff" : "rgba(255,255,255,0.85)",
    cursor: "pointer",
    fontFamily: "Poppins, system-ui, sans-serif",
    fontWeight: 600,
    fontSize: 11,
    letterSpacing: "0.02em",
    padding: "5px 10px",
  };
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element missing");
}
// Reuse one root across HMR re-evaluations so a hot update never mounts a second
// React tree that spins up a colliding WebGPURenderer on the same canvas.
const rootHost = window as unknown as { __glassRoot?: ReturnType<typeof createRoot> };
const root = rootHost.__glassRoot ?? createRoot(container);
rootHost.__glassRoot = root;
root.render(<ComparisonStage />);
