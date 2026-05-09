declare global {
  interface Navigator {
    readonly gpu?: unknown;
  }
}

import { resolveAppAssetUrl } from "@elizaos/ui";
import {
  MToonMaterialLoaderPlugin,
  type VRM,
  VRMLoaderPlugin,
  VRMUtils,
} from "@pixiv/three-vrm";
import * as THREE from "three";
import { MathEnvironment } from "./MathEnvironment";
import { SceneOverlayManager } from "./SceneOverlayManager";
import type {
  TeleportSparkleParticle,
  TeleportSparkleSystem,
} from "./VrmTeleportEffect";

/**
 * TSL node for MeshStandardMaterial - not in public @types/three.
 * Used for emissiveNode/opacityNode in NodeMaterial (three/tsl).
 */
interface TslMaterialNode {
  mul?(v: unknown): unknown;
  add?(v: unknown): unknown;
}

/** Three.js NodeMaterial exposes emissiveNode/opacityNode but they are not in public MeshStandardMaterial types. */
interface MeshStandardMaterialWithNodeProps {
  emissiveNode?: TslMaterialNode | null;
  opacityNode?: TslMaterialNode | null;
}

import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// biome-ignore lint/suspicious/noExplicitAny: Three.js TSL shader nodes are opaque chainable objects with no exported types.
type TslNode = any;
type VrmLoaderParser = ConstructorParameters<
  typeof MToonMaterialLoaderPlugin
>[0];

import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  type AnimationLoaderContext,
  loadEmoteClip,
  loadIdleClip,
} from "./VrmAnimationLoader";
import { VrmBlinkController } from "./VrmBlinkController";
import {
  type CameraAnimationConfig,
  type CameraProfile,
  type InteractionMode,
  VrmCameraManager,
} from "./VrmCameraManager";

export type { CameraAnimationConfig, CameraProfile, InteractionMode };

export type VrmEngineState = {
  vrmLoaded: boolean;
  vrmName: string | null;
  loadError: string | null;
  idlePlaying: boolean;
  idleTime: number;
  idleTracks: number;
  revealStarted: boolean;
  loadingProgress?: number;
};

type DebugVector3 = {
  x: number;
  y: number;
  z: number;
};

type DebugBounds = {
  min: DebugVector3;
  max: DebugVector3;
  center: DebugVector3;
  size: DebugVector3;
};

export type VrmEngineDebugInfo = {
  initialized: boolean;
  rendererBackend: RendererBackend;
  cameraProfile: CameraProfile;
  sceneChildren: string[];
  camera: {
    parentName: string | null;
    position: DebugVector3 | null;
    rotation: DebugVector3 | null;
    fov: number | null;
    lookAtTarget: DebugVector3;
  };
  avatar: {
    loaded: boolean;
    ready: boolean;
    parentName: string | null;
    position: DebugVector3 | null;
    scale: DebugVector3 | null;
    bounds: DebugBounds | null;
  };
};

type UpdateCallback = () => void;
type RendererBackend = "webgl" | "webgpu";
type RendererPreference = "auto" | "webgl";
type AnimationMixerFinishedEvent = {
  type: "finished";
  action: THREE.AnimationAction;
  direction: number;
};
type ElectrobunRuntimeWindow = Window & {
  __electrobunWindowId?: number;
  __electrobunWebviewId?: number;
};
type RendererLike = Pick<
  THREE.WebGLRenderer,
  | "dispose"
  | "domElement"
  | "render"
  | "setClearColor"
  | "setPixelRatio"
  | "setSize"
> & {
  forceContextLoss?: () => void;
  outputColorSpace?: string;
  shadowMap?: {
    enabled: boolean;
    type: THREE.ShadowMapType;
  };
  toneMapping?: THREE.ToneMapping;
  toneMappingExposure?: number;
  xr?: THREE.WebGLRenderer["xr"];
  setAnimationLoop?: (
    callback: ((time: number, frame?: unknown) => void) | null,
  ) => void;
};

const DEFAULT_CAMERA_ANIMATION: CameraAnimationConfig = {
  enabled: false,
  swayAmplitude: 0.06,
  bobAmplitude: 0.03,
  rotationAmplitude: 0.01,
  speed: 0.8,
};
const CAMERA_PROFILE_TRANSITION_DURATION_SECONDS = 0.8;
const AVATAR_SWITCH_CAMERA_TRANSITION_DURATION_SECONDS = 3;
const TELEPORT_DISSOLVE_START_Y = -1.2;
const TELEPORT_DISSOLVE_END_Y = 1.0;
const COMPANION_ZOOM_NEAR_FACTOR = 0.25;
const COMPANION_ZOOM_MIN_RADIUS = 1.2;
const MAX_RENDERER_PIXEL_RATIO = 2;
const AVATAR_RENDERER_OVERRIDE_KEY = "eliza.avatarRenderer";
const KNOWN_VRM_WEBGPU_WARNING =
  'TSL: "transformedNormalView" is deprecated. Use "normalView" instead.';

let knownVrmWebGpuWarningFilterRefs = 0;
let releaseKnownVrmWebGpuWarningFilterGlobal: (() => void) | null = null;
let sharedDracoLoader: DRACOLoader | null = null;
type CompatibleDracoLoader = Parameters<GLTFLoader["setDRACOLoader"]>[0];
type CompatibleMeshoptDecoder = Parameters<GLTFLoader["setMeshoptDecoder"]>[0];
let teleportSparkleTexture: THREE.CanvasTexture | null = null;
let _cachedDracoDecoderPath: string | null = null;
/** Lazy + cached: module-load resolution can be wrong in bundled/desktop init order. */
function getDracoDecoderPath(): string {
  _cachedDracoDecoderPath ??= resolveAppAssetUrl("vrm-decoders/draco/");
  return _cachedDracoDecoderPath;
}

function getRendererPixelRatio(): number {
  if (typeof window === "undefined") return 1;
  return Math.min(
    Math.max(window.devicePixelRatio || 1, 1),
    MAX_RENDERER_PIXEL_RATIO,
  );
}

function isElectrobunAvatarRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const runtimeWindow = window as ElectrobunRuntimeWindow;
  return (
    typeof runtimeWindow.__electrobunWindowId === "number" ||
    typeof runtimeWindow.__electrobunWebviewId === "number"
  );
}

function getPreferredAvatarRendererBackend(): RendererBackend {
  if (typeof window === "undefined") return "webgl";
  const override = (() => {
    try {
      return window.localStorage.getItem(AVATAR_RENDERER_OVERRIDE_KEY);
    } catch {
      return null;
    }
  })();
  const normalizedOverride = override?.trim().toLowerCase();
  if (normalizedOverride === "webgpu" || normalizedOverride === "webgl") {
    return normalizedOverride;
  }
  return isElectrobunAvatarRuntime() ? "webgpu" : "webgl";
}

function installKnownVrmWebGpuWarningFilter(): () => void {
  knownVrmWebGpuWarningFilterRefs += 1;

  if (!releaseKnownVrmWebGpuWarningFilterGlobal) {
    const originalWarn = console.warn.bind(console);
    console.warn = (...args: Parameters<typeof console.warn>) => {
      if (
        typeof args[0] === "string" &&
        args[0].includes(KNOWN_VRM_WEBGPU_WARNING)
      ) {
        return;
      }
      originalWarn(...args);
    };
    releaseKnownVrmWebGpuWarningFilterGlobal = () => {
      knownVrmWebGpuWarningFilterRefs = Math.max(
        0,
        knownVrmWebGpuWarningFilterRefs - 1,
      );
      if (knownVrmWebGpuWarningFilterRefs === 0) {
        console.warn = originalWarn;
        releaseKnownVrmWebGpuWarningFilterGlobal = null;
      }
    };
  }

  return () => {
    releaseKnownVrmWebGpuWarningFilterGlobal?.();
  };
}

function getSharedDracoLoader(): CompatibleDracoLoader {
  if (!sharedDracoLoader) {
    sharedDracoLoader = new DRACOLoader();
    sharedDracoLoader.setDecoderConfig({ type: "wasm" });
    sharedDracoLoader.setDecoderPath(getDracoDecoderPath());
    sharedDracoLoader.preload();
  }
  // three/examples and the current GLTF loader declarations diverge on the
  // decoder surface, but this runtime instance is the loader we use in app.
  return sharedDracoLoader as unknown as CompatibleDracoLoader;
}

function configureVrmGltfLoader(loader: GLTFLoader): void {
  // three/examples and the current GLTF loader declarations diverge on the
  // meshopt decoder surface, but this runtime instance is the decoder we ship.
  loader.setMeshoptDecoder(
    MeshoptDecoder as unknown as CompatibleMeshoptDecoder,
  );
  loader.setDRACOLoader(getSharedDracoLoader());
}

function getTeleportSparkleTexture(): THREE.CanvasTexture {
  if (teleportSparkleTexture) return teleportSparkleTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) {
    teleportSparkleTexture = new THREE.CanvasTexture(canvas);
    return teleportSparkleTexture;
  }

  const gradient = context.createRadialGradient(64, 64, 6, 64, 64, 64);
  gradient.addColorStop(0.0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.2, "rgba(190,245,255,0.95)");
  gradient.addColorStop(0.55, "rgba(112,214,255,0.48)");
  gradient.addColorStop(1.0, "rgba(112,214,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);

  teleportSparkleTexture = new THREE.CanvasTexture(canvas);
  teleportSparkleTexture.needsUpdate = true;
  return teleportSparkleTexture;
}

function isGzipBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 2) return false;
  const bytes = new Uint8Array(buffer, 0, 2);
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function decompressGzipBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof DecompressionStream !== "function") {
    throw new Error(
      "This runtime does not support gzip-compressed VRM assets.",
    );
  }
  const stream = new Blob([buffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

/* ── In-memory VRM ArrayBuffer cache ─────────────────────────────────────────
 * Caches the decompressed (ready-to-parse) ArrayBuffer keyed by URL so that
 * switching back to a previously-loaded avatar skips the network fetch entirely.
 * We intentionally cache raw bytes rather than parsed GLTF/VRM objects because
 * three.js scene graphs carry GPU-bound resources that cannot be safely shared
 * or cloned across instances.  Re-parsing from an ArrayBuffer is fast (<200ms)
 * and avoids an entire class of WebGL state bugs.
 *
 * LRU eviction keeps memory bounded (default: 8 entries ≈ 80-160 MB).
 * ──────────────────────────────────────────────────────────────────────────── */

interface VrmBufferCacheEntry {
  /** Decompressed, ready-to-parse ArrayBuffer. */
  buffer: ArrayBuffer;
  /** Monotonic timestamp for LRU eviction. */
  lastUsed: number;
}

const vrmBufferCache = new Map<string, VrmBufferCacheEntry>();
const VRM_BUFFER_CACHE_MAX = 8;

/**
 * In-flight prefetch promises keyed by URL. Prevents duplicate concurrent
 * downloads when `loadGltfAsset` runs while a prefetch for the same URL is
 * still in progress.
 */
const vrmPrefetchInflight = new Map<string, Promise<void>>();

function touchVrmCacheEntry(url: string, buffer: ArrayBuffer): void {
  vrmBufferCache.set(url, { buffer, lastUsed: performance.now() });

  // Evict oldest entries when over capacity.
  while (vrmBufferCache.size > VRM_BUFFER_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of vrmBufferCache) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) vrmBufferCache.delete(oldestKey);
    else break;
  }
}

/**
 * Prefetch a VRM file into the in-memory buffer cache without parsing it.
 * Fire-and-forget: silently swallows errors since prefetch is best-effort.
 * Calling this when the character tab opens means the buffer is ready before
 * the user clicks a character, turning a ~3-8 s cold fetch into a <200 ms
 * re-parse from cache.
 */
export async function prefetchVrmToCache(url: string): Promise<void> {
  if (vrmBufferCache.has(url)) return; // already warm

  // If a prefetch for this URL is already in flight, join it instead of
  // starting a duplicate download.
  const existing = vrmPrefetchInflight.get(url);
  if (existing) return existing;

  const work = (async () => {
    try {
      const response = await fetch(url, { cache: "force-cache" });
      if (!response.ok) return;
      let buffer = await response.arrayBuffer();
      if (isGzipBuffer(buffer)) buffer = await decompressGzipBuffer(buffer);
      touchVrmCacheEntry(url, buffer);
    } catch {
      // Prefetch is best-effort — network errors are silently ignored.
    } finally {
      vrmPrefetchInflight.delete(url);
    }
  })();

  vrmPrefetchInflight.set(url, work);
  return work;
}

async function loadGltfAsset(
  loader: GLTFLoader,
  url: string,
  onProgress?: (progress: number) => void,
): Promise<Awaited<ReturnType<GLTFLoader["loadAsync"]>>> {
  let buffer: ArrayBuffer;

  // If a prefetch for this URL is in flight, await it so we hit the
  // in-memory cache instead of starting a duplicate network request.
  const inflight = vrmPrefetchInflight.get(url);
  if (inflight) {
    await inflight;
  }

  const cached = vrmBufferCache.get(url);
  if (cached) {
    // Cache hit — skip network entirely, copy the buffer so the cache stays
    // valid even if GLTFLoader transfers/neuters the original.
    buffer = cached.buffer.slice(0);
    touchVrmCacheEntry(url, cached.buffer);
    onProgress?.(1);
  } else {
    // Cache miss — fetch from network/browser cache.
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`Failed to fetch VRM asset: ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);

    if (!contentLength || !response.body || !onProgress) {
      buffer = await response.arrayBuffer();
      onProgress?.(1);
    } else {
      const reader = response.body.getReader();
      let received = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.length;
          onProgress(Math.min(received / contentLength, 1));
        }
      }
      const combined = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      buffer = combined.buffer;
    }

    // Decompress gzip if needed, then store the decompressed bytes.
    if (isGzipBuffer(buffer)) {
      buffer = await decompressGzipBuffer(buffer);
    }

    // Store a copy in the cache (keep the original for parsing below).
    touchVrmCacheEntry(url, buffer.slice(0));
  }

  const objectUrl = URL.createObjectURL(
    new Blob([buffer], { type: "model/gltf-binary" }),
  );
  try {
    return await loader.loadAsync(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Create the best available renderer for the canvas.
 * Tries WebGPURenderer only when preference allows, Electrobun defaults prefer
 * webgpu, and `navigator.gpu` exists; otherwise uses WebGL (also on WebGPU init failure).
 * Non-Electrobun (e.g. browser dev) defaults preference to WebGL to reduce TSL noise.
 * `localStorage` can force `webgpu` or `webgl`. WebGPURenderer is async; await `init()` when present.
 */
async function createRenderer(
  canvas: HTMLCanvasElement,
  preference: RendererPreference = "auto",
): Promise<{ backend: RendererBackend; renderer: RendererLike }> {
  if (
    preference !== "webgl" &&
    getPreferredAvatarRendererBackend() === "webgpu" &&
    typeof navigator !== "undefined" &&
    navigator.gpu
  ) {
    try {
      const { WebGPURenderer } = await import("three/webgpu");
      const renderer = new WebGPURenderer({
        canvas,
        alpha: true,
        antialias: true,
      }) as unknown as RendererLike & { init?: () => Promise<unknown> };
      await renderer.init?.();
      console.info("[VrmEngine] Using WebGPURenderer");
      return { backend: "webgpu", renderer };
    } catch (err) {
      console.warn(
        "[VrmEngine] WebGPURenderer failed, falling back to WebGL:",
        err,
      );
    }
  }
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  }) as RendererLike;
  console.info("[VrmEngine] Using WebGLRenderer");
  return { backend: "webgl", renderer };
}

export class VrmEngine {
  private renderer: RendererLike | null = null;
  private rendererBackend: RendererBackend = "webgl";
  private rendererPreference: RendererPreference = "auto";
  private scene: THREE.Scene | null = null;
  private mathEnvironment: MathEnvironment | null = null;
  private overlayManager: SceneOverlayManager | null = null;
  private avatarRoot: THREE.Group | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private clock = new THREE.Clock();
  private vrm: VRM | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private idleLoadPromise: Promise<THREE.AnimationAction | null> | null = null;
  private animationFrameId: number | null = null;
  private onUpdate: UpdateCallback | null = null;
  private initialized = false;
  private loadingAborted = false;
  private vrmLoadRequestId = 0;
  private vrmReady = false;
  private lastLoadError: string | null = null;
  private teleportProgress = 1.0;
  private loadingProgress = 0;
  /** Timestamp (from elapsedTime) when the teleport dissolve finished. */
  private teleportCompleteTime = -Infinity;
  private teleportProgressUniform: { value: number } | null = null;
  private teleportDissolvedMaterials: THREE.Material[] = [];
  private teleportFallbackShaders: {
    uniforms: { uTeleportProgress: { value: number } };
    isOutgoing?: boolean;
  }[] = [];
  private teleportSparkles: TeleportSparkleSystem | null = null;
  private revealStarted = false;
  private mouthValue = 0;
  private mouthSmoothed = 0;
  private vrmName: string | null = null;
  private lookAtTarget = new THREE.Vector3(0, 0.5, 0);
  private readonly idleGlbUrl = resolveAppAssetUrl("animations/idle.glb.gz");

  private outgoingVrm: VRM | null = null;
  private outgoingMixer: THREE.AnimationMixer | null = null;
  private cameraAnimation: CameraAnimationConfig = {
    ...DEFAULT_CAMERA_ANIMATION,
  };
  private baseCameraPosition = new THREE.Vector3();
  private elapsedTime = 0;
  private speaking = false;
  private speakingStartTime = 0;
  private readonly blinkController = new VrmBlinkController();

  private readonly cameraManager = new VrmCameraManager();
  private emoteAction: THREE.AnimationAction | null = null;
  private emoteTimeout: ReturnType<typeof setTimeout> | null = null;
  private emoteCompletionCleanup: (() => void) | null = null;
  private emoteClipCache = new Map<string, THREE.AnimationClip>();
  private emoteRequestId = 0;
  private controls: OrbitControls | null = null;
  /** Key light used for avatar shadows — toggled in low-power mode. */
  private keyDirectionalLight: THREE.DirectionalLight | null = null;
  /** When true, cap effective `devicePixelRatio` at 1 (fewer shaded pixels on Retina). */
  private lowPowerRenderMode = false;
  /**
   * When true, skip every other animation tick (~half display rate). Independent
   * of {@link lowPowerRenderMode}; `Clock.getDelta()` on active ticks absorbs skips.
   */
  private halfFramerateMode = false;
  private halfFramerateSkipNext = false;
  private paused = false;
  /**
   * When true, only VRM idle/physics keep running (document hidden + user opt-in).
   */
  private minimalBackgroundMode = false;
  private interactionEnabled = false;
  private interactionMode: InteractionMode = "free";
  private cameraProfile: CameraProfile = "chat";
  private pointerParallaxEnabled = false;
  private pointerParallaxTarget = new THREE.Vector2();
  private pointerParallaxCurrent = new THREE.Vector2();
  private pointerParallaxPosition = new THREE.Vector3();
  private pointerParallaxLookAt = new THREE.Vector3();
  private dragOrbitTarget = new THREE.Vector2();
  private dragOrbitCurrent = new THREE.Vector2();
  private companionZoomTarget = 0;
  private companionZoomCurrent = 0;
  private cameraXOffsetTarget = 0;
  private cameraXOffsetCurrent = 0;
  /** Orbital yaw offset applied by the editor camera shift. */
  private cameraYawOffsetTarget = 0;
  private cameraYawOffsetCurrent = 0;
  private avatarLookTarget: THREE.Group | null = null;
  private headLookTarget = new THREE.Vector2();
  private headLookCurrent = new THREE.Vector2();
  private clearEmoteTimeout(): void {
    if (this.emoteTimeout !== null) {
      clearTimeout(this.emoteTimeout);
      this.emoteTimeout = null;
    }
  }

  private clearEmoteCompletionCleanup(): void {
    this.emoteCompletionCleanup?.();
    this.emoteCompletionCleanup = null;
  }

  private clearPendingEmoteCompletion(): void {
    this.clearEmoteTimeout();
    this.clearEmoteCompletionCleanup();
  }

  private watchOneShotEmoteCompletion(
    mixer: THREE.AnimationMixer,
    action: THREE.AnimationAction,
    requestId: number,
    fallbackDurationSeconds: number,
  ): void {
    const handleFinished = (event: AnimationMixerFinishedEvent): void => {
      if (event.action !== action) return;
      if (this.emoteRequestId !== requestId || this.emoteAction !== action) {
        return;
      }
      this.stopEmote();
    };

    mixer.addEventListener("finished", handleFinished);
    this.emoteCompletionCleanup = () => {
      mixer.removeEventListener("finished", handleFinished);
    };

    const safeDuration =
      Number.isFinite(fallbackDurationSeconds) && fallbackDurationSeconds > 0
        ? fallbackDurationSeconds
        : 3;

    // Keep a timer fallback in case the mixer completion event is missed.
    this.emoteTimeout = setTimeout(
      () => {
        if (this.emoteRequestId !== requestId || this.emoteAction !== action) {
          return;
        }
        this.stopEmote();
      },
      Math.max(0.25, safeDuration + 0.1) * 1000,
    );
  }

  private activateAction(action: THREE.AnimationAction): void {
    action.enabled = true;
    action.paused = false;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.play();
  }

  private async ensureIdleAction(
    vrm: VRM,
    mixer: THREE.AnimationMixer,
  ): Promise<THREE.AnimationAction | null> {
    if (this.idleAction) return this.idleAction;
    if (this.idleLoadPromise) return this.idleLoadPromise;

    this.idleLoadPromise = (async () => {
      const clip = await loadIdleClip(
        vrm,
        this.idleGlbUrl,
        this.animationLoaderContext,
      );
      if (!clip || this.loadingAborted || this.vrm !== vrm) {
        return null;
      }
      const activeMixer = this.mixer ?? mixer;
      if (!activeMixer || this.vrm !== vrm) {
        return null;
      }
      const action = activeMixer.clipAction(clip);
      action.reset();
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.timeScale = 1.0;
      this.idleAction = action;
      activeMixer.update(1 / 60);
      return action;
    })().finally(() => {
      this.idleLoadPromise = null;
    });

    return this.idleLoadPromise;
  }

  private restoreIdleAfterEmote(
    activeEmote: THREE.AnimationAction | null,
    fadeDuration: number,
    vrm: VRM,
    mixer: THREE.AnimationMixer,
  ): void {
    void this.ensureIdleAction(vrm, mixer).then((idleAction) => {
      if (!idleAction || this.loadingAborted || this.vrm !== vrm) {
        activeEmote?.fadeOut(fadeDuration);
        return;
      }
      this.activateAction(idleAction);
      if (activeEmote && activeEmote !== idleAction) {
        idleAction.crossFadeFrom(activeEmote, fadeDuration, false);
      } else {
        idleAction.fadeIn(fadeDuration);
      }
    });
  }
  private avatarLookRig: {
    headBone: THREE.Object3D | null;
    neckBone: THREE.Object3D | null;
    spineBone: THREE.Object3D | null;
  } = {
    headBone: null,
    neckBone: null,
    spineBone: null,
  };
  private readonly tempCameraOrbitOffset = new THREE.Vector3();
  private readonly tempCameraSpherical = new THREE.Spherical();
  private readonly tempAvatarLookTarget = new THREE.Vector3();
  private readonly tempAvatarLocalTarget = new THREE.Vector3();
  private readonly tempAvatarLocalAnchor = new THREE.Vector3();
  private readonly tempAvatarHeadWorld = new THREE.Vector3();
  private readyPromise: Promise<void> = Promise.resolve();
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error?: unknown) => void) | null = null;
  private releaseKnownWebGpuWarningFilter: (() => void) | null = null;

  // Transition state
  private isCameraTransitioning = false;
  private transitionStartFov = 0;
  private transitionTargetFov = 0;
  private transitionStartPos = new THREE.Vector3();
  private transitionTargetPos = new THREE.Vector3();
  private transitionStartLookAt = new THREE.Vector3();
  private transitionTargetLookAt = new THREE.Vector3();
  private transitionProgress = 0;
  private transitionDuration = CAMERA_PROFILE_TRANSITION_DURATION_SECONDS;

  private handleControlStart = (): void => {
    if (!this.interactionEnabled) return;
  };
  private handleControlEnd = (): void => {
    if (!this.interactionEnabled) return;
    if (this.controls) {
      this.lookAtTarget.copy(this.controls.target);
    }
  };

  private scheduleNextFrame(): void {
    if (!this.initialized || this.paused || this.animationFrameId !== null) {
      return;
    }
    if (this.renderer?.setAnimationLoop) {
      this.animationFrameId = 1;
      this.renderer.setAnimationLoop(() => {
        this.loop();
      });
    } else {
      this.animationFrameId = requestAnimationFrame(() => {
        this.animationFrameId = null;
        this.loop();
      });
    }
  }

  private stopLoop(): void {
    if (this.animationFrameId !== null) {
      if (this.renderer?.setAnimationLoop) {
        this.renderer.setAnimationLoop(null);
      } else {
        cancelAnimationFrame(this.animationFrameId);
      }
      this.animationFrameId = null;
    }
    this.clock.stop();
  }

  /**
   * Re-applies `setPixelRatio` from DPR and battery policy, then
   * resizes the drawing buffer to match the canvas CSS size.
   *
   * **WHY:** `setPixelRatio` alone does not always refit the buffer after
   * snapshot capture or when toggling low-power mode mid-session.
   */
  private applyRendererPixelRatio(): void {
    if (!this.renderer || !this.camera) return;
    const base = getRendererPixelRatio();
    const ratio = this.lowPowerRenderMode ? Math.min(base, 1) : base;
    this.renderer.setPixelRatio(ratio);
    const canvas = this.renderer.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w > 0 && h > 0) {
      this.resize(w, h);
    }
  }

  /** Disable expensive directional shadow maps on battery — big GPU savings. */
  private applyLowPowerShadowPolicy(): void {
    const light = this.keyDirectionalLight;
    if (!light) return;
    if (this.lowPowerRenderMode) {
      light.castShadow = false;
    } else {
      light.castShadow = true;
      light.shadow.mapSize.setScalar(1024);
    }
    const r = this.renderer as THREE.WebGLRenderer | null;
    if (r?.shadowMap) {
      r.shadowMap.needsUpdate = true;
    }
  }

  private resumeLoop(): void {
    if (!this.initialized || this.paused) return;
    this.clock.start();
    this.scheduleNextFrame();
  }

  private applyCompanionZoom(
    camera: THREE.PerspectiveCamera,
    stableDelta: number,
  ): void {
    const isCompanionProfile = this.cameraProfile === "companion";
    const follow = Math.min(1, stableDelta * 10);
    const targetZoom = isCompanionProfile ? this.companionZoomTarget : 0;
    this.companionZoomCurrent = THREE.MathUtils.lerp(
      this.companionZoomCurrent,
      targetZoom,
      follow,
    );
    if (this.companionZoomCurrent < 1e-4) return;

    const baseRadius = this.baseCameraPosition.distanceTo(this.lookAtTarget);
    if (!Number.isFinite(baseRadius) || baseRadius < 1e-4) return;

    const orbitOffset = this.tempCameraOrbitOffset
      .copy(camera.position)
      .sub(this.lookAtTarget);
    if (orbitOffset.lengthSq() < 1e-6) return;

    const spherical = this.tempCameraSpherical.setFromVector3(orbitOffset);
    const nearRadius = Math.max(
      COMPANION_ZOOM_MIN_RADIUS,
      baseRadius * COMPANION_ZOOM_NEAR_FACTOR,
    );
    spherical.radius = THREE.MathUtils.lerp(
      baseRadius,
      nearRadius,
      this.companionZoomCurrent,
    );
    camera.position
      .copy(this.lookAtTarget)
      .add(orbitOffset.setFromSpherical(spherical));
  }

  private configureAvatarLookTracking(vrm: VRM): void {
    const target = this.avatarLookTarget;
    if (target) {
      target.position.set(0, 1.5, 2);
      target.updateMatrixWorld(true);
    }
    if (vrm.lookAt && target) {
      vrm.lookAt.autoUpdate = true;
      vrm.lookAt.target = target;
    }

    const headBone = vrm.humanoid?.getRawBoneNode("head") ?? null;
    const neckBone = vrm.humanoid?.getRawBoneNode("neck") ?? null;
    const spineBone =
      vrm.humanoid?.getRawBoneNode("upperChest") ??
      vrm.humanoid?.getRawBoneNode("chest") ??
      vrm.humanoid?.getRawBoneNode("spine") ??
      null;

    this.avatarLookRig = {
      headBone,
      neckBone,
      spineBone,
    };
    this.headLookTarget.set(0, 0);
    this.headLookCurrent.set(0, 0);
  }

  private updateAvatarLookTarget(
    camera: THREE.PerspectiveCamera,
    stableDelta: number,
  ): void {
    const target = this.avatarLookTarget;
    if (!target) return;
    this.tempAvatarLookTarget.copy(camera.position);
    const follow = Math.min(1, stableDelta * 24);
    target.position.lerp(this.tempAvatarLookTarget, follow);
    target.updateMatrixWorld(true);
  }

  private refreshAvatarEyeTracking(): void {
    const vrm = this.vrm;
    if (!vrm?.lookAt || !this.avatarLookTarget) return;
    vrm.lookAt.update(0);
    vrm.expressionManager?.update();
  }

  private applyAvatarHeadTracking(
    camera: THREE.PerspectiveCamera,
    stableDelta: number,
  ): void {
    const vrm = this.vrm;
    const { headBone, neckBone, spineBone } = this.avatarLookRig;
    if (!vrm || !headBone) return;
    const headParent = headBone.parent;
    if (!headParent || typeof headParent.worldToLocal !== "function") return;
    if (
      typeof THREE.Euler !== "function" ||
      typeof THREE.Quaternion !== "function" ||
      typeof headBone.quaternion.clone !== "function"
    ) {
      return;
    }
    const lookAtState = vrm.lookAt as unknown as
      | ({ _yaw?: number; _pitch?: number } & object)
      | null
      | undefined;
    const lookAtYawDegrees = lookAtState?._yaw;
    const lookAtPitchDegrees = lookAtState?._pitch;

    if (
      Number.isFinite(lookAtYawDegrees) &&
      Number.isFinite(lookAtPitchDegrees)
    ) {
      this.headLookTarget.set(
        THREE.MathUtils.clamp(
          THREE.MathUtils.degToRad(lookAtYawDegrees || 0),
          -0.55,
          0.55,
        ),
        THREE.MathUtils.clamp(
          THREE.MathUtils.degToRad(lookAtPitchDegrees || 0),
          -0.3,
          0.24,
        ),
      );
    } else {
      headBone.getWorldPosition(this.tempAvatarHeadWorld);
      this.tempAvatarLocalTarget.copy(camera.position);
      this.tempAvatarLocalTarget.y -= 0.04;
      headParent.worldToLocal(this.tempAvatarLocalTarget);
      headParent.worldToLocal(
        this.tempAvatarLocalAnchor.copy(this.tempAvatarHeadWorld),
      );
      this.tempAvatarLocalTarget.sub(this.tempAvatarLocalAnchor);

      const planarDistance = Math.max(
        1e-4,
        Math.hypot(this.tempAvatarLocalTarget.x, this.tempAvatarLocalTarget.z),
      );
      this.headLookTarget.set(
        THREE.MathUtils.clamp(
          Math.atan2(
            -this.tempAvatarLocalTarget.x,
            Math.max(-this.tempAvatarLocalTarget.z, 1e-4),
          ),
          -0.55,
          0.55,
        ),
        THREE.MathUtils.clamp(
          Math.atan2(this.tempAvatarLocalTarget.y, planarDistance),
          -0.3,
          0.24,
        ),
      );
    }
    this.headLookCurrent.lerp(
      this.headLookTarget,
      Math.min(1, stableDelta * 4.5),
    );

    const applyTrackedBone = (
      bone: THREE.Object3D | null,
      yawWeight: number,
      pitchWeight: number,
    ) => {
      if (!bone?.quaternion || typeof bone.quaternion.clone !== "function") {
        return;
      }
      const offsetEuler = new THREE.Euler(
        this.headLookCurrent.y * pitchWeight,
        this.headLookCurrent.x * yawWeight,
        0,
        "YXZ",
      );
      const offsetQuaternion = new THREE.Quaternion().setFromEuler(offsetEuler);
      const animatedPose = bone.quaternion.clone();
      bone.quaternion.copy(animatedPose).multiply(offsetQuaternion);
    };

    applyTrackedBone(spineBone, 0.12, 0.06);
    applyTrackedBone(neckBone, 0.3, 0.18);
    applyTrackedBone(headBone, 0.52, 0.28);
  }

  private toDebugVector3(vector: THREE.Vector3 | null): DebugVector3 | null {
    if (!vector) return null;
    return {
      x: Number(vector.x.toFixed(4)),
      y: Number(vector.y.toFixed(4)),
      z: Number(vector.z.toFixed(4)),
    };
  }

  private toDebugBounds(object: THREE.Object3D | null): DebugBounds | null {
    if (!object) return null;
    const bounds = new THREE.Box3().setFromObject(object);
    if (bounds.isEmpty()) return null;
    return this.toDebugBoundsFromBox(bounds);
  }

  private toDebugBoundsFromBox(bounds: THREE.Box3 | null): DebugBounds | null {
    if (!bounds || bounds.isEmpty()) return null;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const min = this.toDebugVector3(bounds.min.clone());
    const max = this.toDebugVector3(bounds.max.clone());
    const centerVector = this.toDebugVector3(center);
    const sizeVector = this.toDebugVector3(size);
    if (!min || !max || !centerVector || !sizeVector) return null;
    return {
      min,
      max,
      center: centerVector,
      size: sizeVector,
    };
  }

  getDebugInfo(): VrmEngineDebugInfo {
    this.scene?.updateMatrixWorld(true);
    this.vrm?.scene.updateMatrixWorld(true);

    const cameraRotation = this.camera
      ? new THREE.Vector3(
          this.camera.rotation.x,
          this.camera.rotation.y,
          this.camera.rotation.z,
        )
      : null;
    const lookAtTarget =
      this.toDebugVector3(this.lookAtTarget) ??
      ({ x: 0, y: 0, z: 0 } satisfies DebugVector3);

    return {
      initialized: this.initialized,
      rendererBackend: this.rendererBackend,
      cameraProfile: this.cameraProfile,
      sceneChildren:
        this.scene?.children.map(
          (child: THREE.Object3D) => child.name || child.type,
        ) ?? [],
      camera: {
        parentName: this.camera?.parent?.name ?? null,
        position: this.toDebugVector3(this.camera?.position ?? null),
        rotation: this.toDebugVector3(cameraRotation),
        fov: this.camera?.fov ?? null,
        lookAtTarget,
      },
      avatar: {
        loaded: this.vrm !== null,
        ready: this.vrmReady,
        parentName: this.vrm?.scene.parent?.name ?? null,
        position: this.toDebugVector3(this.vrm?.scene.position ?? null),
        scale: this.toDebugVector3(this.vrm?.scene.scale ?? null),
        bounds: this.toDebugBounds(this.vrm?.scene ?? null),
      },
    };
  }

  setDebugAvatarVisible(visible: boolean): void {
    if (!this.vrm) return;
    this.vrm.scene.visible = visible;
  }

  setDebugCamera(position: THREE.Vector3, target: THREE.Vector3): void {
    if (!this.camera) return;
    this.isCameraTransitioning = false;
    this.camera.position.copy(position);
    this.baseCameraPosition.copy(position);
    this.lookAtTarget.copy(target);
    this.controls?.target.copy(target);
    this.controls?.update();
    this.camera.lookAt(target);
  }

  private startCameraTransition(
    startPos: THREE.Vector3,
    startLookAt: THREE.Vector3,
    startFov: number,
    targetPos: THREE.Vector3,
    targetLookAt: THREE.Vector3,
    targetFov: number,
    durationSeconds: number,
  ): void {
    if (!this.camera) return;

    this.transitionStartFov = startFov;
    this.transitionTargetFov = targetFov;
    this.transitionStartPos.copy(startPos);
    this.transitionTargetPos.copy(targetPos);
    this.transitionStartLookAt.copy(startLookAt);
    this.transitionTargetLookAt.copy(targetLookAt);
    this.transitionDuration = Math.max(0.01, durationSeconds);

    this.camera.fov = startFov;
    this.camera.position.copy(startPos);
    this.camera.updateProjectionMatrix();
    this.baseCameraPosition.copy(startPos);
    this.lookAtTarget.copy(startLookAt);
    if (this.controls) {
      this.controls.target.copy(startLookAt);
      this.controls.update();
    }
    this.camera.lookAt(startLookAt);
    this.isCameraTransitioning = true;
    this.transitionProgress = 0;
  }

  private transitionCameraToFramedAvatar(
    vrm: VRM,
    durationSeconds: number,
  ): void {
    if (!this.camera) return;

    const startPos = new THREE.Vector3().copy(this.baseCameraPosition);
    const startLookAt = new THREE.Vector3().copy(this.lookAtTarget);
    const startFov = this.camera.fov;
    const targetLookAt = new THREE.Vector3();
    const defaultProfileTargetPos = new THREE.Vector3();

    const dummyCamera = this.camera.clone();

    this.cameraManager.centerAndFrame(
      vrm,
      dummyCamera,
      this.controls,
      this.cameraProfile,
      targetLookAt,
      defaultProfileTargetPos,
      (c) => this.cameraManager.applyInteractionMode(c, this.interactionMode),
      true, // skipControlUpdate
    );

    // To prevent frame-based dynamic offsets (yaw, sway, zoom) from accumulating and causing camera spin,
    // compute the pristine tracking offset from baseCameraPosition, which is unaffected by post-process
    // modifiers in applyCameraMotion. We do NOT use OrbitControls' getDistance/getAzimuthalAngle because
    // OrbitControls reads from `camera.position` which has the temporary view shifts applied to it every frame.
    const currentOffset = new THREE.Vector3();
    currentOffset.copy(this.baseCameraPosition).sub(startLookAt);

    const targetPos = new THREE.Vector3().copy(targetLookAt).add(currentOffset);

    this.startCameraTransition(
      startPos,
      startLookAt,
      startFov,
      targetPos,
      targetLookAt,
      dummyCamera.fov,
      durationSeconds,
    );
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  private resetReadyPromise(): void {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  private settleReady(error?: unknown): void {
    if (error) {
      this.rejectReady?.(error);
    } else {
      this.resolveReady?.();
    }
    this.resolveReady = null;
    this.rejectReady = null;
  }

  setup(
    canvas: HTMLCanvasElement,
    onUpdate: UpdateCallback,
    options?: {
      rendererPreference?: RendererPreference;
    },
  ): void {
    if (this.initialized && this.renderer?.domElement === canvas) {
      this.onUpdate = onUpdate;
      return;
    }
    if (this.initialized) this.dispose();
    this.onUpdate = onUpdate;
    this.loadingAborted = false;
    this.rendererPreference = options?.rendererPreference ?? "auto";
    this.resetReadyPromise();
    // Async renderer creation: tries WebGPU, falls back to WebGL.
    // setup() remains synchronous for callers; the loop starts after init resolves.
    void (async () => {
      try {
        const { backend, renderer } = await createRenderer(
          canvas,
          this.rendererPreference,
        );
        const releaseKnownWebGpuWarningFilter =
          backend === "webgpu" ? installKnownVrmWebGpuWarningFilter() : null;
        // Guard: if dispose() was called while we were awaiting, abort.
        if (this.loadingAborted) {
          releaseKnownWebGpuWarningFilter?.();
          renderer.dispose();
          this.settleReady();
          return;
        }
        this.releaseKnownWebGpuWarningFilter = releaseKnownWebGpuWarningFilter;
        this.renderer = renderer;
        renderer.setClearColor(0x000000, 0);
        if (backend === "webgl") {
          const webglRenderer = renderer as THREE.WebGLRenderer;
          webglRenderer.shadowMap.enabled = true;
          webglRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
          webglRenderer.toneMapping = THREE.NoToneMapping;
          webglRenderer.toneMappingExposure = 1.0;
          webglRenderer.outputColorSpace = THREE.SRGBColorSpace;
        }
        this.rendererBackend = backend;
        const scene = new THREE.Scene();
        this.scene = scene;
        // Build construct environment (white void, floating screens, fog)
        this.mathEnvironment = new MathEnvironment();
        this.mathEnvironment.build(scene, "light");
        const avatarRoot = new THREE.Group();
        avatarRoot.name = "AvatarRoot";
        scene.add(avatarRoot);
        this.avatarRoot = avatarRoot;
        const avatarLookTarget = new THREE.Group();
        avatarLookTarget.name = "AvatarLookTarget";
        scene.add(avatarLookTarget);
        this.avatarLookTarget = avatarLookTarget;
        const cameraRig = new THREE.Group();
        cameraRig.name = "AvatarCameraRig";
        scene.add(cameraRig);
        const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
        camera.position.set(0, 1.2, 5.0);
        cameraRig.add(camera);
        this.camera = camera;
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = false;
        controls.target.copy(this.lookAtTarget);
        controls.addEventListener("start", this.handleControlStart);
        controls.addEventListener("end", this.handleControlEnd);
        this.cameraManager.applyInteractionMode(controls, this.interactionMode);
        controls.update();
        this.controls = controls;
        this.setInteractionEnabled(this.interactionEnabled);
        // Apply deferred camera profile (setCameraProfile may have been called
        // before the camera existed) and initialize baseCameraPosition so that
        // drag-orbit and companion-zoom have a valid reference point from the
        // very first frame.
        this.cameraManager.applyCameraProfileToCamera(
          camera,
          controls,
          this.cameraProfile,
        );
        this.baseCameraPosition.copy(camera.position);
        this.lookAtTarget.copy(controls.target);
        const ambient = new THREE.AmbientLight(0xffffff, 1.2);
        scene.add(ambient);
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
        keyLight.position.set(1, 1.5, 1).normalize();
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.setScalar(1024);
        scene.add(keyLight);
        this.keyDirectionalLight = keyLight;
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
        fillLight.position.set(-1, 0.5, -1).normalize();
        scene.add(fillLight);
        this.applyRendererPixelRatio();
        if (this.lowPowerRenderMode) {
          this.applyLowPowerShadowPolicy();
        }
        // Auto-create the scene overlay manager for floating HUD panels.
        if (!this.overlayManager && this.scene) {
          try {
            this.overlayManager = new SceneOverlayManager();
            this.overlayManager.attach(this.scene);
          } catch {
            // Overlay panels require a full 2D canvas context; gracefully
            // skip when running in headless / test environments.
          }
        }
        this.initialized = true;
        this.resumeLoop();
        this.settleReady();
      } catch (error) {
        this.initialized = false;
        this.releaseKnownWebGpuWarningFilter?.();
        this.releaseKnownWebGpuWarningFilter = null;
        this.renderer = null;
        this.rendererBackend = "webgl";
        this.scene = null;
        this.camera = null;
        this.controls = null;
        this.keyDirectionalLight = null;
        console.error("[VrmEngine] Failed to initialize renderer:", error);
        this.settleReady(error);
      }
    })();
  }

  isInitialized(): boolean {
    return this.initialized && this.renderer !== null;
  }
  dispose(): void {
    this.mathEnvironment?.dispose();
    this.mathEnvironment = null;
    this.overlayManager?.dispose();
    this.overlayManager = null;
    this.loadingAborted = true;
    this.initialized = false;
    this.settleReady();
    this.releaseKnownWebGpuWarningFilter?.();
    this.releaseKnownWebGpuWarningFilter = null;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.vrm?.scene.parent) {
      this.vrm.scene.parent.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    if (this.controls) {
      this.controls.removeEventListener("start", this.handleControlStart);
      this.controls.removeEventListener("end", this.handleControlEnd);
      this.controls.dispose();
      this.controls = null;
    }
    this.vrm = null;
    this.vrmReady = false;
    this.vrmName = null;
    this.lastLoadError = null;
    this.mixer = null;
    this.idleAction = null;
    this.idleLoadPromise = null;
    this.clearPendingEmoteCompletion();
    this.emoteAction = null;
    this.emoteClipCache.clear();
    this.teleportProgress = 1.0;
    this.cleanupTeleportDissolve();
    this.cleanupTeleportSparkles();
    this.avatarLookTarget?.parent?.remove(this.avatarLookTarget);
    this.avatarLookTarget = null;
    this.avatarLookRig = {
      headBone: null,
      neckBone: null,
      spineBone: null,
    };
    this.headLookTarget.set(0, 0);
    this.headLookCurrent.set(0, 0);
    if (this.renderer) {
      this.renderer.dispose();
    }
    this.renderer = null;
    this.rendererBackend = "webgl";
    this.keyDirectionalLight = null;
    this.scene = null;
    this.avatarRoot = null;
    this.camera = null;
    this.onUpdate = null;
    this.paused = false;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.stopLoop();
      return;
    }
    this.resumeLoop();
  }

  /**
   * Keeps the animation/render loop alive so the avatar keeps idling while
   * background is hidden. Restores prior state when disabled.
   */
  setMinimalBackgroundMode(enabled: boolean): void {
    if (this.minimalBackgroundMode === enabled) return;
    this.minimalBackgroundMode = enabled;
  }

  /**
   * When true, caps the WebGL/WebGPU pixel ratio at **1** on top of the usual
   * DPR clamp and applies cheaper shadows — primarily for
   * **battery** on Retina. Does **not** change frame cadence; use
   * {@link setHalfFramerateMode} for ~half refresh rate.
   *
   * **WHY:** shader cost scales with physical pixels; `desktopGetPowerState`
   * → `onBattery` toggles this from the Electrobun shell without a full reload.
   */
  setLowPowerRenderMode(enabled: boolean): void {
    if (this.lowPowerRenderMode === enabled) return;
    this.lowPowerRenderMode = enabled;
    this.applyRendererPixelRatio();
    this.applyLowPowerShadowPolicy();
  }

  /**
   * When true, the main loop skips every other tick so `renderer.render` runs at
   * roughly half the display refresh rate; skipped ticks do not call
   * `clock.getDelta()`, so the next tick’s delta spans two intervals.
   */
  setHalfFramerateMode(enabled: boolean): void {
    if (this.halfFramerateMode === enabled) return;
    this.halfFramerateMode = enabled;
    this.halfFramerateSkipNext = false;
  }

  setInteractionEnabled(enabled: boolean): void {
    this.interactionEnabled = enabled;
    if (this.controls) {
      this.controls.enabled = enabled;
    }
  }
  setInteractionMode(mode: InteractionMode): void {
    this.interactionMode = mode;
    if (this.controls) {
      this.cameraManager.applyInteractionMode(this.controls, mode);
      this.controls.update();
    }
  }
  setCameraProfile(profile: CameraProfile): void {
    if (this.cameraProfile === profile) return;

    if (this.camera) {
      const startFov = this.camera.fov;
      const startPos = new THREE.Vector3().copy(this.camera.position);
      const startLookAt = new THREE.Vector3().copy(this.lookAtTarget);

      this.cameraProfile = profile;

      const targetLookAt = new THREE.Vector3().copy(this.lookAtTarget);
      const targetPos = new THREE.Vector3().copy(this.camera.position);

      let targetFov = this.camera.fov;

      if (this.vrm) {
        const dummyCamera = this.camera.clone();
        this.cameraManager.centerAndFrame(
          this.vrm,
          dummyCamera,
          this.controls,
          this.cameraProfile,
          targetLookAt,
          targetPos,
          (c) =>
            this.cameraManager.applyInteractionMode(c, this.interactionMode),
          true, // skipControlUpdate
        );
        targetFov = dummyCamera.fov;
      } else {
        const dummyCamera = this.camera.clone();
        this.cameraManager.applyCameraProfileToCamera(
          dummyCamera,
          this.controls,
          this.cameraProfile,
        );
        targetPos.copy(dummyCamera.position);
        targetFov = dummyCamera.fov;
        // controls.target handles lookAt internally or we just leap
        if (this.controls) {
          // Skipping instant snap of controls.target, we let transition handle it
          targetLookAt.copy(this.controls.target);
        }
      }

      this.startCameraTransition(
        startPos,
        startLookAt,
        startFov,
        targetPos,
        targetLookAt,
        targetFov,
        CAMERA_PROFILE_TRANSITION_DURATION_SECONDS,
      );
    } else {
      this.cameraProfile = profile;
    }
  }
  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    if (width <= 0 || height <= 0) return;
    const aspect = width / height;
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
  getState(): VrmEngineState {
    const idlePlaying = this.idleAction?.isRunning() ?? false;
    return {
      vrmLoaded: this.vrm !== null && this.vrmReady,
      vrmName: this.vrmName,
      loadError: this.lastLoadError,
      idlePlaying,
      idleTime: this.idleAction?.time ?? 0,
      idleTracks: this.idleAction?.getClip()?.tracks.length ?? 0,
      revealStarted: this.revealStarted,
      loadingProgress: this.loadingProgress,
    };
  }
  setMouthOpen(value: number): void {
    this.mouthValue = Math.max(0, Math.min(1, value));
  }
  setSpeaking(speaking: boolean): void {
    if (speaking && !this.speaking) {
      this.speakingStartTime = this.elapsedTime;
    }
    this.speaking = speaking;
  }
  attachOverlayManager(manager: SceneOverlayManager): void {
    this.overlayManager = manager;
    if (this.scene) manager.attach(this.scene);
  }
  getOverlayManager(): SceneOverlayManager | null {
    return this.overlayManager;
  }
  setCameraAnimation(config: Partial<CameraAnimationConfig>): void {
    this.cameraAnimation = { ...this.cameraAnimation, ...config };
  }
  setPointerParallaxEnabled(enabled: boolean): void {
    this.pointerParallaxEnabled = enabled;
    if (!enabled) {
      this.pointerParallaxTarget.set(0, 0);
    }
  }
  setPointerParallaxTarget(x: number, y: number): void {
    this.pointerParallaxTarget.set(
      THREE.MathUtils.clamp(x, -1, 1),
      THREE.MathUtils.clamp(y, -1, 1),
    );
  }
  resetPointerParallax(): void {
    this.pointerParallaxTarget.set(0, 0);
  }
  setDragOrbitTarget(yaw: number, pitch: number): void {
    this.dragOrbitTarget.set(
      THREE.MathUtils.clamp(yaw, -0.6, 0.6),
      THREE.MathUtils.clamp(pitch, -0.35, 0.35),
    );
  }
  resetDragOrbit(): void {
    this.dragOrbitTarget.set(0, 0);
  }
  setCompanionZoomNormalized(value: number): void {
    this.companionZoomTarget = THREE.MathUtils.clamp(value, 0, 1);
  }
  setCameraXOffset(offset: number): void {
    this.cameraXOffsetTarget = THREE.MathUtils.clamp(offset, -3, 3);
    // Map the X offset to an orbital yaw offset (radians).
    // Positive X offset → negative theta (orbit camera to the right so
    // character appears on the left).
    this.cameraYawOffsetTarget = -offset * 0.7;
  }

  async setWorldUrl(_url: string | null): Promise<void> {
    // World backgrounds removed — math environment managed separately.
  }

  /** Switch the mathematical environment theme. */
  setEnvironmentTheme(theme: "light" | "dark"): void {
    this.mathEnvironment?.setTheme(theme);
  }
  async playEmote(
    path: string,
    duration: number,
    loop: boolean,
  ): Promise<void> {
    const vrm = this.vrm;
    const mixer = this.mixer;
    if (!vrm || !mixer) return;
    // Don't start emotes while the teleport dissolve is still running or
    // within a short cooldown afterwards — the idle animation needs time
    // to settle into a stable pose before we can cross-fade from it.
    const POST_TELEPORT_COOLDOWN = 0.3; // seconds
    if (
      this.teleportProgress < 1.0 ||
      this.elapsedTime - this.teleportCompleteTime < POST_TELEPORT_COOLDOWN
    ) {
      return;
    }
    this.clearPendingEmoteCompletion();
    this.emoteRequestId++;
    const requestId = this.emoteRequestId;
    const currentEmote = this.emoteAction;
    const clip = await this.loadEmoteClipCached(path, vrm);
    if (!clip || this.vrm !== vrm || this.mixer !== mixer) return;
    if (this.emoteRequestId !== requestId) return;
    const action = mixer.clipAction(clip);
    action.setLoop(
      loop ? THREE.LoopRepeat : THREE.LoopOnce,
      loop ? Infinity : 1,
    );
    action.clampWhenFinished = !loop;
    const fadeDuration = 0.4;
    // Use explicit fadeOut + fadeIn instead of crossFadeFrom. crossFadeFrom
    // only blends tracks that exist in BOTH clips — emotes exported with
    // non-uniform keyframes (sparse Mixamo optimization) leave body/leg
    // bones without tracks, so idle's tracks for those bones continue at
    // full weight, creating visible overlap. Fading out the source
    // explicitly ensures ALL its tracks fade away cleanly.
    if (currentEmote && currentEmote !== action) {
      currentEmote.fadeOut(fadeDuration);
    }
    if (this.idleAction && this.idleAction !== action) {
      this.idleAction.fadeOut(fadeDuration);
    }
    action.reset();
    this.activateAction(action);
    action.fadeIn(fadeDuration);
    this.emoteAction = action;
    if (!loop) {
      const clipDuration =
        Number.isFinite(duration) && duration > 0 ? duration : clip.duration;
      this.watchOneShotEmoteCompletion(mixer, action, requestId, clipDuration);
    }
  }
  stopEmote(): void {
    this.clearPendingEmoteCompletion();
    const fadeDuration = 0.4;
    const activeEmote = this.emoteAction;
    this.emoteAction = null;
    if (this.idleAction) {
      this.activateAction(this.idleAction);
      if (activeEmote && activeEmote !== this.idleAction) {
        this.idleAction.crossFadeFrom(activeEmote, fadeDuration, false);
      } else {
        this.idleAction.fadeIn(fadeDuration);
      }
      return;
    }
    if (this.vrm && this.mixer) {
      this.restoreIdleAfterEmote(
        activeEmote,
        fadeDuration,
        this.vrm,
        this.mixer,
      );
      return;
    }
    activeEmote?.fadeOut(fadeDuration);
  }

  /** Play a one-shot wave greeting after the VRM becomes visible. */
  playWaveGreeting(): void {
    this.playEmote(
      resolveAppAssetUrl("animations/emotes/greeting.fbx"),
      3,
      false,
    );
  }

  async loadVrmFromUrl(url: string, name?: string): Promise<void> {
    await this.whenReady();
    if (!this.scene) throw new Error("VrmEngine not initialized");
    if (!this.camera) throw new Error("VrmEngine not initialized");
    if (this.loadingAborted) return;
    const requestId = ++this.vrmLoadRequestId;
    const hadPreviousVrm = this.vrm !== null;
    if (this.vrm) {
      if (this.outgoingVrm) {
        this.outgoingVrm.scene.parent?.remove(this.outgoingVrm.scene);
        VRMUtils.deepDispose(this.outgoingVrm.scene);
      }
      this.outgoingVrm = this.vrm;
      this.outgoingMixer = this.mixer;
      this.vrm = null;
      this.vrmReady = false;
      this.vrmName = null;
      this.mixer = null;
      this.idleAction = null;
      this.idleLoadPromise = null;
      this.revealStarted = false;
      this.clearPendingEmoteCompletion();
      this.emoteAction = null;
      this.emoteClipCache.clear();
    }
    this.lastLoadError = null;
    this.loadingProgress = 0;
    this.onUpdate?.();
    const loader = new GLTFLoader();
    configureVrmGltfLoader(loader);
    const webGpuNodes =
      this.rendererBackend === "webgpu"
        ? await import("@pixiv/three-vrm/nodes")
        : null;
    loader.register((parser: VrmLoaderParser) => {
      if (webGpuNodes) {
        const mtoonOptions = {
          materialType: webGpuNodes.MToonNodeMaterial as unknown,
        } as unknown as ConstructorParameters<
          typeof MToonMaterialLoaderPlugin
        >[1];
        const mtoonMaterialPlugin = new MToonMaterialLoaderPlugin(
          parser,
          mtoonOptions,
        );
        return new VRMLoaderPlugin(parser, { mtoonMaterialPlugin });
      }
      return new VRMLoaderPlugin(parser);
    });
    let gltf: Awaited<ReturnType<GLTFLoader["loadAsync"]>>;
    try {
      gltf = await loadGltfAsset(loader, url, (progress) => {
        if (this.vrmLoadRequestId === requestId && !this.loadingAborted) {
          this.loadingProgress = progress;
          this.onUpdate?.();
        }
      });
    } catch (error) {
      if (!this.loadingAborted && requestId === this.vrmLoadRequestId) {
        this.lastLoadError =
          error instanceof Error ? error.message : String(error);
        this.onUpdate?.();
      }
      throw error;
    }
    if (
      this.loadingAborted ||
      !this.scene ||
      requestId !== this.vrmLoadRequestId
    ) {
      const staleVrm = gltf.userData.vrm as VRM | undefined;
      if (staleVrm) VRMUtils.deepDispose(staleVrm.scene);
      return;
    }
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error("Loaded asset is not a VRM");
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    if (this.camera) {
      if (!hadPreviousVrm) {
        this.cameraManager.centerAndFrame(
          vrm,
          this.camera,
          this.controls,
          this.cameraProfile,
          this.lookAtTarget,
          this.baseCameraPosition,
          (c) =>
            this.cameraManager.applyInteractionMode(c, this.interactionMode),
        );
      }
    }
    try {
      VRMUtils.rotateVRM0(vrm);
    } catch {
      /* optional in some versions */
    }
    this.cameraManager.ensureFacingCamera(vrm, this.camera);
    this.configureAvatarLookTracking(vrm);
    if (
      this.loadingAborted ||
      !this.scene ||
      requestId !== this.vrmLoadRequestId
    ) {
      VRMUtils.deepDispose(vrm.scene);
      return;
    }
    vrm.scene.visible = false;
    vrm.scene.traverse((obj: THREE.Object3D) => {
      obj.frustumCulled = false;
    });
    const avatarParent = this.avatarRoot ?? this.scene;
    avatarParent.add(vrm.scene);
    this.vrm = vrm;
    this.vrmName = name ?? null;
    this.lastLoadError = null;
    vrm.springBoneManager?.reset?.();
    this.blinkController.reset();

    try {
      await this.loadAndPlayIdle(vrm);
      if (!this.loadingAborted && this.vrm === vrm) {
        this.vrmReady = true;
        // Let the idle animation settle into a natural pose before revealing
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (this.loadingAborted || this.vrm !== vrm) return;
        await this.playTeleportReveal(vrm);
        vrm.scene.visible = true;
        // Greeting animation is handled by CharacterEditor via vrm-teleport-complete event
      }
    } catch {
      if (!this.loadingAborted && this.vrm === vrm) {
        this.vrmReady = true;
        vrm.scene.visible = true;
        // Teleport animation failed (e.g. WebGPU unavailable) — still notify
        // the app so companion UI (header, chat) becomes visible.
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("eliza:vrm-teleport-complete"));
        }
      }
    }
  }

  private async playTeleportReveal(vrm: VRM): Promise<void> {
    if (this.outgoingVrm && this.camera) {
      this.transitionCameraToFramedAvatar(
        vrm,
        AVATAR_SWITCH_CAMERA_TRANSITION_DURATION_SECONDS,
      );
    }

    this.teleportProgress = 0.0;
    this.cleanupTeleportDissolve();
    let appliedNodeDissolve = false;

    try {
      const tsl = await import("three/tsl");

      const uProgress = tsl.uniform(0.0);
      this.teleportProgressUniform = uProgress;

      const applyTslDissolve = (targetVrm: VRM, isOutgoing: boolean) => {
        targetVrm.scene.traverse((obj: THREE.Object3D) => {
          if (!(obj instanceof THREE.Mesh)) return;
          const mats = Array.isArray(obj.material)
            ? obj.material
            : [obj.material];
          for (const mat of mats) {
            if (!mat.isNodeMaterial || mat.userData._dissolveApplied) continue;
            appliedNodeDissolve = true;
            mat.userData._dissolveApplied = true;
            mat.userData._origOpacityNode = mat.opacityNode ?? null;
            mat.userData._origEmissiveNode =
              (mat as MeshStandardMaterialWithNodeProps).emissiveNode ?? null;
            mat.userData._origAlphaTest = mat.alphaTest;

            const worldY = tsl.positionWorld.y;
            const threshold = uProgress
              .mul(TELEPORT_DISSOLVE_END_Y - TELEPORT_DISSOLVE_START_Y)
              .add(TELEPORT_DISSOLVE_START_Y);
            const diff = worldY.sub(threshold);

            const nx = tsl.sin(
              tsl.positionWorld.x.mul(18.0).add(worldY.mul(12.0)),
            );
            const ny = tsl.cos(
              worldY.mul(15.0).add(tsl.positionWorld.z.mul(10.0)),
            );
            const nz = tsl.sin(
              tsl.positionWorld.z.mul(18.0).add(tsl.positionWorld.x.mul(10.0)),
            );
            const noise = nx.add(ny).add(nz).div(3.0).add(1.0).mul(0.5);
            const ratio = diff.div(0.3).clamp(0.0, 1.0);

            const baseAlpha = tsl.step(ratio, noise);
            const dissolveAlpha = isOutgoing
              ? tsl.float(1.0).sub(baseAlpha)
              : baseAlpha;

            const edgeDist = diff.abs();
            const glowWidth = tsl.float(0.08);
            const glowIntensity = tsl
              .float(1.0)
              .sub(edgeDist.div(glowWidth).clamp(0.0, 1.0));
            const hueShift = tsl.fract(worldY.mul(3.0).add(uProgress.mul(2.0)));
            const holoR = tsl
              .smoothstep(tsl.float(0.3), tsl.float(0.7), hueShift)
              .mul(0.8)
              .add(0.2);
            const holoG = tsl.float(0.9);
            const holoB = tsl
              .smoothstep(tsl.float(0.7), tsl.float(0.3), hueShift)
              .mul(0.8)
              .add(0.2);
            const holoColor = tsl.vec3(holoR, holoG, holoB);

            const glowActive = tsl
              .step(tsl.float(0.001), uProgress)
              .mul(tsl.float(1.0).sub(tsl.step(tsl.float(0.999), uProgress)));
            const emissiveBoost = holoColor.mul(
              glowIntensity.mul(10.0).mul(glowActive).mul(dissolveAlpha),
            );

            const origOpacity = mat.opacityNode as TslNode;
            mat.opacityNode = origOpacity
              ? (origOpacity.mul(dissolveAlpha) ?? dissolveAlpha)
              : dissolveAlpha;

            const matWithEmissive = mat as THREE.Material & {
              emissiveNode?: TslNode;
            };
            const origEmissive = matWithEmissive.emissiveNode;
            matWithEmissive.emissiveNode = origEmissive
              ? origEmissive.add(emissiveBoost)
              : emissiveBoost;

            mat.alphaTest = 0.01;
            mat.needsUpdate = true;
            this.teleportDissolvedMaterials.push(mat);
          }
        });
      };

      applyTslDissolve(vrm, false);
      if (this.outgoingVrm) {
        applyTslDissolve(this.outgoingVrm, true);
      }
    } catch (err) {
      console.warn(
        "[VrmEngine] TSL dissolve unavailable, showing instantly:",
        err,
      );
    }

    if (!appliedNodeDissolve) {
      this.applyTeleportFallbackDissolve(vrm, false);
      if (this.outgoingVrm) {
        this.applyTeleportFallbackDissolve(this.outgoingVrm, true);
      }
    }

    // Force shader compilation by rendering invisible frames before displaying particles
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (typeof window !== "undefined") {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    }

    if (this.loadingAborted || this.vrm !== vrm) return;

    this.revealStarted = true;
    this.startTeleportSparkles(vrm);
  }

  private applyTeleportFallbackDissolve(vrm: VRM, isOutgoing: boolean): void {
    vrm.scene.traverse((obj: THREE.Object3D) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (mat.userData._dissolveApplied) continue;
        mat.userData._dissolveApplied = true;
        mat.userData._origAlphaTest = mat.alphaTest;
        mat.userData._origOnBeforeCompile = mat.onBeforeCompile;
        mat.userData._origCustomProgramCacheKey = mat.customProgramCacheKey;

        const shaderRef = {
          uniforms: { uTeleportProgress: { value: this.teleportProgress } },
          isOutgoing,
        };
        this.teleportFallbackShaders.push(shaderRef);

        mat.alphaTest = Math.max(mat.alphaTest ?? 0, 0.01);
        mat.onBeforeCompile = (shader: {
          uniforms: Record<string, { value: unknown }>;
          vertexShader: string;
          fragmentShader: string;
        }) => {
          shader.uniforms.uTeleportProgress =
            shaderRef.uniforms.uTeleportProgress;
          shader.vertexShader = `
varying vec3 vTeleportWorldPosition;
${shader.vertexShader}
`.replace(
            "#include <project_vertex>",
            `vec4 teleportWorldPosTemp = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
teleportWorldPosTemp = instanceMatrix * teleportWorldPosTemp;
#endif
teleportWorldPosTemp = modelMatrix * teleportWorldPosTemp;
vTeleportWorldPosition = teleportWorldPosTemp.xyz;
#include <project_vertex>`,
          );
          shader.fragmentShader = `
uniform float uTeleportProgress;
varying vec3 vTeleportWorldPosition;
float teleportSmoothNoise(vec3 p) {
  float nx = sin(p.x * 18.0 + p.y * 12.0);
  float ny = cos(p.y * 15.0 + p.z * 10.0);
  float nz = sin(p.z * 18.0 + p.x * 10.0);
  return (nx + ny + nz) / 3.0 * 0.5 + 0.5;
}
${shader.fragmentShader}
`
            .replace(
              "#include <alphatest_fragment>",
              `float teleportThreshold = mix(${TELEPORT_DISSOLVE_START_Y.toFixed(1)}, ${TELEPORT_DISSOLVE_END_Y.toFixed(1)}, uTeleportProgress);
float teleportDiff = vTeleportWorldPosition.y - teleportThreshold;
float teleportRatio = clamp(teleportDiff / 0.3, 0.0, 1.0);
float teleportNoise = teleportSmoothNoise(vTeleportWorldPosition);
${isOutgoing ? "if (teleportNoise >= teleportRatio) discard;" : "if (teleportNoise < teleportRatio) discard;"}
#include <alphatest_fragment>`,
            )
            .replace(
              "#include <emissivemap_fragment>",
              `#include <emissivemap_fragment>
            float teleportGlowDist = abs(teleportDiff);
            float teleportGlowIntensity = 1.0 - clamp(teleportGlowDist / 0.08, 0.0, 1.0);
            vec3 teleportHoloColor = vec3(0.3, 0.9, 0.8);
            float teleportGlowActive = step(0.001, uTeleportProgress) * (1.0 - step(0.999, uTeleportProgress));
            float teleportDissolveAlpha = ${isOutgoing ? "1.0 - step(teleportRatio, teleportNoise)" : "step(teleportRatio, teleportNoise)"};
            totalEmissiveRadiance += teleportHoloColor * (teleportGlowIntensity * 10.0 * teleportGlowActive * teleportDissolveAlpha);`,
            );

          const originalOnBeforeCompile = mat.userData._origOnBeforeCompile;
          if (typeof originalOnBeforeCompile === "function") {
            originalOnBeforeCompile(
              shader,
              this.renderer as THREE.WebGLRenderer,
            );
          }
        };
        const origCacheKey = mat.userData._origCustomProgramCacheKey;
        mat.customProgramCacheKey = () => {
          const baseKey =
            typeof origCacheKey === "function" ? origCacheKey.call(mat) : "";
          return `${baseKey}:${mat.type}:teleport-dissolve-fallback:${isOutgoing ? "out" : "in"}`;
        };
        mat.needsUpdate = true;
        this.teleportDissolvedMaterials.push(mat);
      }
    });
  }

  private startTeleportSparkles(vrm: VRM): void {
    const parent = this.avatarRoot ?? this.scene;
    if (!parent) return;

    this.cleanupTeleportSparkles();

    const bounds = new THREE.Box3().setFromObject(vrm.scene);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const sparkleGroup = new THREE.Group();
    sparkleGroup.position.set(center.x, bounds.min.y + 0.06, center.z);
    parent.add(sparkleGroup);

    const texture = getTeleportSparkleTexture();
    const particleHeight = THREE.MathUtils.clamp(size.y * 0.82, 0.95, 1.75);
    const particles: TeleportSparkleParticle[] = [];

    // Central high-energy flash
    const flashMaterial = new THREE.SpriteMaterial({
      map: texture,
      color: new THREE.Color().setHSL(0.55, 0.95, 0.65),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const flashSprite = new THREE.Sprite(flashMaterial);
    flashSprite.visible = false;
    flashSprite.renderOrder = 9999;
    sparkleGroup.add(flashSprite);
    particles.push({
      sprite: flashSprite,
      material: flashMaterial,
      baseAngle: 0,
      baseRadius: 0,
      height: size.y * 0.5,
      start: 0,
      duration: 0.3,
      spin: 0,
      wobble: 0,
      wobbleSpeed: 0,
      baseSize: 1.8, // Massive size marks it as the central flash
    });

    // Vertical streaks
    for (let index = 0; index < 60; index += 1) {
      const hue = 0.52 + Math.random() * 0.08;
      const material = new THREE.SpriteMaterial({
        map: texture,
        color: new THREE.Color().setHSL(hue, 0.95, 0.8),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 9999;
      sparkleGroup.add(sprite);

      particles.push({
        sprite,
        material,
        baseAngle: Math.random() * Math.PI * 2,
        baseRadius: Math.random() * 0.4 + 0.05,
        height: particleHeight * (1.1 + Math.random() * 0.5),
        start: Math.random() * 0.3, // Fast start
        duration: 0.2 + Math.random() * 0.25, // Snappy duration
        spin: (Math.random() - 0.5) * 0.5,
        wobble: 0,
        wobbleSpeed: 0,
        baseSize: 0.02 + Math.random() * 0.05, // Thin width
      });
    }

    this.teleportSparkles = {
      group: sparkleGroup,
      particles,
    };
    this.updateTeleportSparkles();
  }

  private updateTeleportSparkles(): void {
    const system = this.teleportSparkles;
    if (!system) return;

    const progress = THREE.MathUtils.clamp(this.teleportProgress, 0, 1);
    let anyVisible = false;

    for (const particle of system.particles) {
      const localProgress = THREE.MathUtils.clamp(
        (progress - particle.start) / particle.duration,
        0,
        1,
      );

      if (localProgress <= 0 || localProgress >= 1) {
        particle.material.opacity = 0;
        particle.sprite.visible = false;
        continue;
      }

      anyVisible = true;
      const opacity = Math.sin(localProgress * Math.PI) * 1.5;

      if (particle.baseSize > 1.0) {
        // Central flash
        const scale = particle.baseSize * (1.0 + localProgress * 2.0);
        particle.sprite.position.set(0, particle.height, 0);
        particle.sprite.scale.setScalar(scale);
        particle.sprite.visible = opacity > 0.01;
        particle.material.opacity = Math.min(opacity, 1.0) * 0.45;
      } else {
        // Vertical streaks
        const rise = localProgress ** 1.5;
        const angle = particle.baseAngle + progress * particle.spin;
        const radial = particle.baseRadius * (1.0 + rise * 0.6);
        const x = Math.cos(angle) * radial;
        const z = Math.sin(angle) * radial;
        const y = particle.height * rise;

        const width = particle.baseSize * 0.6;
        const height = particle.baseSize * (8.0 + localProgress * 6.0);

        particle.sprite.position.set(x, y, z);
        particle.sprite.scale.set(width, height, 1);
        particle.sprite.visible = opacity > 0.01;
        particle.material.opacity = Math.min(opacity, 1.0);
      }
    }

    if (!anyVisible && progress >= 1) {
      this.cleanupTeleportSparkles();
    }
  }

  private cleanupTeleportDissolve(): void {
    for (const mat of this.teleportDissolvedMaterials) {
      if (mat.userData._dissolveApplied) {
        if (mat.userData._origOpacityNode !== undefined) {
          (mat as MeshStandardMaterialWithNodeProps).opacityNode =
            mat.userData._origOpacityNode ?? null;
        }
        if (mat.userData._origEmissiveNode !== undefined) {
          (mat as MeshStandardMaterialWithNodeProps).emissiveNode =
            mat.userData._origEmissiveNode ?? null;
        }
        mat.alphaTest = mat.userData._origAlphaTest ?? 0;
        mat.onBeforeCompile =
          mat.userData._origOnBeforeCompile ?? mat.onBeforeCompile;
        mat.customProgramCacheKey =
          mat.userData._origCustomProgramCacheKey ?? mat.customProgramCacheKey;
        delete mat.userData._dissolveApplied;
        delete mat.userData._origOpacityNode;
        delete mat.userData._origEmissiveNode;
        delete mat.userData._origAlphaTest;
        delete mat.userData._origOnBeforeCompile;
        delete mat.userData._origCustomProgramCacheKey;
        mat.needsUpdate = true;
      }
    }
    this.teleportDissolvedMaterials = [];
    this.teleportProgressUniform = null;
    this.teleportFallbackShaders = [];
  }

  private cleanupTeleportSparkles(): void {
    if (!this.teleportSparkles) return;
    for (const particle of this.teleportSparkles.particles) {
      particle.sprite.parent?.remove(particle.sprite);
      particle.material.dispose();
    }
    this.teleportSparkles.group.parent?.remove(this.teleportSparkles.group);
    this.teleportSparkles = null;
  }
  private get animationLoaderContext(): AnimationLoaderContext {
    return {
      isAborted: () => this.loadingAborted,
      isCurrentVrm: (vrm: VRM) => this.vrm === vrm,
    };
  }
  private loop(): void {
    if (this.paused) return;
    this.scheduleNextFrame();
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera) return;

    if (this.halfFramerateMode) {
      if (this.halfFramerateSkipNext) {
        this.halfFramerateSkipNext = false;
        return;
      }
      this.halfFramerateSkipNext = true;
    } else {
      this.halfFramerateSkipNext = false;
    }

    // Reset camera to the pristine tracking base before processing this frame's
    // motion and offsets. This ensures OrbitControls and transitions never see
    // the temporary frame-based dynamic offsets (zoom, yaw, parallax),
    // which prevents them from being doubled or accumulated into the state.
    if (this.baseCameraPosition.lengthSq() > 1e-6) {
      camera.position.copy(this.baseCameraPosition);
    }
    const rawDelta = this.clock.getDelta();
    const stableDelta = Math.min(rawDelta, 1 / 30);
    this.elapsedTime += rawDelta;
    this.mixer?.update(rawDelta);
    this.outgoingMixer?.update(rawDelta);
    if (this.outgoingVrm) {
      this.applyMouthToVrm(this.outgoingVrm);
      this.outgoingVrm.update(stableDelta);
    }
    if (this.vrm) {
      if (this.teleportProgress < 1.0) {
        this.teleportProgress += stableDelta * 2.8; // ~0.35 seconds duration
        if (this.teleportProgress > 1.0) this.teleportProgress = 1.0;

        if (this.teleportProgressUniform) {
          this.teleportProgressUniform.value = this.teleportProgress;
        }
        for (const shader of this.teleportFallbackShaders) {
          shader.uniforms.uTeleportProgress.value = this.teleportProgress;
        }

        if (this.teleportProgress >= 1.0) {
          if (this.outgoingVrm) {
            this.outgoingVrm.scene.parent?.remove(this.outgoingVrm.scene);
            VRMUtils.deepDispose(this.outgoingVrm.scene);
            this.outgoingVrm = null;
            this.outgoingMixer = null;
          }
          this.cleanupTeleportDissolve();
          this.cleanupTeleportSparkles();
          this.teleportCompleteTime = this.elapsedTime;
          // Notify the app that the teleport-in animation has finished
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("eliza:vrm-teleport-complete"),
            );
          }
        }
      }
      this.updateTeleportSparkles();

      this.applyMouthToVrm(this.vrm);
      const blinkValue = this.blinkController.update(rawDelta);
      this.vrm.expressionManager?.setValue("blink", blinkValue);
    }

    // Process camera transition
    if (this.isCameraTransitioning) {
      this.transitionProgress += stableDelta / this.transitionDuration;
      let finished = false;
      if (this.transitionProgress >= 1.0) {
        this.transitionProgress = 1.0;
        this.isCameraTransitioning = false;
        finished = true;
      }

      // Smooth step easing
      const t = this.transitionProgress;
      const ease = t * t * (3.0 - 2.0 * t);

      camera.position.lerpVectors(
        this.transitionStartPos,
        this.transitionTargetPos,
        ease,
      );
      this.baseCameraPosition.copy(camera.position);

      this.lookAtTarget.lerpVectors(
        this.transitionStartLookAt,
        this.transitionTargetLookAt,
        ease,
      );

      camera.fov = THREE.MathUtils.lerp(
        this.transitionStartFov,
        this.transitionTargetFov,
        ease,
      );
      camera.updateProjectionMatrix();

      if (this.controls) {
        this.controls.target.copy(this.lookAtTarget);
        if (finished) {
          this.controls.update(); // Sync once at the very end when bounds match
        }
      }
    }

    const manualCameraActive = this.interactionEnabled;
    if (
      !manualCameraActive &&
      this.cameraAnimation.enabled &&
      this.baseCameraPosition.length() > 0
    ) {
      this.cameraManager.applyCameraMotion(
        camera,
        this.baseCameraPosition,
        this.lookAtTarget,
        this.cameraAnimation,
        this.elapsedTime,
      );
    }
    const dragOrbitFollow = Math.min(1, stableDelta * 9);
    this.dragOrbitCurrent.lerp(this.dragOrbitTarget, dragOrbitFollow);
    if (
      this.dragOrbitCurrent.lengthSq() > 1e-6 &&
      this.baseCameraPosition.lengthSq() > 1e-6
    ) {
      const orbitOffset = this.tempCameraOrbitOffset
        .copy(camera.position)
        .sub(this.lookAtTarget);
      if (orbitOffset.lengthSq() > 1e-6) {
        const spherical = this.tempCameraSpherical.setFromVector3(orbitOffset);
        spherical.theta += this.dragOrbitCurrent.x;
        spherical.phi = THREE.MathUtils.clamp(
          spherical.phi + this.dragOrbitCurrent.y,
          0.2,
          Math.PI - 0.2,
        );
        orbitOffset.setFromSpherical(spherical);
        camera.position.copy(this.lookAtTarget).add(orbitOffset);
      }
    }
    this.applyCompanionZoom(camera, stableDelta);
    // Smoothly lerp camera orbital yaw offset (used by CharacterEditor to
    // rotate around the character so she appears on the left side).
    const editorFollow = Math.min(1, stableDelta * 5);
    this.cameraXOffsetCurrent = THREE.MathUtils.lerp(
      this.cameraXOffsetCurrent,
      this.cameraXOffsetTarget,
      editorFollow,
    );
    this.cameraYawOffsetCurrent = THREE.MathUtils.lerp(
      this.cameraYawOffsetCurrent,
      this.cameraYawOffsetTarget,
      editorFollow,
    );
    // Scale offset by inverse zoom: more shift when zoomed out, less when in
    const zoomScale = 1 - this.companionZoomCurrent * 0.8;
    if (Math.abs(this.cameraYawOffsetCurrent) > 1e-5) {
      const orbitVec = this.tempCameraOrbitOffset
        .copy(camera.position)
        .sub(this.lookAtTarget);
      if (orbitVec.lengthSq() > 1e-6) {
        const sph = this.tempCameraSpherical.setFromVector3(orbitVec);
        sph.theta += this.cameraYawOffsetCurrent * zoomScale;
        orbitVec.setFromSpherical(sph);
        camera.position.copy(this.lookAtTarget).add(orbitVec);
      }
    }
    // Also translate camera on X for the positional shift
    const scaledXOffset = this.cameraXOffsetCurrent * zoomScale;
    if (Math.abs(scaledXOffset) > 1e-4) {
      camera.position.x += scaledXOffset;
    }
    if (this.pointerParallaxEnabled) {
      const follow = Math.min(1, stableDelta * 7.5);
      this.pointerParallaxCurrent.lerp(this.pointerParallaxTarget, follow);
      this.pointerParallaxPosition.set(
        this.pointerParallaxCurrent.x * 0.18,
        this.pointerParallaxCurrent.y * 0.12,
        0,
      );
      camera.position.add(this.pointerParallaxPosition);
      this.pointerParallaxLookAt
        .copy(this.lookAtTarget)
        .add(
          new THREE.Vector3(
            this.pointerParallaxCurrent.x * 0.08 + scaledXOffset,
            this.pointerParallaxCurrent.y * 0.05,
            0,
          ),
        );
    } else {
      this.pointerParallaxCurrent.lerp(this.pointerParallaxTarget, 0.12);
      this.pointerParallaxLookAt.copy(this.lookAtTarget);
      if (Math.abs(scaledXOffset) > 1e-4) {
        this.pointerParallaxLookAt.x += scaledXOffset;
      }
    }
    if (this.controls) {
      if (manualCameraActive && !this.isCameraTransitioning) {
        this.controls.update();
        this.lookAtTarget.copy(this.controls.target);
        // Track the manual move in our clean base position
        this.baseCameraPosition.copy(camera.position);
      } else if (!this.isCameraTransitioning) {
        this.controls.target.copy(this.lookAtTarget);
      }
    }
    if (!manualCameraActive || this.isCameraTransitioning) {
      camera.lookAt(this.pointerParallaxLookAt);
    }
    if (this.vrm) {
      this.updateAvatarLookTarget(camera, stableDelta);
      this.vrm.update(stableDelta);
      this.applyAvatarHeadTracking(camera, stableDelta);
      this.refreshAvatarEyeTracking();
    }
    this.mathEnvironment?.update(stableDelta, camera);
    this.overlayManager?.update(camera, stableDelta);
    renderer.render(scene, camera);
    this.onUpdate?.();
  }
  private async loadAndPlayIdle(vrm: VRM): Promise<void> {
    if (this.loadingAborted) return;
    const mixer = this.mixer ?? new THREE.AnimationMixer(vrm.scene);
    this.mixer = mixer;
    const action = await this.ensureIdleAction(vrm, mixer);
    if (!action) return;
    action.fadeIn(0.25);
    action.play();
    mixer.update(1 / 60);
  }
  private async loadEmoteClipCached(
    path: string,
    vrm: VRM,
  ): Promise<THREE.AnimationClip | null> {
    const cached = this.emoteClipCache.get(path);
    if (cached) return cached;
    const clip = await loadEmoteClip(path, vrm, this.animationLoaderContext);
    if (clip) {
      this.emoteClipCache.set(path, clip);
    }
    return clip;
  }
  private applyMouthToVrm(vrm: VRM): void {
    const manager = vrm.expressionManager;
    if (!manager) return;
    let target: number;
    if (this.speaking) {
      const elapsed = this.elapsedTime - this.speakingStartTime;
      const base = Math.sin(elapsed * 12) * 0.3 + 0.4;
      const detail = Math.sin(elapsed * 18.7) * 0.15;
      const slow = Math.sin(elapsed * 4.2) * 0.1;
      target = Math.max(0, Math.min(1, base + detail + slow));
    } else {
      target = this.mouthValue;
    }
    const next = Math.max(0, Math.min(1, target));
    const alpha = next > this.mouthSmoothed ? 0.3 : 0.2;
    this.mouthSmoothed = this.mouthSmoothed * (1 - alpha) + next * alpha;
    manager.setValue("aa", this.mouthSmoothed);
  }

  /**
   * Capture a single-frame snapshot of the current VRM as a PNG Blob.
   *
   * When `disablePhysics` is true (the default), spring bone simulation is
   * frozen for the capture frame so hair and cloth render in their rest pose,
   * then restored afterwards. The render loop is paused during capture to
   * prevent physics from re-running between reset and canvas capture.
   */
  async snapshot(options?: {
    width?: number;
    height?: number;
    disablePhysics?: boolean;
  }): Promise<Blob | null> {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera) return null;

    const canvas = renderer.domElement as HTMLCanvasElement;
    if (!canvas) return null;

    const disablePhysics = options?.disablePhysics ?? true;
    const width = options?.width ?? canvas.width;
    const height = options?.height ?? canvas.height;

    // Pause the render loop so physics doesn't re-run between reset and capture
    const wasPaused = this.paused;
    this.setPaused(true);
    // Cancel any pending animation frame to ensure the loop truly stops
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Reset spring bones to rest pose (hair/cloth at initial position)
    const springBoneManager = this.vrm?.springBoneManager ?? null;
    if (disablePhysics && springBoneManager) {
      springBoneManager.reset?.();
    }

    // Resize renderer for the capture resolution
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    // Update VRM transforms without physics
    if (this.vrm) {
      if (disablePhysics && springBoneManager) {
        // Update only the humanoid/expression without spring bones
        this.vrm.humanoid?.update?.();
        this.vrm.expressionManager?.update?.();
      } else {
        this.vrm.update(0);
      }
    }

    // Render the frame (synchronous — captures immediately to canvas)
    renderer.render(scene, camera);

    // Capture the canvas
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png");
    });

    // Restore drawing buffer + DPR policy (matches normal display, including
    // low-power cap) instead of raw `devicePixelRatio` alone.
    this.applyRendererPixelRatio();

    // Restore paused state — resume the render loop
    this.setPaused(wasPaused);

    return blob;
  }
}
