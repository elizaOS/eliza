import { StrictMode, useEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import "@ui-src/styles.ts";
import {
  type FrequencyAnalyser,
  sampleFrequencyLevels,
  summarizeLevels,
} from "@ui-src/components/voice/VoiceWaveform.tsx";
import { makeOscillatingAnalyser } from "./stories/voice.tsx";
import "./stories.css";

// Home accent so the prototype is judged under the real surface accent.
document.documentElement.style.setProperty("--accent-rgb", "255, 88, 0");

/**
 * One glass material direction. The geometry, backdrop, lights, and audio
 * ripple are identical across treatments — only the physical glass params
 * (roughness / index of refraction / dispersion / thickness) differ, so the
 * comparison isolates the look of the glass itself.
 */
interface GlassTreatment {
  id: string;
  title: string;
  blurb: string;
  ior: number;
  roughness: number;
  thickness: number;
  dispersion: number;
}

const TREATMENTS: GlassTreatment[] = [
  {
    id: "clear",
    title: "clear",
    blurb: "ior 1.45 · roughness 0 — sharp inverted lens",
    ior: 1.45,
    roughness: 0.0,
    thickness: 1.4,
    dispersion: 0,
  },
  {
    id: "frosted",
    title: "frosted",
    blurb: "roughness 0.34 — soft diffuse, milky body",
    ior: 1.45,
    roughness: 0.34,
    thickness: 1.7,
    dispersion: 0,
  },
  {
    id: "prismatic",
    title: "prismatic",
    blurb: "dispersion 4 — chromatic split at the rim",
    ior: 1.5,
    roughness: 0.04,
    thickness: 1.5,
    dispersion: 4,
  },
];

interface GlassHandle {
  dispose: () => void;
}

/**
 * Build a self-contained WebGPU glass scene: a procedural animated backdrop
 * plane (the stand-in for the home video, so refraction is visibly lensed)
 * with a transmissive `MeshPhysicalNodeMaterial` sphere in front of it. The
 * sphere refracts the backdrop; audio energy drives a subtle surface ripple
 * and a breathing scale. Returns a handle that owns its render loop.
 */
async function mountGlass(
  canvas: HTMLCanvasElement,
  size: number,
  treatment: GlassTreatment,
  analyser: FrequencyAnalyser,
): Promise<GlassHandle> {
  const [THREE, TSL] = await Promise.all([
    import("three/webgpu"),
    import("three/tsl"),
  ]);
  const {
    uniform,
    vec3,
    float,
    uv,
    positionLocal,
    normalLocal,
    mix,
    mx_noise_float,
    mx_fractal_noise_float,
  } = TSL;

  const uTime = uniform(0);
  const uEnergy = uniform(0);
  const uLow = uniform(0);

  // --- backdrop: a flowing warm field with bright drifting blobs. Stands in
  // for the home video; the high-contrast moving features make the refraction
  // (and, for the prismatic treatment, the chromatic split) legible.
  const bgGeo = new THREE.PlaneGeometry(10, 10);
  const bgMat = new THREE.MeshBasicNodeMaterial();
  const flow = vec3(uTime.mul(0.05), uTime.mul(0.035), uTime.mul(0.09));
  const bguv = uv();
  const coord = vec3(bguv.x, bguv.y, float(0)).mul(3.0).add(flow);
  const field = mx_fractal_noise_float(coord, 4, 2.0, 0.5).mul(0.5).add(0.5);
  const warmth = mx_noise_float(coord.mul(1.7).add(11)).mul(0.5).add(0.5);
  const blob = mx_noise_float(coord.mul(0.8).sub(flow.mul(2.0)))
    .mul(0.5)
    .add(0.5)
    .smoothstep(0.62, 0.96);
  const dark = vec3(0.02, 0.02, 0.03);
  const violet = vec3(0.16, 0.05, 0.22);
  const orange = vec3(1.0, 0.42, 0.06);
  let bg = mix(dark, violet, field);
  bg = mix(bg, orange, warmth.pow(1.5));
  bg = mix(bg, vec3(1, 1, 1), blob.mul(0.75));
  bgMat.colorNode = bg;
  const backdrop = new THREE.Mesh(bgGeo, bgMat);
  backdrop.position.set(0, 0, -3);

  // --- glass: transmissive physical sphere. Smooth, high-segment geometry so
  // the refracted backdrop stays clean. Subtle audio ripple along the normal.
  const sphereGeo = new THREE.SphereGeometry(1, 128, 128);
  const glassMat = new THREE.MeshPhysicalNodeMaterial();
  glassMat.transmission = 1;
  glassMat.ior = treatment.ior;
  glassMat.thickness = treatment.thickness;
  glassMat.roughness = treatment.roughness;
  glassMat.metalness = 0;
  glassMat.dispersion = treatment.dispersion;
  glassMat.color = new THREE.Color(1, 1, 1);

  const drift = vec3(0, uTime.mul(0.2), uTime.mul(0.06));
  const ripple = mx_fractal_noise_float(
    positionLocal.mul(2.2).add(drift),
    3,
    2.0,
    0.5,
  );
  const amp = float(0.012).add(uEnergy.mul(0.05)).add(uLow.mul(0.03));
  glassMat.positionNode = positionLocal.add(normalLocal.mul(ripple.mul(amp)));
  const glass = new THREE.Mesh(sphereGeo, glassMat);

  const scene = new THREE.Scene();
  scene.add(backdrop);
  scene.add(glass);

  // Lights give the glass its specular glints and fresnel edge; the refraction
  // itself carries the body. Key white + warm accent fill.
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(2.5, 3, 4);
  scene.add(key);
  const rim = new THREE.PointLight(0xffffff, 26, 0, 2);
  rim.position.set(-3.5, -1.5, 2.5);
  scene.add(rim);
  const accentLight = new THREE.PointLight(0xff5800, 20, 0, 2);
  accentLight.position.set(0.5, -2.5, 3);
  scene.add(accentLight);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0, 4.6);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGPURenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size, false);
  await renderer.init();

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
    glass.rotation.y = t * 0.16;
    glass.rotation.x = Math.sin(t * 0.1) * 0.12;
    glass.scale.setScalar(1 + energy * 0.05);
    renderer.render(scene, camera);
  });

  return {
    dispose() {
      renderer.setAnimationLoop(null);
      bgGeo.dispose();
      bgMat.dispose();
      sphereGeo.dispose();
      glassMat.dispose();
      renderer.dispose();
    },
  };
}

function GlassCard({
  treatment,
  analyser,
  size,
}: {
  treatment: GlassTreatment;
  analyser: FrequencyAnalyser;
  size: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let disposed = false;
    let handle: GlassHandle | null = null;
    void mountGlass(canvas, size, treatment, analyser).then((h) => {
      if (disposed) {
        h.dispose();
        return;
      }
      handle = h;
    });
    return () => {
      disposed = true;
      handle?.dispose();
      handle = null;
    };
  }, [treatment, analyser, size]);
  return (
    <figure
      style={{
        margin: 0,
        display: "grid",
        justifyItems: "center",
        gap: 10,
        padding: 18,
        background: "#0a0a0a",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
      }}
    >
      <canvas
        ref={ref}
        style={{ width: size, height: size, borderRadius: 6 }}
      />
      <figcaption
        style={{
          textAlign: "center",
          color: "rgba(255,255,255,0.82)",
          fontFamily: "Poppins, system-ui, sans-serif",
        }}
      >
        <div style={{ fontWeight: 600, letterSpacing: "0.04em" }}>
          {treatment.title}
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
          {treatment.blurb}
        </div>
      </figcaption>
    </figure>
  );
}

function Compare() {
  const analyser = useMemo(makeOscillatingAnalyser, []);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 16,
        padding: 16,
        maxWidth: 1100,
        margin: "0 auto",
      }}
    >
      {TREATMENTS.map((treatment) => (
        <GlassCard
          key={treatment.id}
          treatment={treatment}
          analyser={analyser}
          size={300}
        />
      ))}
    </div>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element missing");
}
createRoot(container).render(
  <StrictMode>
    <main className="gallery-main">
      <header className="gallery-hero">
        <h1>VoiceWaveform — glass refraction directions</h1>
        <p>
          A transmissive glass orb refracting an animated backdrop (a stand-in
          for the home video — production would feed the real{" "}
          <code>VideoTexture</code>). Three glass treatments, audio-reactive
          ripple. Pick one — the rest get removed.
        </p>
      </header>
      <Compare />
    </main>
  </StrictMode>,
);
