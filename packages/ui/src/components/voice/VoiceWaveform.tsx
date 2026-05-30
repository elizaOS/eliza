import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Visual mode for the voice avatar.
 *
 * - `idle`: no mic, no TTS. The orb breathes and drifts on its own.
 * - `listening`: mic is open. The swarm pulls inward and jitters with mic input.
 * - `responding`: the agent is speaking. The orb flares and the swarm bursts
 *   outward in waves, driven by playback amplitude when an analyser is supplied.
 */
export type VoiceWaveformMode = "idle" | "listening" | "responding";

/**
 * Aesthetic treatment of the orb. All variants share geometry, displacement, and
 * the particle swarm — only the color/material nodes differ:
 * - `lumen`  white-hot core, accent only as a thin rim corona.
 * - `nimbus` amorphous: white core dissolving to a transparent silhouette.
 * - `halo`   smooth view-shaded liquid white with an accent fresnel edge.
 * - `ember`  white body with sparse accent veins where the noise peaks.
 */
export type OrbStyle = "lumen" | "nimbus" | "halo" | "ember";

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
  /** Diameter / square size in px. Default 220. */
  size?: number;
  className?: string;
  /** Accessible label. Default "Voice activity". */
  ariaLabel?: string;
  /** Orb color treatment. Default "lumen". */
  styleVariant?: OrbStyle;
}

const DEFAULT_SIZE = 220;
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

/** Per-frame state pushed into the shader uniforms. All amplitudes are [0,1]. */
interface OrbFrame {
  time: number;
  energy: number;
  low: number;
  mid: number;
  high: number;
  /** Smoothed 0→1 weight for listening mode. */
  listen: number;
  /** Smoothed 0→1 weight for responding mode. */
  respond: number;
}

interface OrbHandle {
  setAccent: (r: number, g: number, b: number) => void;
  renderFrame: (frame: OrbFrame) => void;
  setAnimationLoop: (cb: (() => void) | null) => void;
  dispose: () => void;
}

/**
 * Build the WebGPU scene: a displaced, iridescent plasma core wrapped in a
 * fresnel glow halo and an audio-reactive particle swarm. All deformation,
 * color, and motion is expressed in TSL node graphs driven by uniforms, so the
 * per-frame cost is a handful of uniform writes. Returns null only if the
 * renderer fails to initialize.
 */
async function mountOrb(
  THREE: WebGPUModule,
  TSL: TSLModule,
  canvas: HTMLCanvasElement,
  size: number,
  style: OrbStyle,
): Promise<OrbHandle> {
  const {
    uniform,
    vec3,
    float,
    positionLocal,
    normalLocal,
    normalView,
    positionViewDirection,
    mix,
    mx_fractal_noise_float,
    mx_noise_float,
    attribute,
  } = TSL;

  const uTime = uniform(0);
  const uEnergy = uniform(0);
  const uLow = uniform(0);
  const uMid = uniform(0);
  const uHigh = uniform(0);
  const uListen = uniform(0);
  const uRespond = uniform(0);
  const uAccent = uniform(new THREE.Color(1, 0.34, 0));

  // --- core orb: icosphere displaced along its normals by domain-warped noise.
  const orbGeo = new THREE.IcosahedronGeometry(1, 24);
  const orbMat = new THREE.MeshBasicNodeMaterial();

  const drift = vec3(0, uTime.mul(0.18), uTime.mul(0.05));
  const noiseCoord = positionLocal.mul(1.5).add(drift);
  const warp = mx_noise_float(noiseCoord.mul(0.7).add(uTime.mul(0.12)));
  const turbulence = mx_fractal_noise_float(
    noiseCoord.add(warp.mul(0.55)),
    4,
    2.0,
    0.55,
  );
  const turb01 = turbulence.mul(0.5).add(0.5);
  const baseAmp = float(0.09).add(uListen.mul(0.05)).add(uRespond.mul(0.06));
  const reactAmp = uEnergy.mul(0.5).add(uLow.mul(0.28));
  const displacement = turb01.mul(baseAmp.add(reactAmp));
  orbMat.positionNode = positionLocal.add(normalLocal.mul(displacement));

  // Fresnel: 0 at the lit center, 1 at the grazing silhouette.
  const fresnel = normalView.dot(positionViewDirection).clamp(0, 1).oneMinus();
  const fresnelTight = fresnel.pow(2.2);
  const innerBands = mx_fractal_noise_float(
    positionLocal.mul(2.4).add(uTime.mul(0.3)),
    3,
    2.0,
    0.5,
  )
    .mul(0.5)
    .add(0.5);
  // The orb reads as a body of white light; the accent lives at the rim/halo,
  // never as the core fill. Each variant modulates luminance, not hue.
  const energyLift = float(1).add(uEnergy.mul(0.6));
  if (style === "nimbus") {
    // Amorphous: white body that dissolves to a transparent silhouette, so it
    // has no hard edge — a soft ball of light rather than a shaded sphere.
    const body = mix(vec3(0.66, 0.68, 0.76), vec3(1, 1, 1), innerBands);
    orbMat.colorNode = mix(body, uAccent, fresnelTight.mul(0.3)).mul(energyLift);
    orbMat.transparent = true;
    orbMat.depthWrite = false;
    orbMat.opacityNode = fresnel
      .oneMinus()
      .pow(1.4)
      .mul(float(0.82).add(uEnergy.mul(0.18)));
  } else if (style === "halo") {
    // Smooth liquid white: brightness from the view-facing term, accent edge.
    const sheen = mix(vec3(0.5, 0.52, 0.6), vec3(1, 1, 1), fresnel.oneMinus().pow(0.7));
    orbMat.colorNode = mix(sheen, uAccent, fresnelTight.mul(0.6)).mul(energyLift);
  } else if (style === "ember") {
    // White body with sparse accent veins where the surface noise peaks.
    const veins = innerBands.smoothstep(0.6, 0.9);
    const body = mix(vec3(0.74, 0.75, 0.82), vec3(1, 1, 1), innerBands.pow(1.4));
    const veined = mix(body, uAccent.mul(1.25), veins.mul(0.85));
    orbMat.colorNode = mix(veined, uAccent, fresnelTight.mul(0.45)).mul(energyLift);
  } else {
    // lumen: white-hot core with a faint cool-white churn, accent only as a
    // thin warm corona at the grazing rim.
    const warmWhite = mix(vec3(0.6, 0.61, 0.66), vec3(1, 1, 1), innerBands.pow(0.8));
    orbMat.colorNode = mix(warmWhite, uAccent, fresnelTight.mul(0.75)).mul(energyLift);
  }

  // --- glow halo: a larger back-faced sphere whose fresnel-weighted accent
  // bleeds past the orb silhouette, reading as bloom over the bright sky.
  const glowGeo = new THREE.IcosahedronGeometry(1.34, 12);
  const glowMat = new THREE.MeshBasicNodeMaterial();
  glowMat.transparent = true;
  glowMat.depthWrite = false;
  glowMat.side = THREE.BackSide;
  const haloFresnel = normalView
    .dot(positionViewDirection)
    .abs()
    .oneMinus()
    .pow(2.0);
  if (style === "halo") {
    glowMat.colorNode = uAccent;
    glowMat.opacityNode = haloFresnel.mul(float(0.26).add(uEnergy.mul(0.45)));
  } else if (style === "nimbus") {
    glowMat.colorNode = mix(uAccent, vec3(1, 1, 1), haloFresnel.mul(0.35));
    glowMat.opacityNode = haloFresnel.mul(float(0.4).add(uEnergy.mul(0.4)));
  } else {
    glowMat.colorNode = mix(uAccent, vec3(1, 1, 1), haloFresnel.mul(0.15));
    glowMat.opacityNode = haloFresnel.mul(
      float(0.3).add(uEnergy.mul(0.5)).add(uRespond.mul(0.16)),
    );
  }

  // --- particle swarm: points on a fibonacci sphere, displaced radially by
  // mode + amplitude. Pull inward when listening, burst outward when responding.
  const COUNT = 24000;
  const positions = new Float32Array(COUNT * 3);
  const seeds = new Float32Array(COUNT);
  const golden = Math.PI * (1 + Math.sqrt(5));
  for (let i = 0; i < COUNT; i += 1) {
    const k = i + 0.5;
    const phi = Math.acos(1 - (2 * k) / COUNT);
    const theta = golden * k;
    const sinPhi = Math.sin(phi);
    positions[i * 3] = Math.cos(theta) * sinPhi * 1.12;
    positions[i * 3 + 1] = Math.sin(theta) * sinPhi * 1.12;
    positions[i * 3 + 2] = Math.cos(phi) * 1.12;
    seeds[i] = Math.random();
  }
  const ptsGeo = new THREE.BufferGeometry();
  ptsGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  ptsGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  const ptsMat = new THREE.PointsNodeMaterial();
  ptsMat.transparent = true;
  ptsMat.depthWrite = false;

  const seed = attribute<"float">("aSeed", "float");
  const radial = positionLocal.normalize();
  const pNoise = mx_noise_float(positionLocal.mul(1.8).add(uTime.mul(0.25)));
  const breathe = uTime.add(seed.mul(6.283)).sin().mul(0.035);
  const pull = uListen.mul(0.22).mul(pNoise.mul(0.5).add(0.5));
  const burst = uTime.mul(3.0).add(seed.mul(6.283)).sin().mul(0.5).add(0.5);
  const push = uRespond.mul(0.5).mul(burst).add(uHigh.mul(0.3));
  const jitter = pNoise.mul(uLow.mul(0.28));
  const pRadius = float(1.18)
    .add(breathe)
    .sub(pull)
    .add(push)
    .add(jitter)
    .add(uEnergy.mul(0.12));
  ptsMat.positionNode = radial.mul(pRadius);
  // Kept small so each point reads as a soft dot at retina DPR without a
  // per-fragment sprite mask (point sprite UVs are under-typed upstream).
  ptsMat.sizeNode = float(size * 0.013)
    .mul(seed.mul(0.7).add(0.5))
    .mul(float(1).add(uEnergy.mul(1.1)));
  ptsMat.opacityNode = float(0.62)
    .add(uEnergy.mul(0.38))
    .mul(seed.mul(0.45).add(0.55));
  if (style === "ember") {
    ptsMat.colorNode = mix(
      uAccent,
      vec3(1, 1, 1),
      seed.mul(0.5).add(uHigh.mul(0.4)).clamp(0, 1),
    );
  } else {
    // White-dominant motes; only a faint minority pick up the accent.
    ptsMat.colorNode = mix(
      uAccent,
      vec3(1, 1, 1),
      seed.mul(0.4).add(0.55).add(uHigh.mul(0.3)).clamp(0, 1),
    );
  }

  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const ptsGroup = new THREE.Group();
  const orb = new THREE.Mesh(orbGeo, orbMat);
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.renderOrder = 1;
  const points = new THREE.Points(ptsGeo, ptsMat);
  points.renderOrder = 2;
  ptsGroup.add(points);
  group.add(orb);
  group.add(glow);
  group.add(ptsGroup);
  scene.add(group);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0, 4.6);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGPURenderer({ canvas, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size, false);
  await renderer.init();

  return {
    setAccent(r, g, b) {
      uAccent.value.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    },
    renderFrame(frame) {
      uTime.value = frame.time;
      uEnergy.value = frame.energy;
      uLow.value = frame.low;
      uMid.value = frame.mid;
      uHigh.value = frame.high;
      uListen.value = frame.listen;
      uRespond.value = frame.respond;
      group.rotation.y = frame.time * 0.12;
      group.rotation.x = Math.sin(frame.time * 0.08) * 0.16;
      ptsGroup.rotation.y = -frame.time * (0.22 + frame.respond * 0.5);
      ptsGroup.rotation.z = frame.time * 0.05;
      renderer.render(scene, camera);
    },
    setAnimationLoop(cb) {
      renderer.setAnimationLoop(cb);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      orbGeo.dispose();
      orbMat.dispose();
      glowGeo.dispose();
      glowMat.dispose();
      ptsGeo.dispose();
      ptsMat.dispose();
      renderer.dispose();
    },
  };
}

/**
 * Voice-reactive avatar — a WebGPU/three.js orb: a displaced iridescent plasma
 * core inside a fresnel glow halo and a particle swarm, all morphing with live
 * audio. Reads amplitude from the supplied analyser (TTS in `responding`, mic in
 * `listening`), or opens a private mic when `captureMic` is set. Honors
 * `prefers-reduced-motion` and degrades to nothing where no GPU is available, so
 * the canvas simply stays transparent over the background.
 */
export function VoiceWaveform({
  mode,
  analyser,
  captureMic = false,
  size = DEFAULT_SIZE,
  className,
  ariaLabel = "Voice activity",
  styleVariant = "lumen",
}: VoiceWaveformProps): React.JSX.Element {
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
    const canvas = canvasRef.current;
    if (!canvas || !gpuAvailable()) return undefined;

    let disposed = false;
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

    void (async () => {
      try {
        const [three, tsl] = await Promise.all([
          import("three/webgpu"),
          import("three/tsl"),
        ]);
        if (disposed) return;
        const orb = await mountOrb(three, tsl, canvas, size, styleVariant);
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
            mid: 0,
            high: 0,
            listen: modeRef.current === "listening" ? 1 : 0,
            respond: modeRef.current === "responding" ? 1 : 0,
          });
          return;
        }

        let t = 0;
        let frame = 0;
        let energy = 0;
        let low = 0;
        let mid = 0;
        let high = 0;
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
          mid += (summary.mid - mid) * 0.2;
          high += (summary.high - high) * 0.26;
          listen += ((modeRef.current === "listening" ? 1 : 0) - listen) * 0.08;
          respond +=
            ((modeRef.current === "responding" ? 1 : 0) - respond) * 0.08;
          if (frame % 30 === 0) orb.setAccent(...resolveAccentRgb());
          orb.renderFrame({ time: t, energy, low, mid, high, listen, respond });
        });
      } catch {
        handle?.dispose();
        handle = null;
      }
    })();

    return () => {
      disposed = true;
      handle?.dispose();
      handle = null;
    };
  }, [size, styleVariant]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={ariaLabel}
      data-testid="voice-waveform"
      data-mode={mode}
      style={{ width: size, height: size }}
      className={cn("pointer-events-none select-none", className)}
    />
  );
}
