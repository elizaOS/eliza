import { resolveAppAssetUrl } from "@elizaos/app-core/utils";
import {
  MToonMaterialLoaderPlugin,
  type VRM,
  VRMLoaderPlugin,
  VRMUtils,
} from "@pixiv/three-vrm";
import type {
  SparkRenderer as SparkRendererType,
  SplatMesh as SparkSplatMesh,
} from "@sparkjsdev/spark";
import * as THREE from "three";

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
  worldUrl: string | null;
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
  world: {
    loaded: boolean;
    parentName: string | null;
    position: DebugVector3 | null;
    scale: DebugVector3 | null;
    bounds: DebugBounds | null;
    rawBounds: DebugBounds | null;
  };
  spark: {
    attached: boolean;
    parentName: string | null;
    renderOrder: number | null;
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
};

type TeleportFallbackShader = {
  uniforms: {
    uTeleportProgress: { value: number };
  };
};

type WorldRevealController = {
  mesh: SparkSplatMesh;
  progressUniform: { value: number };
  mode: "reveal" | "hide";
  radius: number;
};

type WorldRevealState = {
  controller: WorldRevealController;
  incoming: WorldRevealController;
  outgoing: WorldRevealController | null;
  progress: number;
  duration: number;
  waitingForVrm: boolean;
  syncToTeleport: boolean;
};

type TeleportSparkleParticle = {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  baseAngle: number;
  baseRadius: number;
  height: number;
  start: number;
  duration: number;
  spin: number;
  wobble: number;
  wobbleSpeed: number;
  baseSize: number;
};

type TeleportSparkleSystem = {
  group: THREE.Group;
  particles: TeleportSparkleParticle[];
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
const COMPANION_WORLD_SCALE = 2.5;
const COMPANION_DARK_WORLD_FLOOR_OFFSET_Y = -0.95;
const COMPANION_LIGHT_WORLD_FLOOR_OFFSET_Y = -0.35;
const COMPANION_WORLD_REVEAL_DURATION = 5.4;
const COMPANION_WORLD_REVEAL_EDGE = 0.28;
const COMPANION_WORLD_REVEAL_EASE_EXPONENT = 2;
const COMPANION_WORLD_REVEAL_START_OFFSET = 0.7;
const TELEPORT_DISSOLVE_START_Y = -1.2;
const TELEPORT_DISSOLVE_END_Y = 1.0;
const TELEPORT_SPARKLE_PARTICLE_COUNT = 28;
const TELEPORT_SPARKLE_RING_RADIUS = 0.52;
const TELEPORT_SPARKLE_MIN_SIZE = 0.055;
const TELEPORT_SPARKLE_MAX_SIZE = 0.13;
const COMPANION_DOF_APERTURE_SIZE = 0.028;
const COMPANION_DOF_NEAR_ZOOM_APERTURE_FACTOR = 0.4;
const COMPANION_ZOOM_NEAR_FACTOR = 0.25;
const COMPANION_ZOOM_MIN_RADIUS = 1.2;
const SPARK_CLIP_XY = 1.08;
const SPARK_MAX_STD_DEV = 2.35;
const SPARK_MAX_STD_DEV_NEAR = 1.9;
const SPARK_MIN_ALPHA = 0.0016;
const SPARK_MIN_ALPHA_NEAR = 0.0024;
const SPARK_SORT_DISTANCE = 0.035;
const SPARK_SORT_DISTANCE_NEAR = 0.05;
const SPARK_MAX_PIXEL_RADIUS = 96;
const SPARK_MAX_PIXEL_RADIUS_NEAR = 28;
const MAX_RENDERER_PIXEL_RATIO = 2;
const AVATAR_RENDERER_OVERRIDE_KEY = "eliza.avatarRenderer";
const KNOWN_VRM_WEBGPU_WARNING =
  'TSL: "transformedNormalView" is deprecated. Use "normalView" instead.';

let knownVrmWebGpuWarningFilterRefs = 0;
let releaseKnownVrmWebGpuWarningFilterGlobal: (() => void) | null = null;
let sharedDracoLoader: DRACOLoader | null = null;
let teleportSparkleTexture: THREE.CanvasTexture | null = null;
const DRACO_DECODER_PATH = resolveAppAssetUrl("vrm-decoders/draco/");

function getRendererPixelRatio(sparkOptimized = false): number {
  if (typeof window === "undefined") return 1;
  if (sparkOptimized) return 1;
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

function getSharedDracoLoader(): DRACOLoader {
  if (!sharedDracoLoader) {
    sharedDracoLoader = new DRACOLoader();
    sharedDracoLoader.setDecoderConfig({ type: "wasm" });
    sharedDracoLoader.setDecoderPath(DRACO_DECODER_PATH);
    sharedDracoLoader.preload();
  }
  return sharedDracoLoader;
}

function configureVrmGltfLoader(loader: GLTFLoader): void {
  loader.setMeshoptDecoder(MeshoptDecoder);
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

function quantileSorted(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.floor((values.length - 1) * percentile)),
  );
  return values[index] ?? 0;
}

function getRobustPackedSplatAnchor(splatSource: {
  numSplats?: number;
  forEachSplat: SparkSplatMesh["forEachSplat"];
}): THREE.Vector3 {
  const maxSamples = 4096;
  const xSamples: number[] = [];
  const ySamples: number[] = [];
  const zSamples: number[] = [];
  const splatCount = splatSource.numSplats ?? maxSamples;
  const sampleStep =
    splatCount > maxSamples
      ? Math.max(1, Math.floor(splatCount / maxSamples))
      : 1;

  splatSource.forEachSplat((index, center) => {
    if (sampleStep > 1 && index % sampleStep !== 0) return;
    xSamples.push(center.x);
    ySamples.push(center.y);
    zSamples.push(center.z);
  });

  if (xSamples.length === 0) {
    return new THREE.Vector3(0, 0, 0);
  }

  xSamples.sort((a, b) => a - b);
  ySamples.sort((a, b) => a - b);
  zSamples.sort((a, b) => a - b);

  return new THREE.Vector3(
    quantileSorted(xSamples, 0.5),
    quantileSorted(ySamples, 0.05),
    quantileSorted(zSamples, 0.5),
  );
}

/** SparkSplatMesh may have packedSplats; types not fully exported from @sparkjsdev/spark. */
interface SparkSplatWithPacked {
  packedSplats?: { numSplats?: number };
}

function getRobustSplatAnchor(splat: SparkSplatMesh): THREE.Vector3 {
  return getRobustPackedSplatAnchor({
    numSplats: (splat as SparkSplatWithPacked).packedSplats?.numSplats,
    forEachSplat: splat.forEachSplat.bind(splat),
  });
}

function getRobustPackedSplatRadialExtent(
  splatSource: {
    numSplats?: number;
    forEachSplat: SparkSplatMesh["forEachSplat"];
  },
  anchor: THREE.Vector3,
): number {
  const maxSamples = 4096;
  const radialSamples: number[] = [];
  const splatCount = splatSource.numSplats ?? maxSamples;
  const sampleStep =
    splatCount > maxSamples
      ? Math.max(1, Math.floor(splatCount / maxSamples))
      : 1;

  splatSource.forEachSplat((index, center) => {
    if (sampleStep > 1 && index % sampleStep !== 0) return;
    radialSamples.push(Math.hypot(center.x - anchor.x, center.z - anchor.z));
  });

  if (radialSamples.length === 0) {
    return 1;
  }

  radialSamples.sort((a, b) => a - b);
  return Math.max(1, quantileSorted(radialSamples, 0.985));
}

function getRobustSplatRadialExtent(
  splat: SparkSplatMesh,
  anchor: THREE.Vector3,
): number {
  return getRobustPackedSplatRadialExtent(
    {
      numSplats: (splat as SparkSplatWithPacked).packedSplats?.numSplats,
      forEachSplat: splat.forEachSplat.bind(splat),
    },
    anchor,
  );
}

function getCompanionWorldFloorOffsetY(url: string): number {
  const normalizedUrl = url.toLowerCase();
  return normalizedUrl.includes("night") ||
    normalizedUrl.includes("dark") ||
    normalizedUrl.includes("lunarpunk")
    ? COMPANION_DARK_WORLD_FLOOR_OFFSET_Y
    : COMPANION_LIGHT_WORLD_FLOOR_OFFSET_Y;
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

async function loadGltfAsset(
  loader: GLTFLoader,
  url: string,
  onProgress?: (progress: number) => void,
): Promise<Awaited<ReturnType<GLTFLoader["loadAsync"]>>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch VRM asset: ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);

  let buffer: ArrayBuffer;
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

  if (!isGzipBuffer(buffer)) {
    const objectUrl = URL.createObjectURL(
      new Blob([buffer], { type: "model/gltf-binary" }),
    );
    try {
      return await loader.loadAsync(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  buffer = await decompressGzipBuffer(buffer);
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
 * Create the best available renderer for the current platform.
 * Electrobun's CEF desktop shell expects WebGPU for the avatar stage, while the
 * browser dev shell stays on WebGL by default to avoid upstream TSL noise.
 * A localStorage override can force either backend for debugging.
 * THREE.WebGPURenderer is async-init and requires await renderer.init().
 */
async function createRenderer(
  canvas: HTMLCanvasElement,
  preference: RendererPreference = "auto",
  sparkOptimized = false,
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
        antialias: !sparkOptimized,
      }) as RendererLike & { init?: () => Promise<unknown> };
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
    antialias: !sparkOptimized,
    powerPreference: sparkOptimized ? "high-performance" : "default",
  }) as RendererLike;
  console.info("[VrmEngine] Using WebGLRenderer");
  return { backend: "webgl", renderer };
}

export class VrmEngine {
  private static sparkModulePromise: Promise<
    typeof import("@sparkjsdev/spark")
  > | null = null;
  private renderer: RendererLike | null = null;
  private rendererBackend: RendererBackend = "webgl";
  private rendererPreference: RendererPreference = "auto";
  private scene: THREE.Scene | null = null;
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
  private teleportProgressUniform: { value: number } | null = null;
  private teleportDissolvedMaterials: THREE.Material[] = [];
  private teleportFallbackShaders: TeleportFallbackShader[] = [];
  private teleportSparkles: TeleportSparkleSystem | null = null;
  private revealStarted = false;
  private mouthValue = 0;
  private mouthSmoothed = 0;
  private vrmName: string | null = null;
  private lookAtTarget = new THREE.Vector3(0, 0.5, 0);
  private readonly idleGlbUrl = resolveAppAssetUrl("animations/idle.glb.gz");
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
  private paused = false;
  private interactionEnabled = false;
  private interactionMode: InteractionMode = "free";
  private cameraProfile: CameraProfile = "chat";
  private worldUrl: string | null = null;
  private worldMesh: SparkSplatMesh | null = null;
  private worldReveal: WorldRevealState | null = null;
  private sparkRenderer: SparkRendererType | null = null;
  private worldLoadRequestId = 0;
  private pointerParallaxEnabled = false;
  private pointerParallaxTarget = new THREE.Vector2();
  private pointerParallaxCurrent = new THREE.Vector2();
  private pointerParallaxPosition = new THREE.Vector3();
  private pointerParallaxLookAt = new THREE.Vector3();
  private dragOrbitTarget = new THREE.Vector2();
  private dragOrbitCurrent = new THREE.Vector2();
  private companionZoomTarget = 0;
  private companionZoomCurrent = 0;
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

  private playActionWithBlend(
    action: THREE.AnimationAction,
    fromAction: THREE.AnimationAction | null,
    fadeDuration: number,
  ): void {
    action.reset();
    this.activateAction(action);
    if (fromAction && fromAction !== action) {
      this.activateAction(fromAction);
      action.crossFadeFrom(fromAction, fadeDuration, false);
      return;
    }
    action.fadeIn(fadeDuration);
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
    if (this.camera) {
      this.baseCameraPosition.copy(this.camera.position);
    }
    if (this.controls) {
      this.lookAtTarget.copy(this.controls.target);
    }
  };

  private scheduleNextFrame(): void {
    if (!this.initialized || this.paused || this.animationFrameId !== null) {
      return;
    }
    this.animationFrameId = requestAnimationFrame(() => {
      this.animationFrameId = null;
      this.loop();
    });
  }

  private stopLoop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.clock.stop();
  }

  private resumeLoop(): void {
    if (!this.initialized || this.paused) return;
    this.clock.start();
    this.scheduleNextFrame();
  }

  private async loadSparkModule(): Promise<typeof import("@sparkjsdev/spark")> {
    if (!VrmEngine.sparkModulePromise) {
      VrmEngine.sparkModulePromise = import("@sparkjsdev/spark");
    }
    return VrmEngine.sparkModulePromise;
  }

  private async ensureSparkRenderer(): Promise<void> {
    if (this.sparkRenderer || this.rendererBackend !== "webgl") return;
    if (!this.scene || !this.renderer) return;

    const { SparkRenderer } = await this.loadSparkModule();
    // Re-check after async import — the engine may have been disposed during
    // the await (e.g. React StrictMode double-mount).
    if (!this.scene || !this.renderer) return;
    const sparkRenderer = new SparkRenderer({
      renderer: this.renderer as THREE.WebGLRenderer,
      apertureAngle: 0.0,
      focalDistance: 5.0,
      originDistance: 1,
      clipXY: SPARK_CLIP_XY,
      maxStdDev: SPARK_MAX_STD_DEV,
      maxPixelRadius: SPARK_MAX_PIXEL_RADIUS,
      minAlpha: SPARK_MIN_ALPHA,
      view: {
        depthBias: 1,
        sortDistance: SPARK_SORT_DISTANCE,
        sortRadial: true,
        sort360: false,
      },
    });
    sparkRenderer.renderOrder = 9998;
    this.scene.add(sparkRenderer);
    this.sparkRenderer = sparkRenderer;
  }

  private updateSparkPerformanceProfile(): void {
    const sparkRenderer = this.sparkRenderer;
    if (!sparkRenderer) return;
    if (!this.worldMesh) {
      sparkRenderer.maxPixelRadius = SPARK_MAX_PIXEL_RADIUS;
      sparkRenderer.maxStdDev = SPARK_MAX_STD_DEV;
      sparkRenderer.minAlpha = SPARK_MIN_ALPHA;
      sparkRenderer.clipXY = SPARK_CLIP_XY;
      sparkRenderer.defaultView.sortDistance = SPARK_SORT_DISTANCE;
      return;
    }
    const isCompanionProfile =
      this.cameraProfile === "companion" ||
      this.cameraProfile === "companion_close";
    const closeZoomFactor = isCompanionProfile
      ? THREE.MathUtils.smoothstep(this.companionZoomCurrent, 0.3, 1)
      : 0;

    sparkRenderer.maxPixelRadius = THREE.MathUtils.lerp(
      SPARK_MAX_PIXEL_RADIUS,
      SPARK_MAX_PIXEL_RADIUS_NEAR,
      closeZoomFactor,
    );
    sparkRenderer.maxStdDev = THREE.MathUtils.lerp(
      SPARK_MAX_STD_DEV,
      SPARK_MAX_STD_DEV_NEAR,
      closeZoomFactor,
    );
    sparkRenderer.minAlpha = THREE.MathUtils.lerp(
      SPARK_MIN_ALPHA,
      SPARK_MIN_ALPHA_NEAR,
      closeZoomFactor,
    );
    sparkRenderer.clipXY = THREE.MathUtils.lerp(
      SPARK_CLIP_XY,
      1.03,
      closeZoomFactor,
    );
    sparkRenderer.defaultView.sortDistance = THREE.MathUtils.lerp(
      SPARK_SORT_DISTANCE,
      SPARK_SORT_DISTANCE_NEAR,
      closeZoomFactor,
    );
  }

  private createWorldRevealController(
    spark: typeof import("@sparkjsdev/spark"),
    mesh: SparkSplatMesh,
    reveal: { origin: THREE.Vector3; radius: number },
    mode: "reveal" | "hide",
  ): WorldRevealController | null {
    const dyno = (
      "dyno" in spark ? Reflect.get(spark as object, "dyno") : undefined
    ) as
      | {
          Gsplat: unknown;
          dynoBlock: (
            inTypes: Record<string, unknown>,
            outTypes: Record<string, unknown>,
            construct: (
              inputs: Record<string, unknown>,
            ) => Record<string, unknown>,
          ) => unknown;
          dynoFloat: (value?: number, key?: string) => { value: number };
          dynoVec3: (
            value?: THREE.Vector3,
            key?: string,
          ) => { value: THREE.Vector3 };
          dynoConst: (type: string, value: number) => unknown;
          splitGsplat: (gsplat: unknown) => {
            outputs: {
              center: unknown;
              scales: unknown;
              rgb: unknown;
              opacity: unknown;
            };
          };
          combineGsplat: (value: Record<string, unknown>) => unknown;
          add: (a: unknown, b: unknown) => unknown;
          sub: (a: unknown, b: unknown) => unknown;
          mul: (a: unknown, b: unknown) => unknown;
          div: (a: unknown, b: unknown) => unknown;
          abs: (a: unknown) => unknown;
          clamp: (a: unknown, min: unknown, max: unknown) => unknown;
          max: (a: unknown, b: unknown) => unknown;
          mix: (a: unknown, b: unknown, t: unknown) => unknown;
          smoothstep: (edge0: unknown, edge1: unknown, x: unknown) => unknown;
          pow: (a: unknown, b: unknown) => unknown;
          length: (a: unknown) => unknown;
          swizzle: (a: unknown, select: string) => unknown;
        }
      | undefined;
    if (
      !dyno?.Gsplat ||
      !dyno.dynoBlock ||
      !dyno.dynoFloat ||
      !dyno.dynoVec3 ||
      !dyno.dynoConst ||
      !dyno.splitGsplat ||
      !dyno.combineGsplat ||
      !dyno.add ||
      !dyno.sub ||
      !dyno.mul ||
      !dyno.div ||
      !dyno.abs ||
      !dyno.clamp ||
      !dyno.max ||
      !dyno.mix ||
      !dyno.smoothstep ||
      !dyno.pow ||
      !dyno.length ||
      !dyno.swizzle
    ) {
      return null;
    }

    const originUniform = dyno.dynoVec3(reveal.origin, "uWorldRevealOrigin");
    const resolvedRadius = Math.max(
      reveal.radius,
      COMPANION_WORLD_REVEAL_EDGE * 2,
    );
    const radiusUniform = dyno.dynoFloat(resolvedRadius, "uWorldRevealRadius");
    const edgeUniform = dyno.dynoFloat(
      COMPANION_WORLD_REVEAL_EDGE,
      "uWorldRevealEdge",
    );
    const progressUniform = dyno.dynoFloat(0, "uWorldRevealProgress");
    const wireScaleUniform = dyno.dynoVec3(
      new THREE.Vector3(0.004, 0.004, 0.004),
      "uWorldRevealWireScale",
    );
    const wireAlphaUniform = dyno.dynoFloat(0.42, "uWorldRevealWireAlpha");
    const wireBoostUniform = dyno.dynoFloat(0.3, "uWorldRevealWireBoost");
    const zero = dyno.dynoConst("float", 0);
    const one = dyno.dynoConst("float", 1);
    const two = dyno.dynoConst("float", 2);
    const startOffset = dyno.dynoConst(
      "float",
      -COMPANION_WORLD_REVEAL_START_OFFSET,
    );

    const modifier = dyno.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }) => {
        if (!gsplat) {
          throw new Error("Missing gsplat input for world reveal");
        }
        const { center, scales, rgb, opacity } =
          dyno.splitGsplat(gsplat).outputs;
        const radialDistance = dyno.length(
          dyno.swizzle(dyno.sub(center, originUniform), "xz"),
        );
        const currentRadius = dyno.add(
          dyno.mul(radiusUniform, progressUniform),
          startOffset,
        );
        const bodyMask = dyno.sub(
          one,
          dyno.smoothstep(
            dyno.sub(currentRadius, edgeUniform),
            dyno.add(currentRadius, edgeUniform),
            radialDistance,
          ),
        );
        const ringDistance = dyno.abs(dyno.sub(radialDistance, currentRadius));
        const ringMask = dyno.pow(
          dyno.sub(
            one,
            dyno.smoothstep(zero, dyno.mul(edgeUniform, two), ringDistance),
          ),
          two,
        );
        const visibleMask =
          mode === "hide" ? dyno.sub(one, bodyMask) : bodyMask;
        const wireFactor = dyno.clamp(
          dyno.max(visibleMask, dyno.mul(ringMask, wireAlphaUniform)),
          zero,
          one,
        );
        const brightenedRgb = dyno.mul(
          rgb,
          dyno.add(one, dyno.mul(ringMask, wireBoostUniform)),
        );
        return {
          gsplat: dyno.combineGsplat({
            gsplat,
            scales: dyno.mix(wireScaleUniform, scales, wireFactor),
            rgb: dyno.mix(brightenedRgb, rgb, visibleMask),
            opacity: dyno.mul(opacity, wireFactor),
          }),
        };
      },
    );

    mesh.objectModifier = modifier as SparkSplatMesh["objectModifier"];
    this.refreshSplatMesh(mesh);

    return {
      mesh,
      progressUniform,
      mode,
      radius: resolvedRadius,
    };
  }

  private refreshSplatMesh(mesh: SparkSplatMesh): void {
    mesh.updateGenerator();
    const refreshableMesh = mesh as SparkSplatMesh & {
      updateVersion?: () => void;
    };
    refreshableMesh.updateVersion?.();
  }

  private setWorldRevealProgress(
    controller: WorldRevealController,
    progress: number,
  ): void {
    controller.progressUniform.value = THREE.MathUtils.clamp(progress, 0, 1);
    const refreshableMesh = controller.mesh as SparkSplatMesh & {
      updateVersion?: () => void;
    };
    refreshableMesh.updateVersion?.();
  }

  private queueWorldReveal(
    incoming: WorldRevealController,
    options: {
      outgoing?: WorldRevealController | null;
      duration?: number;
      waitingForVrm?: boolean;
      syncToTeleport?: boolean;
      initialProgress?: number;
    } = {},
  ): void {
    const reveal: WorldRevealState = {
      controller: incoming,
      incoming,
      outgoing: options.outgoing ?? null,
      progress: THREE.MathUtils.clamp(options.initialProgress ?? 0, 0, 1),
      duration: options.duration ?? COMPANION_WORLD_REVEAL_DURATION,
      waitingForVrm: options.waitingForVrm ?? false,
      syncToTeleport: options.syncToTeleport ?? false,
    };
    incoming.mesh.opacity = 1;
    if (reveal.outgoing) {
      reveal.outgoing.mesh.opacity = 1;
    }
    this.worldReveal = reveal;
    this.setWorldRevealProgress(incoming, reveal.progress);
    if (reveal.outgoing) {
      this.setWorldRevealProgress(reveal.outgoing, reveal.progress);
    }
  }

  private disposeSplatMesh(mesh: SparkSplatMesh | null): void {
    if (!mesh) return;
    mesh.parent?.remove(mesh);
    mesh.dispose();
  }

  private completeWorldReveal(reveal: WorldRevealState): void {
    this.setWorldRevealProgress(reveal.incoming, 1);
    reveal.incoming.mesh.opacity = 1;
    reveal.incoming.mesh.objectModifier = undefined;
    this.refreshSplatMesh(reveal.incoming.mesh);
    if (reveal.outgoing) {
      reveal.outgoing.mesh.objectModifier = undefined;
      this.disposeSplatMesh(reveal.outgoing.mesh);
    }
    if (this.worldReveal === reveal) {
      this.worldReveal = null;
    }
  }

  private cancelWorldReveal(): void {
    if (!this.worldReveal) return;
    this.completeWorldReveal(this.worldReveal);
  }

  private startPendingWorldReveal(syncToTeleport: boolean): void {
    const reveal = this.worldReveal;
    if (!reveal || !reveal.waitingForVrm) return;
    reveal.waitingForVrm = false;
    reveal.syncToTeleport = syncToTeleport;
    reveal.progress = syncToTeleport ? this.teleportProgress : 0;
    this.setWorldRevealProgress(reveal.incoming, reveal.progress);
    if (reveal.outgoing) {
      this.setWorldRevealProgress(reveal.outgoing, reveal.progress);
    }
  }

  private updateWorldReveal(stableDelta: number): void {
    const reveal = this.worldReveal;
    if (!reveal || reveal.waitingForVrm) return;
    const avatarRevealActive =
      this.revealStarted && this.teleportProgress < 0.999;

    const nextProgress =
      reveal.syncToTeleport && avatarRevealActive
        ? this.teleportProgress
        : Math.min(1, reveal.progress + stableDelta / reveal.duration);
    const appliedProgress =
      reveal.syncToTeleport && avatarRevealActive
        ? nextProgress
        : nextProgress ** COMPANION_WORLD_REVEAL_EASE_EXPONENT;

    reveal.progress = nextProgress;
    this.setWorldRevealProgress(reveal.incoming, appliedProgress);
    if (reveal.outgoing) {
      this.setWorldRevealProgress(reveal.outgoing, appliedProgress);
    }

    if (nextProgress >= 1) {
      this.completeWorldReveal(reveal);
    }
  }

  private updateSparkDepthOfField(camera: THREE.PerspectiveCamera): void {
    const sparkRenderer = this.sparkRenderer;
    if (!sparkRenderer) return;
    if (!this.worldMesh) {
      sparkRenderer.apertureAngle = 0;
      return;
    }

    const focalDistance = Math.max(
      0.5,
      camera.position.distanceTo(this.pointerParallaxLookAt),
    );
    const isCompanionProfile =
      this.cameraProfile === "companion" ||
      this.cameraProfile === "companion_close";
    const closeZoomFactor = isCompanionProfile
      ? THREE.MathUtils.smoothstep(this.companionZoomCurrent, 0.3, 1)
      : 0;
    const apertureSize = THREE.MathUtils.lerp(
      COMPANION_DOF_APERTURE_SIZE,
      COMPANION_DOF_APERTURE_SIZE * COMPANION_DOF_NEAR_ZOOM_APERTURE_FACTOR,
      closeZoomFactor,
    );
    sparkRenderer.focalDistance = focalDistance;
    sparkRenderer.apertureAngle =
      2 * Math.atan((0.5 * apertureSize) / sparkRenderer.focalDistance);
  }

  private applyCompanionZoom(
    camera: THREE.PerspectiveCamera,
    stableDelta: number,
  ): void {
    const isCompanionProfile =
      this.cameraProfile === "companion" ||
      this.cameraProfile === "companion_close";
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
    const lookAtState = vrm.lookAt as
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
      if (
        !bone ||
        !bone.quaternion ||
        typeof bone.quaternion.clone !== "function"
      ) {
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
    this.worldMesh?.updateMatrixWorld(true);

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
      worldUrl: this.worldUrl,
      sceneChildren:
        this.scene?.children.map((child) => child.name || child.type) ?? [],
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
      world: {
        loaded: this.worldMesh !== null,
        parentName: this.worldMesh?.parent?.name ?? null,
        position: this.toDebugVector3(this.worldMesh?.position ?? null),
        scale: this.toDebugVector3(this.worldMesh?.scale ?? null),
        bounds: this.toDebugBounds(this.worldMesh ?? null),
        rawBounds: this.worldMesh
          ? this.toDebugBoundsFromBox(this.worldMesh.getBoundingBox(true))
          : null,
      },
      spark: {
        attached: this.sparkRenderer !== null,
        parentName: this.sparkRenderer?.parent?.name ?? null,
        renderOrder: this.sparkRenderer?.renderOrder ?? null,
      },
    };
  }

  setDebugAvatarVisible(visible: boolean): void {
    if (!this.vrm) return;
    this.vrm.scene.visible = visible;
  }

  setDebugWorldPosition(x: number, y: number, z: number): void {
    if (!this.worldMesh) return;
    this.worldMesh.position.set(x, y, z);
  }

  setDebugWorldQuaternion(x: number, y: number, z: number, w: number): void {
    if (!this.worldMesh) return;
    this.worldMesh.quaternion.set(x, y, z, w);
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

    const startPos = new THREE.Vector3().copy(this.camera.position);
    const startLookAt = new THREE.Vector3().copy(this.lookAtTarget);
    const startFov = this.camera.fov;
    const targetLookAt = new THREE.Vector3();
    const targetPos = new THREE.Vector3();

    this.cameraManager.centerAndFrame(
      vrm,
      this.camera,
      this.controls,
      this.cameraProfile,
      targetLookAt,
      targetPos,
      (c) => this.cameraManager.applyInteractionMode(c, this.interactionMode),
    );

    this.startCameraTransition(
      startPos,
      startLookAt,
      startFov,
      targetPos,
      targetLookAt,
      this.camera.fov,
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
      sparkOptimized?: boolean;
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
          options?.sparkOptimized ?? false,
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
        renderer.setPixelRatio(
          getRendererPixelRatio(options?.sparkOptimized ?? false),
        );
        renderer.setClearColor(0x000000, 0);
        if (backend === "webgl") {
          const webglRenderer = renderer as THREE.WebGLRenderer;
          webglRenderer.shadowMap.enabled = true;
          webglRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
          webglRenderer.toneMapping = THREE.NoToneMapping;
          webglRenderer.toneMappingExposure = 1.0;
          webglRenderer.outputColorSpace = THREE.SRGBColorSpace;
        }
        this.renderer = renderer;
        this.rendererBackend = backend;
        const scene = new THREE.Scene();
        this.scene = scene;
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
        const ambient = new THREE.AmbientLight(0xffffff, 0.8);
        scene.add(ambient);
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
        keyLight.position.set(1, 1, 1).normalize();
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.setScalar(1024);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
        fillLight.position.set(-1, 0.5, -1).normalize();
        scene.add(fillLight);
        this.resize(canvas.clientWidth, canvas.clientHeight);
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
        console.error("[VrmEngine] Failed to initialize renderer:", error);
        this.settleReady(error);
      }
    })();
  }

  isInitialized(): boolean {
    return this.initialized && this.renderer !== null;
  }
  dispose(): void {
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
    this.disposeWorld();
    this.avatarLookTarget?.parent?.remove(this.avatarLookTarget);
    this.avatarLookTarget = null;
    this.avatarLookRig = {
      headBone: null,
      neckBone: null,
      spineBone: null,
    };
    this.headLookTarget.set(0, 0);
    this.headLookCurrent.set(0, 0);
    if (this.sparkRenderer) {
      this.sparkRenderer.apertureAngle = 0;
      this.sparkRenderer.removeFromParent();
      this.sparkRenderer = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
    this.renderer = null;
    this.rendererBackend = "webgl";
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

      if (this.vrm) {
        this.cameraManager.centerAndFrame(
          this.vrm,
          this.camera,
          this.controls,
          this.cameraProfile,
          targetLookAt,
          targetPos,
          (c) =>
            this.cameraManager.applyInteractionMode(c, this.interactionMode),
        );
      } else {
        this.cameraManager.applyCameraProfileToCamera(
          this.camera,
          this.controls,
          this.cameraProfile,
        );
        targetPos.copy(this.camera.position);
        if (this.controls) {
          targetLookAt.copy(this.controls.target);
        }
      }

      this.startCameraTransition(
        startPos,
        startLookAt,
        startFov,
        targetPos,
        targetLookAt,
        this.camera.fov,
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

  async setWorldUrl(url: string | null): Promise<void> {
    await this.whenReady();
    if (!this.scene) return;
    const normalizedUrl = url?.trim() ? url : null;
    if (this.worldUrl === normalizedUrl && this.worldMesh) return;

    const requestId = ++this.worldLoadRequestId;
    this.worldUrl = normalizedUrl;
    this.cancelWorldReveal();
    const outgoingWorld = this.worldMesh;
    if (!normalizedUrl) {
      this.disposeWorld();
      return;
    }

    await this.ensureSparkRenderer();
    // Re-check after async — the engine may have been disposed during the
    // await (e.g. React StrictMode double-mount or rapid navigation).
    if (!this.scene || this.loadingAborted || requestId !== this.worldLoadRequestId) return;
    const spark = await this.loadSparkModule();
    if (!this.scene || this.loadingAborted || requestId !== this.worldLoadRequestId) return;
    const { SplatMesh } = spark;
    let worldAnchor = new THREE.Vector3(0, 0, 0);
    let worldRevealRadius = 1;
    const splat = new SplatMesh({
      url: normalizedUrl,
      constructSplats: (packedSplats) => {
        worldAnchor = getRobustPackedSplatAnchor(packedSplats);
        worldRevealRadius = getRobustPackedSplatRadialExtent(
          packedSplats,
          worldAnchor,
        );
      },
    });
    splat.frustumCulled = false;
    splat.quaternion.identity();
    splat.position.set(0, 0, 0);
    splat.scale.setScalar(COMPANION_WORLD_SCALE);
    this.scene.add(splat);

    await splat.initialized;

    if (
      this.loadingAborted ||
      !this.scene ||
      requestId !== this.worldLoadRequestId
    ) {
      splat.parent?.remove(splat);
      splat.dispose();
      return;
    }

    const worldCenterBottom =
      worldAnchor.lengthSq() > 0 ? worldAnchor : getRobustSplatAnchor(splat);
    const worldFloorOffsetY = getCompanionWorldFloorOffsetY(normalizedUrl);
    splat.position.set(
      -worldCenterBottom.x * COMPANION_WORLD_SCALE,
      -worldCenterBottom.y * COMPANION_WORLD_SCALE + worldFloorOffsetY,
      -worldCenterBottom.z * COMPANION_WORLD_SCALE,
    );
    const syncToTeleport = this.revealStarted && this.teleportProgress < 0.999;
    const waitingForVrm = !outgoingWorld && !this.vrmReady;
    const incomingRevealRadius = Math.max(
      worldRevealRadius * COMPANION_WORLD_SCALE,
      getRobustSplatRadialExtent(splat, worldCenterBottom) *
        COMPANION_WORLD_SCALE,
    );
    let outgoingAnchor: THREE.Vector3 | null = null;
    let sharedRevealRadius = incomingRevealRadius;
    if (outgoingWorld && !waitingForVrm) {
      outgoingAnchor = getRobustSplatAnchor(outgoingWorld);
      sharedRevealRadius = Math.max(
        sharedRevealRadius,
        getRobustSplatRadialExtent(outgoingWorld, outgoingAnchor) *
          COMPANION_WORLD_SCALE,
      );
    }

    const worldReveal = this.createWorldRevealController(
      spark,
      splat,
      {
        origin: worldCenterBottom,
        radius: sharedRevealRadius,
      },
      "reveal",
    );
    this.worldMesh = splat;
    if (worldReveal) {
      let outgoingReveal: WorldRevealController | null = null;
      if (outgoingWorld && outgoingAnchor && !waitingForVrm) {
        outgoingReveal = this.createWorldRevealController(
          spark,
          outgoingWorld,
          {
            origin: outgoingAnchor,
            radius: sharedRevealRadius,
          },
          "hide",
        );
        if (!outgoingReveal) {
          this.disposeSplatMesh(outgoingWorld);
        }
      }
      this.queueWorldReveal(worldReveal, {
        outgoing: outgoingReveal,
        duration: COMPANION_WORLD_REVEAL_DURATION,
        waitingForVrm,
        syncToTeleport,
        initialProgress: syncToTeleport ? this.teleportProgress : 0,
      });
    } else {
      this.disposeSplatMesh(outgoingWorld);
    }
  }
  async playEmote(
    path: string,
    duration: number,
    loop: boolean,
  ): Promise<void> {
    const vrm = this.vrm;
    const mixer = this.mixer;
    if (!vrm || !mixer) return;
    this.clearPendingEmoteCompletion();
    this.emoteRequestId++;
    const requestId = this.emoteRequestId;
    const currentAction = this.emoteAction;
    const blendSource = currentAction ?? this.idleAction;
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
    this.playActionWithBlend(action, blendSource, fadeDuration);
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
    this.playEmote("animations/emotes/waving-both-hands.glb.gz", 3, false);
  }

  async loadVrmFromUrl(url: string, name?: string): Promise<void> {
    await this.whenReady();
    if (!this.scene) throw new Error("VrmEngine not initialized");
    if (!this.camera) throw new Error("VrmEngine not initialized");
    if (this.loadingAborted) return;
    const requestId = ++this.vrmLoadRequestId;
    const hadPreviousVrm = this.vrm !== null;
    if (this.vrm) {
      this.vrm.scene.parent?.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
      this.vrmReady = false;
      this.vrmName = null;
      this.mixer = null;
      this.idleAction = null;
      this.idleLoadPromise = null;
      this.revealStarted = false;
      this.cleanupTeleportSparkles();
      this.stopEmote();
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
    loader.register((parser) => {
      if (webGpuNodes) {
        const mtoonMaterialPlugin = new MToonMaterialLoaderPlugin(parser, {
          materialType: webGpuNodes.MToonNodeMaterial,
        });
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
      if (hadPreviousVrm) {
        this.transitionCameraToFramedAvatar(
          vrm,
          AVATAR_SWITCH_CAMERA_TRANSITION_DURATION_SECONDS,
        );
      } else {
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
    vrm.scene.traverse((obj) => {
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
        this.startPendingWorldReveal(true);
        this.playWaveGreeting();
      }
    } catch {
      if (!this.loadingAborted && this.vrm === vrm) {
        this.vrmReady = true;
        vrm.scene.visible = true;
        this.startPendingWorldReveal(false);
      }
    }
  }

  private async playTeleportReveal(vrm: VRM): Promise<void> {
    this.teleportProgress = 0.0;
    this.revealStarted = true;
    this.cleanupTeleportDissolve();
    this.startTeleportSparkles(vrm);
    let appliedNodeDissolve = false;

    try {
      const tsl = await import("three/tsl");

      const uProgress = tsl.uniform(0.0);
      this.teleportProgressUniform = uProgress;

      vrm.scene.traverse((obj: THREE.Object3D) => {
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

          // World-space Y from TSL
          const worldY = tsl.positionWorld.y;

          // Sweep threshold starts 1m lower than before.
          const threshold = uProgress
            .mul(TELEPORT_DISSOLVE_END_Y - TELEPORT_DISSOLVE_START_Y)
            .add(TELEPORT_DISSOLVE_START_Y);

          // Distance above dissolve line
          const diff = worldY.sub(threshold);

          // Dither noise using a hash of world position
          const noiseCoord = tsl.vec2(
            worldY.mul(40.0),
            tsl.positionWorld.x.add(tsl.positionWorld.z).mul(30.0),
          );
          const noise = tsl.fract(
            tsl
              .sin(tsl.dot(noiseCoord, tsl.vec2(12.9898, 78.233)))
              .mul(43758.5453),
          );

          // Ratio: 0 = fully visible, 1 = fully hidden (wider zone = 0.3)
          const ratio = diff.div(0.3).clamp(0.0, 1.0);

          // Dithered alpha: visible when noise >= ratio
          const dissolveAlpha = tsl.step(ratio, noise);

          // --- Holographic glow at the dissolve edge ---
          // Glow is strongest right at the dissolve boundary
          const edgeDist = diff.abs();
          const glowWidth = tsl.float(0.15);
          const glowIntensity = tsl
            .float(1.0)
            .sub(edgeDist.div(glowWidth).clamp(0.0, 1.0));
          // Holographic color: cyan-magenta shift based on world position
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

          // Only show glow when dissolve is active and fragment is visible
          const glowActive = tsl
            .step(tsl.float(0.001), uProgress)
            .mul(tsl.float(1.0).sub(tsl.step(tsl.float(0.999), uProgress)));
          const emissiveBoost = holoColor.mul(
            glowIntensity.mul(3.0).mul(glowActive).mul(dissolveAlpha),
          );

          // Compose with existing nodes
          const origOpacity = mat.opacityNode as
            | TslMaterialNode
            | null
            | undefined;
          mat.opacityNode = origOpacity
            ? (((origOpacity as { mul: (value: unknown) => unknown }).mul(
                dissolveAlpha,
              ) as unknown as TslMaterialNode) ?? dissolveAlpha)
            : dissolveAlpha;

          const matWithEmissive = mat as MeshStandardMaterialWithNodeProps;
          const origEmissive = matWithEmissive.emissiveNode as
            | TslMaterialNode
            | null
            | undefined;
          matWithEmissive.emissiveNode = origEmissive
            ? ((origEmissive as { add: (value: unknown) => unknown }).add(
                emissiveBoost,
              ) as unknown as TslMaterialNode)
            : (emissiveBoost as TslMaterialNode);

          mat.alphaTest = 0.01;
          mat.transparent = true;
          mat.needsUpdate = true;
          this.teleportDissolvedMaterials.push(mat);
        }
      });
    } catch (err) {
      console.warn(
        "[VrmEngine] TSL dissolve unavailable, showing instantly:",
        err,
      );
    }

    if (!appliedNodeDissolve) {
      this.applyTeleportFallbackDissolve(vrm);
    }
  }

  private applyTeleportFallbackDissolve(vrm: VRM): void {
    vrm.scene.traverse((obj: THREE.Object3D) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (mat.userData._dissolveApplied) continue;
        mat.userData._dissolveApplied = true;
        mat.userData._origTransparent = mat.transparent;
        mat.userData._origAlphaTest = mat.alphaTest;
        mat.userData._origOnBeforeCompile = mat.onBeforeCompile;
        mat.userData._origCustomProgramCacheKey = mat.customProgramCacheKey;

        const shaderRef: TeleportFallbackShader = {
          uniforms: { uTeleportProgress: { value: this.teleportProgress } },
        };
        this.teleportFallbackShaders.push(shaderRef);

        mat.transparent = true;
        mat.alphaTest = Math.max(mat.alphaTest ?? 0, 0.01);
        mat.onBeforeCompile = (
          shader: Parameters<THREE.Material["onBeforeCompile"]>[0],
        ) => {
          shader.uniforms.uTeleportProgress =
            shaderRef.uniforms.uTeleportProgress;
          shader.vertexShader = `
varying vec3 vTeleportWorldPosition;
${shader.vertexShader}
`.replace(
            "#include <worldpos_vertex>",
            `#include <worldpos_vertex>
vTeleportWorldPosition = worldPosition.xyz;`,
          );
          shader.fragmentShader = `
uniform float uTeleportProgress;
varying vec3 vTeleportWorldPosition;
float teleportNoiseHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
${shader.fragmentShader}
`.replace(
            "#include <alphatest_fragment>",
            `float teleportThreshold = mix(${TELEPORT_DISSOLVE_START_Y.toFixed(1)}, ${TELEPORT_DISSOLVE_END_Y.toFixed(1)}, uTeleportProgress);
float teleportDiff = vTeleportWorldPosition.y - teleportThreshold;
float teleportRatio = clamp(teleportDiff / 0.3, 0.0, 1.0);
float teleportNoise = teleportNoiseHash(vec2(
  vTeleportWorldPosition.y * 40.0,
  (vTeleportWorldPosition.x + vTeleportWorldPosition.z) * 30.0
));
if (teleportNoise < teleportRatio) discard;
#include <alphatest_fragment>`,
          );

          const originalOnBeforeCompile = mat.userData._origOnBeforeCompile;
          if (typeof originalOnBeforeCompile === "function") {
            originalOnBeforeCompile(
              shader,
              this.renderer as THREE.WebGLRenderer,
            );
          }
        };
        mat.customProgramCacheKey = () =>
          `${mat.type}:teleport-dissolve-fallback`;
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

    for (let index = 0; index < TELEPORT_SPARKLE_PARTICLE_COUNT; index += 1) {
      const hue = 0.52 + Math.random() * 0.08;
      const material = new THREE.SpriteMaterial({
        map: texture,
        color: new THREE.Color().setHSL(hue, 0.85, 0.72),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sparkleGroup.add(sprite);

      const duration = 0.3 + Math.random() * 0.32;
      const maxStart = Math.max(0.02, 0.92 - duration);
      particles.push({
        sprite,
        material,
        baseAngle:
          (index / TELEPORT_SPARKLE_PARTICLE_COUNT) * Math.PI * 2 +
          (Math.random() - 0.5) * 0.55,
        baseRadius:
          (0.18 + Math.random() * 0.82) * TELEPORT_SPARKLE_RING_RADIUS,
        height: particleHeight * (0.55 + Math.random() * 0.55),
        start: Math.random() * maxStart,
        duration,
        spin: (1.8 + Math.random() * 3.6) * (Math.random() > 0.5 ? 1 : -1),
        wobble: 0.02 + Math.random() * 0.08,
        wobbleSpeed: 8 + Math.random() * 12,
        baseSize:
          TELEPORT_SPARKLE_MIN_SIZE +
          Math.random() *
            (TELEPORT_SPARKLE_MAX_SIZE - TELEPORT_SPARKLE_MIN_SIZE),
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
      const rise = 1 - (1 - localProgress) ** 2;
      const angle = particle.baseAngle + progress * Math.PI * 2 * particle.spin;
      const wobblePhase = progress * particle.wobbleSpeed + particle.baseAngle;
      const wobbleOffset = Math.sin(wobblePhase) * particle.wobble;
      const radial = particle.baseRadius * (1 - 0.48 * rise);
      const x = Math.cos(angle) * radial + wobbleOffset;
      const z =
        Math.sin(angle) * radial + Math.cos(wobblePhase) * particle.wobble;
      const y =
        0.08 +
        particle.height * rise +
        Math.sin(progress * 10 + particle.baseAngle * 3) * 0.04;
      const opacity =
        Math.sin(localProgress * Math.PI) *
        (0.72 + 0.28 * Math.sin(progress * 22 + particle.baseAngle * 5));
      const scale = particle.baseSize * (0.7 + (1 - localProgress) * 1.15);

      particle.sprite.visible = opacity > 0.01;
      particle.sprite.position.set(x, y, z);
      particle.sprite.scale.setScalar(scale);
      particle.material.opacity = opacity;
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
        mat.transparent = mat.userData._origTransparent ?? mat.transparent;
        mat.onBeforeCompile =
          mat.userData._origOnBeforeCompile ?? mat.onBeforeCompile;
        mat.customProgramCacheKey =
          mat.userData._origCustomProgramCacheKey ?? mat.customProgramCacheKey;
        delete mat.userData._dissolveApplied;
        delete mat.userData._origOpacityNode;
        delete mat.userData._origEmissiveNode;
        delete mat.userData._origAlphaTest;
        delete mat.userData._origTransparent;
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
    const rawDelta = this.clock.getDelta();
    const stableDelta = Math.min(rawDelta, 1 / 30);
    this.elapsedTime += rawDelta;
    this.mixer?.update(rawDelta);
    if (this.vrm) {
      if (this.teleportProgress < 1.0) {
        this.teleportProgress += stableDelta * 2.0; // ~0.5 seconds duration
        if (this.teleportProgress > 1.0) this.teleportProgress = 1.0;

        if (this.teleportProgressUniform) {
          this.teleportProgressUniform.value = this.teleportProgress;
        }
        for (const shader of this.teleportFallbackShaders) {
          shader.uniforms.uTeleportProgress.value = this.teleportProgress;
        }

        if (this.teleportProgress >= 1.0) {
          this.cleanupTeleportDissolve();
          this.cleanupTeleportSparkles();
        }
      }
      this.updateTeleportSparkles();

      this.applyMouthToVrm(this.vrm);
      const blinkValue = this.blinkController.update(rawDelta);
      this.vrm.expressionManager?.setValue("blink", blinkValue);
    }
    this.updateWorldReveal(stableDelta);

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
      this.baseCameraPosition.length() > 0 &&
      !this.isCameraTransitioning
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
    this.updateSparkPerformanceProfile();
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
            this.pointerParallaxCurrent.x * 0.08,
            this.pointerParallaxCurrent.y * 0.05,
            0,
          ),
        );
    } else {
      this.pointerParallaxCurrent.lerp(this.pointerParallaxTarget, 0.12);
      this.pointerParallaxLookAt.copy(this.lookAtTarget);
    }
    if (this.controls) {
      if (manualCameraActive && !this.isCameraTransitioning) {
        this.controls.update();
        this.lookAtTarget.copy(this.controls.target);
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
    this.updateSparkDepthOfField(camera);
    renderer.render(scene, camera);
    this.onUpdate?.();
  }
  private disposeWorld(): void {
    if (this.sparkRenderer) {
      this.sparkRenderer.apertureAngle = 0;
    }
    this.cancelWorldReveal();
    this.disposeSplatMesh(this.worldMesh);
    this.worldMesh = null;
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
    const prevWidth = canvas.width;
    const prevHeight = canvas.height;
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
      canvas.toBlob(
        (b) => resolve(b),
        "image/png",
      );
    });

    // Restore previous renderer state
    renderer.setPixelRatio(window.devicePixelRatio ?? 1);
    renderer.setSize(prevWidth, prevHeight);
    camera.aspect = prevWidth / prevHeight;
    camera.updateProjectionMatrix();

    // Restore paused state — resume the render loop
    this.setPaused(wasPaused);

    return blob;
  }
}
