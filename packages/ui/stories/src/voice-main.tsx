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

// TSL's node API is a runtime proxy with no usable static types, so — like the
// production VoiceWaveform and the prior prototype — the three/tsl modules are
// typed loosely at this boundary and nowhere else.
type WebGPUModule = Record<string, any>;
type TSLModule = Record<string, any>;

/** The five comparison variants. */
export type OrbVariant = "blob" | "core" | "crystal" | "oilslick" | "chrome";

export const ORB_VARIANTS: { id: OrbVariant; label: string }[] = [
  { id: "blob", label: "1 · liquid blob" },
  { id: "core", label: "2 · inner core" },
  { id: "crystal", label: "3 · crystal" },
  { id: "oilslick", label: "4 · oil-slick" },
  { id: "chrome", label: "5 · chrome" },
];

/** Per-frame state pushed into the shader uniforms. Amplitudes are [0,1]. */
interface OrbFrame {
  time: number;
  energy: number;
  low: number;
  listen: number;
  respond: number;
}

/** Shared uniform set every variant reads from. */
interface OrbUniforms {
  uTime: any;
  uEnergy: any;
  uLow: any;
  uListen: any;
  uRespond: any;
  uAspect: any;
  uAccent: any;
}

/** A built orb: its meshes live under a provided parent group. */
interface VariantHandle {
  frame: (f: OrbFrame) => void;
  dispose: () => void;
}

/**
 * Studio-gradient equirectangular environment (bright sky → dark ground with a
 * warm bloom) so reflective/refractive surfaces get a rim and surface sheen.
 * Without an environment the glass reads as matte jelly.
 */
function makeStudioEnv(THREE: WebGPUModule): any {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const sky = ctx.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, "#ffffff");
  sky.addColorStop(0.42, "#cfd8e6");
  sky.addColorStop(0.5, "#3a2c34");
  sky.addColorStop(0.54, "#1c1620");
  sky.addColorStop(1, "#050506");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 512, 256);
  const bloom = ctx.createRadialGradient(150, 64, 0, 150, 64, 150);
  bloom.addColorStop(0, "rgba(255,196,140,0.9)");
  bloom.addColorStop(1, "rgba(255,196,140,0)");
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, 512, 256);
  const texture = new THREE.Texture(c);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Base prismatic transmissive glass shared by the glass-bodied variants. */
function makeGlass(THREE: WebGPUModule): any {
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.transmission = 1;
  m.ior = 1.45;
  m.thickness = 1.6;
  m.roughness = 0.0;
  m.metalness = 0;
  m.dispersion = 9;
  m.clearcoat = 1;
  m.clearcoatRoughness = 0.04;
  m.envMapIntensity = 1.0;
  m.color = new THREE.Color(1, 1, 1);
  return m;
}

// --- variant 1: liquid metaball blob ---------------------------------------
// Break the round silhouette. Big slow lobes ride the bass (uLow), fast surface
// chop rides overall energy, both domain-warped so the shape rolls organically.
// Idle → a gentle wobble; loud speech → an agitated, near-spiky deformation.
function buildBlob(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const { vec3, float, positionLocal, normalLocal, mx_fractal_noise_float } = TSL;
  const geo = new THREE.SphereGeometry(1, 168, 168);
  const mat = makeGlass(THREE);
  const warp = vec3(U.uTime.mul(0.15), U.uTime.mul(0.2), U.uTime.mul(0.1));
  const pW = positionLocal.add(warp);
  const lobes = mx_fractal_noise_float(pW.mul(1.05), 2, 2.0, 0.5);
  const chop = mx_fractal_noise_float(pW.mul(3.4), 4, 2.0, 0.5);
  const disp = lobes
    .mul(float(0.06).add(U.uLow.mul(0.4)))
    .add(chop.mul(float(0.015).add(U.uEnergy.mul(0.16))));
  mat.positionNode = positionLocal.add(normalLocal.mul(disp));
  const mesh = new THREE.Mesh(geo, mat);
  parent.add(mesh);
  return {
    frame(f) {
      mesh.rotation.y = f.time * 0.12;
      mesh.rotation.x = Math.sin(f.time * 0.1) * 0.1;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      parent.remove(mesh);
    },
  };
}

// --- variant 2: inner nucleus ----------------------------------------------
// A near-static glass shell around an opaque emissive core with its own fbm
// surface. The shell refracts AND reflects the core, which is what produces real
// internal depth instead of a hollow bubble. Core brightens/swells with energy,
// flares while responding, contracts while listening.
function buildCore(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const { vec3, float, positionLocal, normalLocal, mix, mx_fractal_noise_float } = TSL;

  const shellGeo = new THREE.SphereGeometry(1, 128, 128);
  const shellMat = makeGlass(THREE);
  const drift = vec3(0, U.uTime.mul(0.2), U.uTime.mul(0.06));
  const ripple = mx_fractal_noise_float(positionLocal.mul(2.2).add(drift), 3, 2, 0.5);
  shellMat.positionNode = positionLocal.add(
    normalLocal.mul(ripple.mul(float(0.012).add(U.uEnergy.mul(0.04)))),
  );
  const shell = new THREE.Mesh(shellGeo, shellMat);

  const coreGeo = new THREE.SphereGeometry(0.55, 96, 96);
  const coreMat = new THREE.MeshBasicNodeMaterial();
  const cDrift = vec3(U.uTime.mul(0.3), U.uTime.mul(0.22), U.uTime.mul(0.15));
  const cNoise = mx_fractal_noise_float(positionLocal.mul(2.6).add(cDrift), 4, 2.1, 0.55)
    .mul(0.5)
    .add(0.5);
  const hot = mix(U.uAccent, vec3(1, 1, 1), cNoise.pow(2.0));
  coreMat.colorNode = hot.mul(
    float(0.55).add(U.uEnergy.mul(1.7)).add(U.uRespond.mul(0.8)),
  );
  coreMat.positionNode = positionLocal.add(
    normalLocal.mul(cNoise.sub(0.5).mul(float(0.03).add(U.uEnergy.mul(0.12)))),
  );
  const core = new THREE.Mesh(coreGeo, coreMat);

  parent.add(shell);
  parent.add(core);
  return {
    frame(f) {
      shell.rotation.y = f.time * 0.14;
      core.rotation.y = -f.time * 0.26;
      core.scale.setScalar(1 + f.energy * 0.2 - f.listen * 0.12);
    },
    dispose() {
      shellGeo.dispose();
      shellMat.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      parent.remove(shell);
      parent.remove(core);
    },
  };
}

// --- variant 3: cut crystal ------------------------------------------------
// Faceted icosahedron with baked flat normals: crisp internal reflections and
// edges that split into rainbow at the rim like a diamond. Facets breathe along
// their normals with energy; dispersion widens (rainbow flares) on speech; spin
// accelerates while responding.
function buildCrystal(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const { float, positionLocal, normalLocal } = TSL;
  const geo = new THREE.IcosahedronGeometry(1, 1).toNonIndexed();
  geo.computeVertexNormals();
  const mat = makeGlass(THREE);
  mat.flatShading = true;
  mat.roughness = 0.02;
  mat.clearcoatRoughness = 0.02;
  mat.dispersion = 10;
  const push = float(0.0).add(U.uEnergy.mul(0.07)).add(U.uRespond.mul(0.04));
  mat.positionNode = positionLocal.add(normalLocal.mul(push));
  const mesh = new THREE.Mesh(geo, mat);
  parent.add(mesh);
  return {
    frame(f) {
      mesh.rotation.y = f.time * (0.2 + f.respond * 0.3);
      mesh.rotation.x = Math.sin(f.time * 0.15) * 0.2;
      mat.dispersion = 6 + f.energy * 14;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      parent.remove(mesh);
    },
  };
}

// --- variant 4: oil-slick + caustic veins ----------------------------------
// Thin-film iridescence shimmers an oil-slick rainbow that shifts with view
// angle, while a ridged-fbm "vein" pattern crawls across the emissive and pulses
// with amplitude. Accent-weighted veins, brightest while responding.
function buildOilSlick(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const { vec3, float, positionLocal, normalLocal, mix, clamp, mx_fractal_noise_float } =
    TSL;
  const geo = new THREE.SphereGeometry(1, 168, 168);
  const mat = makeGlass(THREE);
  mat.iridescence = 1;
  mat.iridescenceIOR = 1.32;
  mat.iridescenceThicknessRange = [120, 560];

  const vDrift = vec3(U.uTime.mul(0.12), U.uTime.mul(-0.08), U.uTime.mul(0.1));
  const fb = mx_fractal_noise_float(positionLocal.mul(3.0).add(vDrift), 4, 2.0, 0.5);
  const ridge = float(1.0).sub(fb.mul(2.0).sub(1.0).abs());
  const vein = clamp(ridge.sub(0.74).mul(5.0), 0, 1);
  const veinColor = mix(U.uAccent, vec3(0.7, 0.85, 1.0), 0.4);
  mat.emissiveNode = veinColor.mul(
    vein.mul(float(0.12).add(U.uEnergy.mul(1.3)).add(U.uRespond.mul(0.5))),
  );
  const ripple = mx_fractal_noise_float(positionLocal.mul(2.2).add(vDrift), 3, 2, 0.5);
  mat.positionNode = positionLocal.add(
    normalLocal.mul(ripple.mul(float(0.012).add(U.uEnergy.mul(0.04)))),
  );
  const mesh = new THREE.Mesh(geo, mat);
  parent.add(mesh);
  return {
    frame(f) {
      mesh.rotation.y = f.time * 0.12;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      parent.remove(mesh);
    },
  };
}

// --- variant 5: liquid chrome ----------------------------------------------
// A mirror-metal droplet reflecting the studio env (note: metals reflect the env
// map, not the cloud plane). Ripple rings travel from the top pole and the
// surface roughens slightly with energy — a polished liquid-metal look.
function buildChrome(
  THREE: WebGPUModule,
  TSL: TSLModule,
  U: OrbUniforms,
  parent: any,
): VariantHandle {
  const { vec3, float, positionLocal, normalLocal, sin, mx_fractal_noise_float } = TSL;
  const geo = new THREE.SphereGeometry(1, 200, 200);
  const mat = new THREE.MeshPhysicalNodeMaterial();
  mat.metalness = 1;
  mat.roughness = 0.04;
  mat.transmission = 0;
  mat.envMapIntensity = 1.4;
  mat.clearcoat = 1;
  mat.clearcoatRoughness = 0.02;
  mat.color = new THREE.Color(0.92, 0.94, 0.98);

  const fromPole = positionLocal.y.oneMinus();
  const rings = sin(fromPole.mul(14.0).sub(U.uTime.mul(4.0)));
  const ringAmp = float(0.0).add(U.uEnergy.mul(0.06)).add(U.uRespond.mul(0.05));
  const chop = mx_fractal_noise_float(
    positionLocal.mul(3.0).add(vec3(0, U.uTime.mul(0.5), 0)),
    3,
    2,
    0.5,
  );
  const disp = rings.mul(ringAmp).add(chop.mul(float(0.005).add(U.uLow.mul(0.05))));
  mat.positionNode = positionLocal.add(normalLocal.mul(disp));
  const mesh = new THREE.Mesh(geo, mat);
  parent.add(mesh);
  return {
    frame(f) {
      mesh.rotation.y = f.time * 0.1;
      mat.roughness = 0.04 + f.energy * 0.12;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      parent.remove(mesh);
    },
  };
}

const VARIANT_BUILDERS: Record<
  OrbVariant,
  (THREE: WebGPUModule, TSL: TSLModule, U: OrbUniforms, parent: any) => VariantHandle
> = {
  blob: buildBlob,
  core: buildCore,
  crystal: buildCrystal,
  oilslick: buildOilSlick,
  chrome: buildChrome,
};

interface StageHandle {
  setVariant: (variant: OrbVariant) => void;
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
  initialVariant: OrbVariant,
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
    const wind = vec3(U.uTime.mul(0.22), U.uTime.mul(-0.015), U.uTime.mul(0.06));
    const noise = mx_fractal_noise_float(p.mul(0.62).add(wind), 5, 2.02, 0.5)
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
    const ro = vec3(U.uTime.mul(0.08), 1.25, 6.0);
    const horizon = clamp(screenUV.y.sub(0.18).mul(1.4), 0, 1);
    const sky = mix(vec3(0.74, 0.86, 1.0), vec3(0.2, 0.45, 0.86), horizon.pow(0.7));
    const sum = vec4(0.0).toVar();
    const t = float(1.2).toVar();
    Loop(46, () => {
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

  const bgGeo = new THREE.PlaneGeometry(120, 120);
  const bgMat = new THREE.MeshBasicNodeMaterial();
  bgMat.colorNode = cloudColor();
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
  const accentLight = new THREE.PointLight(0xff6a1a, 12, 0, 2);
  accentLight.position.set(-1.5, -2.4, 2.6);
  scene.add(accentLight);

  const camera = new THREE.PerspectiveCamera(FOV_DEG, width / height, 0.1, 100);
  camera.position.set(0, 0, CAMERA_Z);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGPURenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));

  function applyOrbScale(h: number) {
    const targetPx = Math.min(Math.max(h * 0.46, 180), 360);
    orbGroup.scale.setScalar((targetPx * worldPerPixel(h)) / 2);
  }
  renderer.setSize(width, height, false);
  applyOrbScale(height);
  await renderer.init();

  let current: VariantHandle = VARIANT_BUILDERS[initialVariant](THREE, TSL, U, contentGroup);
  let mode = initialMode;
  let t = 0;
  let energy = 0;
  let low = 0;
  let listen: number = U.uListen.value;
  let respond: number = U.uRespond.value;

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
    renderer.render(scene, camera);
  });

  return {
    setVariant(variant) {
      current.dispose();
      current = VARIANT_BUILDERS[variant](THREE, TSL, U, contentGroup);
    },
    setMode(next) {
      mode = next;
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      U.uAspect.value = w / Math.max(1, h);
      applyOrbScale(h);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      current.dispose();
      bgGeo.dispose();
      bgMat.dispose();
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
  const [variant, setVariant] = useState<OrbVariant>("blob");
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
      "blob",
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
          bottom: 28,
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          alignItems: "center",
        }}
      >
        <div style={pillRowStyle}>
          {ORB_VARIANTS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setVariant(v.id)}
              style={pillStyle(v.id === variant)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div style={pillRowStyle}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
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
  gap: 8,
  padding: 6,
  borderRadius: 12,
  background: "rgba(10,10,14,0.5)",
  backdropFilter: "blur(8px)",
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
    fontSize: 13,
    letterSpacing: "0.03em",
    padding: "8px 16px",
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
