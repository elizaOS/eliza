import { CLOUD_BACKGROUND_ASSETS } from "@elizaos/shared/brand";
import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Visual mode for the voice avatar.
 *
 * - `idle`: no mic, no TTS. The glass orb drifts and breathes on its own.
 * - `listening`: mic is open. The orb tightens inward and the rim glow lifts.
 * - `responding`: the agent is speaking. The orb spins faster and the rim glow
 *   flares, driven by playback amplitude when an analyser is supplied.
 */
export type VoiceWaveformMode = "idle" | "listening" | "responding";

/** Minimal analyser surface — lets tests supply a fake without a DOM audio graph. */
export type FrequencyAnalyser = Pick<
  AnalyserNode,
  "frequencyBinCount" | "getByteFrequencyData"
>;

export interface VoiceWaveformProps {
  mode: VoiceWaveformMode;
  /**
   * Optional Web Audio analyser to read amplitude from. When provided it drives
   * the orb from the active capture / playback node. The avatar never mutates or
   * disconnects the node — it only reads.
   */
  analyser?: FrequencyAnalyser | null;
  /**
   * Open a private microphone analyser when listening and no analyser is
   * supplied. Defaults to false so shells that already own voice capture do not
   * create a second getUserMedia session just for visualization.
   */
  captureMic?: boolean;
  className?: string;
  /** Accessible label. Default "Voice activity". */
  ariaLabel?: string;
}

/** Frequency buckets sampled from the analyser before summarizing into bands. */
const BANDS = 32;

/**
 * Average `analyser` frequency data into `count` normalized [0,1] buckets.
 * Pure and DOM-free so it can be exercised with a fake analyser in tests.
 */
export function sampleFrequencyLevels(
  analyser: FrequencyAnalyser | null | undefined,
  count: number,
): Float32Array {
  const out = new Float32Array(count);
  if (!analyser || count <= 0) return out;
  const bins = analyser.frequencyBinCount;
  if (bins <= 0) return out;
  const buf = new Uint8Array(bins);
  analyser.getByteFrequencyData(buf);
  const step = Math.max(1, Math.floor(bins / count));
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    for (let j = 0; j < step; j += 1) {
      sum += buf[i * step + j] ?? 0;
    }
    out[i] = sum / step / 255;
  }
  return out;
}

export interface LevelSummary {
  /** Mean amplitude across the whole spectrum, [0,1]. */
  energy: number;
  /** Mean amplitude of the low third (bass), [0,1]. */
  low: number;
  /** Mean amplitude of the middle third (mids), [0,1]. */
  mid: number;
  /** Mean amplitude of the upper third (treble), [0,1]. */
  high: number;
}

/**
 * Collapse per-bucket frequency levels into an overall energy plus low/mid/high
 * band averages. Pure so the shader-driving math stays unit-testable.
 */
export function summarizeLevels(levels: Float32Array): LevelSummary {
  const n = levels.length;
  if (n === 0) return { energy: 0, low: 0, mid: 0, high: 0 };
  const third = Math.max(1, Math.floor(n / 3));
  let total = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  for (let i = 0; i < n; i += 1) {
    const v = levels[i] ?? 0;
    total += v;
    if (i < third) low += v;
    else if (i < third * 2) mid += v;
    else high += v;
  }
  const highCount = Math.max(1, n - third * 2);
  return {
    energy: total / n,
    low: low / third,
    mid: mid / third,
    high: high / highCount,
  };
}

/** Brand orange fallback as an [r, g, b] triple (matches --accent-rgb). */
const FALLBACK_ACCENT: readonly [number, number, number] = [255, 88, 0];

/**
 * Resolve the `--accent-rgb` custom property to a concrete [r, g, b] triple so
 * the surface accent can be fed into the shader as a color uniform. Falls back
 * to brand orange when the property is undefined, empty, or malformed.
 */
function resolveAccentRgb(): [number, number, number] {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return [...FALLBACK_ACCENT];
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent-rgb")
    .trim();
  const channels = raw.split(",").map((part) => Number(part.trim()));
  if (
    channels.length !== 3 ||
    channels.some((c) => !Number.isFinite(c) || c < 0 || c > 255)
  ) {
    return [...FALLBACK_ACCENT];
  }
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
}

function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * True when a GPU backend the WebGPURenderer can use is plausibly available.
 * Probes on a throwaway canvas so the real canvas is left untouched, and keeps
 * jsdom / headless environments from importing the multi-megabyte WebGPU build.
 */
function gpuAvailable(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  if (typeof navigator !== "undefined" && "gpu" in navigator) return true;
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

type MicAnalyser = {
  analyser: AnalyserNode;
  stop: () => void;
};

async function openMicAnalyser(): Promise<MicAnalyser | null> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function"
  ) {
    return null;
  }
  const AudioCtor: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext);
  if (!AudioCtor) return null;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = new AudioCtor();
  if (context.state === "suspended") {
    await context.resume().catch(() => {});
  }
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);

  const stop = () => {
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };

  return { analyser, stop };
}

type WebGPUModule = typeof import("three/webgpu");
type TSLModule = typeof import("three/tsl");

// Camera framing. The orb sits at the origin; these constants let the orb be
// scaled to a stable on-screen pixel diameter regardless of viewport size.
const CAMERA_Z = 4.6;
const FOV_DEG = 35;
const HALF_FOV_TAN = Math.tan(((FOV_DEG / 2) * Math.PI) / 180);

/** World units per screen pixel at the orb's focal plane (z=0). */
function worldPerPixel(heightPx: number): number {
  return (2 * CAMERA_Z * HALF_FOV_TAN) / Math.max(1, heightPx);
}

/**
 * Studio-gradient equirectangular environment (bright sky → dark ground with a
 * warm bloom) so the glass has a reflective rim and surface sheen. Without an
 * environment the glass reads as matte jelly rather than a refractive orb.
 */
function makeStudioEnv(
  THREE: WebGPUModule,
): InstanceType<WebGPUModule["Texture"]> {
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

/** Per-frame state pushed into the shader uniforms. All amplitudes are [0,1]. */
interface OrbFrame {
  time: number;
  energy: number;
  low: number;
  /** Smoothed 0→1 weight for listening mode. */
  listen: number;
  /** Smoothed 0→1 weight for responding mode. */
  respond: number;
}

interface OrbHandle {
  setAccent: (r: number, g: number, b: number) => void;
  renderFrame: (frame: OrbFrame) => void;
  resize: (width: number, height: number) => void;
  setAnimationLoop: (cb: (() => void) | null) => void;
  dispose: () => void;
}

/**
 * Build the WebGPU scene: a full-bleed volumetric cloudscape with a prismatic
 * glass orb that refracts it.
 *
 * The clouds are a TSL port of the raymarched-fbm approach from iq's "Clouds"
 * (ShaderToy XslGRr): a drifting multi-octave noise field carved into a soft
 * horizontal slab, sampled along a virtual view ray, lit by a single sun via the
 * density gradient, composited front-to-back over a sky gradient. They are drawn
 * on a screen-space backdrop plane in the opaque pass, so the transmissive
 * sphere in front refracts them natively — one cloud evaluation per frame, no
 * second canvas, no alignment seam. The orb is scaled to a target pixel diameter
 * so it stays a consistent size across viewports.
 */
async function mountOrb(
  THREE: WebGPUModule,
  TSL: TSLModule,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): Promise<OrbHandle> {
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
  const uListen = uniform(0);
  const uRespond = uniform(0);
  const uAspect = uniform(width / Math.max(1, height));
  const uAccent = uniform(new THREE.Color(1, 0.34, 0));

  // --- volumetric cloud field (iq XslGRr, ported to TSL) ---------------------
  // `normalLocal` is typed as the base `Node<"vec3">`; reuse that as the vec3
  // node type so the density sampler accepts plain vec3 expressions (the result
  // of `.add()`/`.mul()`) without tripping TSL's proxied-argument narrowing.
  type Vec3Node = typeof normalLocal;

  // Cloud density at a world point: drifting multi-octave noise carved into a
  // soft horizontal slab so clouds form a layer with a flat-ish base and a
  // billowing top. Returns a scalar density node in [0,1].
  const densityAt = (p: Vec3Node) => {
    const wind = vec3(uTime.mul(0.22), uTime.mul(-0.015), uTime.mul(0.06));
    const noise = mx_fractal_noise_float(p.mul(0.62).add(wind), 5, 2.02, 0.5)
      .mul(0.5)
      .add(0.5);
    const slab = float(1.0).sub(p.y.sub(3.0).abs().div(1.7)).clamp(0, 1);
    return noise.mul(slab).sub(0.34).mul(1.7).clamp(0, 1);
  };

  // Raymarch the cloud field across the screen and composite front-to-back over
  // a sky gradient. Zero-arg so it closes over `screenUV` and the uniforms.
  const sunDir = normalize(vec3(0.55, 0.62, -0.55));
  const cloudColor = Fn(() => {
    const ndc = screenUV.sub(0.5).mul(2.0);
    const rd = normalize(
      vec3(
        ndc.x.mul(uAspect).mul(0.62),
        ndc.y.mul(0.62).add(0.12),
        float(-1.0),
      ),
    );
    const ro = vec3(uTime.mul(0.08), 1.25, 6.0);

    const horizon = clamp(screenUV.y.sub(0.18).mul(1.4), 0, 1);
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
  bgMat.colorNode = cloudColor();
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

  // Orb + glow share a group so a single scale tracks the target pixel size.
  const orbGroup = new THREE.Group();
  orbGroup.add(glass);
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

  const renderer = new THREE.WebGPURenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setClearColor(0x000000, 0);
  // Cap the backing-store resolution below the CSS size on dense displays: the
  // soft cloudscape upscales cleanly and the per-pixel raymarch is the dominant
  // cost, so this is the cheapest lever for a full-bleed background.
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

  return {
    setAccent(r, g, b) {
      uAccent.value.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
      accentLight.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    },
    renderFrame(frame) {
      uTime.value = frame.time;
      uEnergy.value = frame.energy;
      uLow.value = frame.low;
      uListen.value = frame.listen;
      uRespond.value = frame.respond;
      const spin = 0.16 + frame.respond * 0.18;
      glass.rotation.y = frame.time * spin;
      glass.rotation.x = Math.sin(frame.time * 0.1) * 0.12;
      // The orbGroup carries the target pixel size; the glass breathes within it
      // — pulled slightly tighter while listening, swelling with energy.
      glass.scale.setScalar(1 + frame.energy * 0.05 - frame.listen * 0.04);
      renderer.render(scene, camera);
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      uAspect.value = w / Math.max(1, h);
      applyOrbScale(h);
    },
    setAnimationLoop(cb) {
      renderer.setAnimationLoop(cb);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      bgGeo.dispose();
      bgMat.dispose();
      sphereGeo.dispose();
      glassMat.dispose();
      glowGeo.dispose();
      glowMat.dispose();
      envTexture.dispose();
      renderer.dispose();
    },
  };
}

/**
 * Voice-reactive avatar — a full-bleed WebGPU cloudscape with a prismatic glass
 * orb refracting it. Reads amplitude from the supplied analyser (TTS in
 * `responding`, mic in `listening`), or opens a private mic when `captureMic` is
 * set. Fills its parent and tracks its size with a ResizeObserver. Honors
 * `prefers-reduced-motion` by painting a single static frame, and falls back to
 * the cloud poster image where no GPU is available — the poster sits behind the
 * canvas and shows through until (or unless) the live clouds paint over it.
 */
export function VoiceWaveform({
  mode,
  analyser,
  captureMic = false,
  className,
  ariaLabel = "Voice activity",
}: VoiceWaveformProps): React.JSX.Element {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const modeRef = React.useRef<VoiceWaveformMode>(mode);
  modeRef.current = mode;
  const externalAnalyserRef = React.useRef<FrequencyAnalyser | null>(
    analyser ?? null,
  );
  externalAnalyserRef.current = analyser ?? null;
  const micRef = React.useRef<MicAnalyser | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (mode === "listening" && captureMic && !externalAnalyserRef.current) {
      void openMicAnalyser().then((handle) => {
        if (cancelled || !handle) {
          handle?.stop();
          return;
        }
        micRef.current = handle;
      });
    }
    return () => {
      cancelled = true;
      micRef.current?.stop();
      micRef.current = null;
    };
  }, [captureMic, mode]);

  React.useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas || !gpuAvailable()) return undefined;

    let disposed = false;
    let mounting = false;
    let handle: OrbHandle | null = null;
    const reduced = prefersReducedMotion();

    function activeAnalyser(): FrequencyAnalyser | null {
      const phase = modeRef.current;
      if (phase === "responding") return externalAnalyserRef.current;
      if (phase === "listening") {
        return externalAnalyserRef.current ?? micRef.current?.analyser ?? null;
      }
      return null;
    }

    async function mount(width: number, height: number): Promise<void> {
      try {
        const [three, tsl] = await Promise.all([
          import("three/webgpu"),
          import("three/tsl"),
        ]);
        if (disposed || !canvas) return;
        const orb = await mountOrb(three, tsl, canvas, width, height);
        if (disposed) {
          orb.dispose();
          return;
        }
        handle = orb;
        orb.setAccent(...resolveAccentRgb());

        if (reduced) {
          orb.renderFrame({
            time: 0,
            energy: 0,
            low: 0,
            listen: modeRef.current === "listening" ? 1 : 0,
            respond: modeRef.current === "responding" ? 1 : 0,
          });
          return;
        }

        let t = 0;
        let frame = 0;
        let energy = 0;
        let low = 0;
        let listen = 0;
        let respond = 0;
        orb.setAnimationLoop(() => {
          t += 0.016;
          frame += 1;
          const summary = summarizeLevels(
            sampleFrequencyLevels(activeAnalyser(), BANDS),
          );
          energy += (summary.energy - energy) * 0.16;
          low += (summary.low - low) * 0.2;
          listen += ((modeRef.current === "listening" ? 1 : 0) - listen) * 0.08;
          respond +=
            ((modeRef.current === "responding" ? 1 : 0) - respond) * 0.08;
          if (frame % 30 === 0) orb.setAccent(...resolveAccentRgb());
          orb.renderFrame({ time: t, energy, low, listen, respond });
        });
      } catch {
        handle?.dispose();
        handle = null;
      }
    }

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w <= 0 || h <= 0) return;
      if (handle) {
        handle.resize(w, h);
      } else if (!mounting) {
        mounting = true;
        void mount(w, h);
      }
    });
    observer.observe(wrap);

    return () => {
      disposed = true;
      observer.disconnect();
      handle?.dispose();
      handle = null;
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className={cn("pointer-events-none select-none", className)}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <img
        src={CLOUD_BACKGROUND_ASSETS.poster}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={ariaLabel}
        data-testid="voice-waveform"
        data-mode={mode}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
}
