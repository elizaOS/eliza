import { StrictMode, useEffect, useRef, useState } from "react";
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

// Home accent so the prototype is judged under the real surface accent.
document.documentElement.style.setProperty("--accent-rgb", "255, 88, 0");

// Camera framing constants shared by the orb sizing math.
const CAMERA_Z = 4.6;
const FOV_DEG = 35;
const HALF_FOV_TAN = Math.tan(((FOV_DEG / 2) * Math.PI) / 180);

interface GlassHandle {
  setMode: (mode: VoiceWaveformMode) => void;
  resize: (width: number, height: number) => void;
  dispose: () => void;
}

/**
 * Studio-gradient equirectangular environment (bright sky → dark ground with a
 * warm bloom) so the glass has a reflective rim and surface sheen. Without an
 * environment the glass reads as matte jelly.
 */
function makeEnvTexture(THREE: typeof import("three/webgpu")): {
  texture: InstanceType<typeof import("three/webgpu").Texture>;
} {
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
  return { texture };
}

/** World units per screen pixel at the z=0 focal plane for the orb camera. */
function worldPerPixel(heightPx: number): number {
  return (2 * CAMERA_Z * HALF_FOV_TAN) / Math.max(1, heightPx);
}

/**
 * Full-bleed glass orb refracting volumetric clouds. The clouds are a TSL port
 * of the raymarched-fbm approach from iq's "Clouds" (ShaderToy XslGRr): a
 * drifting multi-octave noise field, sampled along a virtual view ray, lit by a
 * single sun via the density gradient, composited front-to-back over a sky. They
 * are drawn on a big screen-space backdrop plane in the opaque pass, so the
 * transmissive sphere in front refracts them. The orb is scaled to a target
 * pixel diameter so it stays a consistent size across viewports. `mode` + audio
 * energy drive surface ripple, breathing scale, spin, and rim glow.
 */
async function mountGlass(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  initialMode: VoiceWaveformMode,
  analyser: FrequencyAnalyser,
): Promise<GlassHandle> {
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
    vec2,
    vec3,
    vec4,
    float,
    screenUV,
    positionLocal,
    normalLocal,
    normalView,
    positionViewDirection,
    mix,
    clamp,
    max,
    normalize,
    mx_fractal_noise_float,
  } = TSL;

  const uTime = uniform(0);
  const uEnergy = uniform(0);
  const uLow = uniform(0);
  const uListen = uniform(initialMode === "listening" ? 1 : 0);
  const uRespond = uniform(initialMode === "responding" ? 1 : 0);
  const uAspect = uniform(width / Math.max(1, height));
  const uAccent = uniform(new THREE.Color(1, 0.34, 0));

  // --- volumetric cloud field (iq XslGRr, ported to TSL) ---------------------
  const fbm = Fn(([p]: [ReturnType<typeof vec3>]) =>
    mx_fractal_noise_float(p, 5, 2.02, 0.5).mul(0.5).add(0.5),
  );

  // Cloud density at a world point: noise carved into a soft horizontal slab so
  // clouds form a layer with a flat-ish base and billowing top, drifting on wind.
  const densityAt = Fn(([p]: [ReturnType<typeof vec3>]) => {
    const wind = vec3(uTime.mul(0.22), uTime.mul(-0.015), uTime.mul(0.06));
    const n = fbm(p.mul(0.62).add(wind));
    const slab = float(1.0).sub(p.y.sub(3.0).abs().div(1.7)).clamp(0, 1);
    return n.mul(slab).sub(0.34).mul(1.7).clamp(0, 1);
  });

  // Raymarch the cloud field for one screen pixel and composite over the sky.
  const sunDir = normalize(vec3(0.55, 0.62, -0.55));
  const cloudColor = Fn(([scUV]: [ReturnType<typeof vec2>]) => {
    const ndc = scUV.sub(0.5).mul(2.0);
    const rd = normalize(
      vec3(
        ndc.x.mul(uAspect).mul(0.62),
        ndc.y.mul(0.62).add(0.12),
        float(-1.0),
      ),
    );
    const ro = vec3(uTime.mul(0.08), 1.25, 6.0);

    const horizon = clamp(scUV.y.sub(0.18).mul(1.4), 0, 1);
    const sky = mix(
      vec3(0.74, 0.86, 1.0),
      vec3(0.2, 0.45, 0.86),
      horizon.pow(0.7),
    );

    const sum = vec4(0.0).toVar();
    const t = float(1.2).toVar();
    Loop(46, () => {
      If(sum.w.greaterThan(0.985), () => {
        Break();
      });
      const pos = ro.add(rd.mul(t));
      const den = densityAt(pos);
      If(den.greaterThan(0.01), () => {
        const lit = clamp(
          den.sub(densityAt(pos.add(sunDir.mul(0.45)))).mul(2.6),
          0,
          1,
        );
        const base = mix(
          vec3(0.42, 0.5, 0.62),
          vec3(1.0, 1.0, 1.0),
          den.oneMinus(),
        );
        const sun = vec3(1.0, 0.92, 0.78).mul(lit.mul(1.15));
        const rgb = base.add(sun);
        const a = den.mul(0.46);
        sum.addAssign(vec4(rgb.mul(a), a).mul(sum.w.oneMinus()));
      });
      t.addAssign(max(0.12, t.mul(0.025)));
    });

    return vec3(sky.mul(sum.w.oneMinus()).add(sum.xyz));
  });

  const bgGeo = new THREE.PlaneGeometry(120, 120);
  const bgMat = new THREE.MeshBasicNodeMaterial();
  bgMat.colorNode = cloudColor(screenUV);
  const backdrop = new THREE.Mesh(bgGeo, bgMat);
  backdrop.position.set(0, 0, -10);

  // --- glass: prismatic transmissive sphere with chromatic dispersion --------
  const sphereGeo = new THREE.SphereGeometry(1, 128, 128);
  const glassMat = new THREE.MeshPhysicalNodeMaterial();
  glassMat.transmission = 1;
  glassMat.ior = 1.45;
  glassMat.thickness = 1.6;
  glassMat.roughness = 0.0;
  glassMat.metalness = 0;
  glassMat.dispersion = 9;
  glassMat.clearcoat = 1;
  glassMat.clearcoatRoughness = 0.04;
  glassMat.envMapIntensity = 1.0;
  glassMat.color = new THREE.Color(1, 1, 1);

  const drift = vec3(0, uTime.mul(0.2), uTime.mul(0.06));
  const ripple = mx_fractal_noise_float(
    positionLocal.mul(2.2).add(drift),
    3,
    2.0,
    0.5,
  );
  const amp = float(0.01)
    .add(uEnergy.mul(0.05))
    .add(uLow.mul(0.03))
    .add(uListen.mul(0.018))
    .add(uRespond.mul(0.03));
  glassMat.positionNode = positionLocal.add(normalLocal.mul(ripple.mul(amp)));
  const glass = new THREE.Mesh(sphereGeo, glassMat);

  // --- rim glow: back-faced fresnel shell bleeding the accent past the
  // silhouette. Near-invisible at idle, flares with energy + responding.
  const glowGeo = new THREE.SphereGeometry(1.06, 48, 48);
  const glowMat = new THREE.MeshBasicNodeMaterial();
  glowMat.transparent = true;
  glowMat.depthWrite = false;
  glowMat.side = THREE.BackSide;
  const haloFresnel = normalView
    .dot(positionViewDirection)
    .abs()
    .oneMinus()
    .pow(2.2);
  glowMat.colorNode = uAccent;
  glowMat.opacityNode = haloFresnel.mul(
    float(0.04)
      .add(uEnergy.mul(0.3))
      .add(uRespond.mul(0.16))
      .add(uListen.mul(0.08)),
  );
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.renderOrder = 2;

  // Orb + glow live in a group so a single scale tracks the target pixel size.
  const orbGroup = new THREE.Group();
  orbGroup.add(glass);
  orbGroup.add(glow);

  const scene = new THREE.Scene();
  const env = makeEnvTexture(THREE);
  scene.environment = env.texture;
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

  const renderer = new THREE.WebGPURenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));

  // Scale the orb so its projected diameter is a stable target size in px.
  function applyOrbScale(h: number) {
    const targetPx = Math.min(Math.max(h * 0.46, 180), 360);
    const radiusWorld = (targetPx * worldPerPixel(h)) / 2;
    orbGroup.scale.setScalar(radiusWorld);
  }
  renderer.setSize(width, height, false);
  applyOrbScale(height);
  await renderer.init();

  let mode = initialMode;
  let t = 0;
  let energy = 0;
  let low = 0;
  renderer.setAnimationLoop(() => {
    t += 0.016;
    const s = summarizeLevels(sampleFrequencyLevels(analyser, 32));
    energy += (s.energy - energy) * 0.16;
    low += (s.low - low) * 0.2;
    uTime.value = t;
    uEnergy.value = energy;
    uLow.value = low;
    const spin = 0.16 + (mode === "responding" ? 0.18 : 0);
    glass.rotation.y = t * spin;
    glass.rotation.x = Math.sin(t * 0.1) * 0.12;
    const pull = mode === "listening" ? -0.04 : 0;
    // orbGroup carries the target pixel size; the glass breathes within it.
    glass.scale.setScalar(1 + energy * 0.05 + pull);
    renderer.render(scene, camera);
  });

  return {
    setMode(next) {
      mode = next;
      uListen.value = next === "listening" ? 1 : 0;
      uRespond.value = next === "responding" ? 1 : 0;
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      uAspect.value = w / Math.max(1, h);
      applyOrbScale(h);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      bgGeo.dispose();
      bgMat.dispose();
      sphereGeo.dispose();
      glassMat.dispose();
      glowGeo.dispose();
      glowMat.dispose();
      env.texture.dispose();
      renderer.dispose();
    },
  };
}

const MODES: VoiceWaveformMode[] = ["idle", "listening", "responding"];

function FullBleedStage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<GlassHandle | null>(null);
  const [mode, setMode] = useState<VoiceWaveformMode>("responding");

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const analyser = makeOscillatingAnalyser();
    let disposed = false;
    const rect = wrap.getBoundingClientRect();
    void mountGlass(
      canvas,
      Math.round(rect.width),
      Math.round(rect.height),
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
    handleRef.current?.setMode(mode);
  }, [mode]);

  return (
    <div
      ref={wrapRef}
      style={{ position: "fixed", inset: 0, background: "#07080b" }}
    >
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
          gap: 8,
          padding: 6,
          borderRadius: 12,
          background: "rgba(10,10,14,0.5)",
          backdropFilter: "blur(8px)",
        }}
      >
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{
              background:
                m === mode ? "var(--accent-primary, #ff5800)" : "transparent",
              border: "1px solid rgba(255,255,255,0.22)",
              borderRadius: 8,
              color: m === mode ? "#fff" : "rgba(255,255,255,0.85)",
              cursor: "pointer",
              fontFamily: "Poppins, system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 13,
              letterSpacing: "0.03em",
              padding: "8px 18px",
            }}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element missing");
}
// Reuse a single root across HMR re-evaluations. Without this, every hot update
// re-runs this module and calls createRoot again on the same container, mounting
// duplicate React trees that each spin up a WebGPURenderer on the same canvas —
// the renderers collide and the orb goes black.
const rootHost = window as unknown as {
  __glassRoot?: ReturnType<typeof createRoot>;
};
const root = rootHost.__glassRoot ?? createRoot(container);
rootHost.__glassRoot = root;
root.render(
  <StrictMode>
    <FullBleedStage />
  </StrictMode>,
);
