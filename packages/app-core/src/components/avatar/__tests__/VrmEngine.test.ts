/**
 * Smoke-level unit tests for VrmEngine.
 *
 * THREE.js and @pixiv/three-vrm cannot run in a headless Node/Bun environment,
 * so every external dependency is mocked. The tests verify the engine's public
 * API contracts — lifecycle, state transitions, emote dispatch, and animation
 * blending — without requiring a real WebGL context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before VrmEngine import
// ---------------------------------------------------------------------------

/** Minimal mock AnimationAction returned by AnimationMixer.clipAction */
function createMockAction() {
  const action = {
    enabled: true,
    paused: false,
    time: 0,
    timeScale: 1,
    weight: 1,
    clampWhenFinished: false,
    reset: vi.fn(() => {
      action.enabled = true;
      action.paused = false;
      action.time = 0;
      return action;
    }),
    play: vi.fn(() => action),
    stop: vi.fn(() => action),
    crossFadeFrom: vi.fn(() => action),
    fadeIn: vi.fn(() => action),
    fadeOut: vi.fn(() => action),
    setLoop: vi.fn(() => action),
    setEffectiveTimeScale: vi.fn((value: number) => {
      action.timeScale = value;
      return action;
    }),
    setEffectiveWeight: vi.fn((value: number) => {
      action.weight = value;
      return action;
    }),
    isRunning: vi.fn(() => true),
    getClip: vi.fn(() => ({ tracks: [{ name: "t1" }, { name: "t2" }] })),
  };
  return action;
}

const hoisted = vi.hoisted(() => {
  const mockAction = createMockAction();
  const mixerListeners = new Map<string, Set<(event: unknown) => void>>();
  const addMixerListener = vi.fn(
    (type: string, listener: (event: unknown) => void) => {
      const listeners = mixerListeners.get(type) ?? new Set();
      listeners.add(listener);
      mixerListeners.set(type, listeners);
    },
  );
  const removeMixerListener = vi.fn(
    (type: string, listener: (event: unknown) => void) => {
      const listeners = mixerListeners.get(type);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) {
        mixerListeners.delete(type);
      }
    },
  );
  const emitMixerEvent = (type: string, event: unknown) => {
    const listeners = mixerListeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      listener(event);
    }
  };
  const mockMixerInstance = {
    update: vi.fn(),
    clipAction: vi.fn(() => mockAction),
    addEventListener: addMixerListener,
    removeEventListener: removeMixerListener,
  };
  const mockRendererInstance = {
    setPixelRatio: vi.fn(),
    setClearColor: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    forceContextLoss: vi.fn(),
    domElement: {} as HTMLCanvasElement,
    shadowMap: { enabled: false, type: 0 },
    toneMapping: 0,
    toneMappingExposure: 1.0,
    outputColorSpace: "",
  };
  const mockWebGpuRendererInstance = {
    setPixelRatio: vi.fn(),
    setClearColor: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    domElement: {} as HTMLCanvasElement,
    init: vi.fn(async () => {}),
  };
  const mockMToonMaterialLoaderPlugin = vi.fn(
    function MockMToonMaterialLoaderPlugin(
      this: { parser: unknown; options: unknown },
      parser: unknown,
      options: unknown,
    ) {
      this.parser = parser;
      this.options = options;
    },
  );
  const mockVRMLoaderPlugin = vi.fn(function MockVRMLoaderPlugin(
    this: { parser: unknown; options: unknown },
    parser: unknown,
    options?: unknown,
  ) {
    this.parser = parser;
    this.options = options;
  });
  const mockLoaderParser = { json: {} };
  const mockLoaderRegister = vi.fn((factory: (parser: unknown) => unknown) => {
    factory(mockLoaderParser);
  });
  const mockLoaderLoadAsync = vi.fn();
  const mockLoaderSetDRACOLoader = vi.fn();
  const mockLoaderSetMeshoptDecoder = vi.fn();
  const mockSparkRendererOptions: unknown[] = [];
  const mockSplatMeshOptions: unknown[] = [];
  const mockDracoLoaderSetDecoderConfig = vi.fn();
  const mockDracoLoaderSetDecoderPath = vi.fn();
  const mockDracoLoaderPreload = vi.fn();
  const navigatorMock = { gpu: undefined as unknown };
  const fetchMock = vi.fn();
  const responseArrayBufferMock = vi.fn();

  return {
    addMixerListener,
    mockDracoLoaderPreload,
    mockDracoLoaderSetDecoderConfig,
    mockDracoLoaderSetDecoderPath,
    emitMixerEvent,
    fetchMock,
    mixerListeners,
    mockLoaderLoadAsync,
    mockLoaderParser,
    mockLoaderRegister,
    mockLoaderSetDRACOLoader,
    mockLoaderSetMeshoptDecoder,
    mockSparkRendererOptions,
    mockSplatMeshOptions,
    mockMixerInstance,
    mockMToonMaterialLoaderPlugin,
    mockRendererInstance,
    responseArrayBufferMock,
    mockVRMLoaderPlugin,
    mockWebGpuRendererInstance,
    navigatorMock,
  };
});

const mockCameraInstance = {
  position: {
    set: vi.fn(),
    x: 0,
    y: 1.1,
    z: 2.8,
    copy: vi.fn(),
    clone: vi.fn(() => ({ x: 0, y: 1.1, z: 2.8 })),
  },
  rotation: { x: 0, y: 0 },
  aspect: 1,
  fov: 25,
  near: 0.01,
  far: 1000,
  add: vi.fn(),
  lookAt: vi.fn(),
  updateProjectionMatrix: vi.fn(),
};

const mockSceneInstance = {
  add: vi.fn(),
  remove: vi.fn(),
};

vi.mock("three", () => {
  const LoopRepeat = 2201;
  const LoopOnce = 2200;

  // Use class syntax for everything that gets `new`-ed
  class MockWebGLRenderer {
    setPixelRatio = hoisted.mockRendererInstance.setPixelRatio;
    setClearColor = hoisted.mockRendererInstance.setClearColor;
    setSize = hoisted.mockRendererInstance.setSize;
    render = hoisted.mockRendererInstance.render;
    dispose = hoisted.mockRendererInstance.dispose;
    forceContextLoss = hoisted.mockRendererInstance.forceContextLoss;
    domElement = hoisted.mockRendererInstance.domElement;
    shadowMap = hoisted.mockRendererInstance.shadowMap;
    toneMapping = hoisted.mockRendererInstance.toneMapping;
    toneMappingExposure = hoisted.mockRendererInstance.toneMappingExposure;
    outputColorSpace = hoisted.mockRendererInstance.outputColorSpace;
  }

  class MockScene {
    add = mockSceneInstance.add;
    remove = mockSceneInstance.remove;
  }

  class MockPerspectiveCamera {
    position = mockCameraInstance.position;
    rotation = mockCameraInstance.rotation;
    aspect = mockCameraInstance.aspect;
    fov = mockCameraInstance.fov;
    near = mockCameraInstance.near;
    far = mockCameraInstance.far;
    add = mockCameraInstance.add;
    lookAt = mockCameraInstance.lookAt;
    updateProjectionMatrix = mockCameraInstance.updateProjectionMatrix;
  }

  class MockClock {
    start = vi.fn();
    stop = vi.fn();
    getDelta = vi.fn(() => 0.016);
  }

  class MockGroup {
    name = "";
    position = { set: vi.fn() };
    scale = { set: vi.fn(), setScalar: vi.fn() };
    add = vi.fn();
    remove = vi.fn();
    updateMatrixWorld = vi.fn();
  }

  class MockAnimationMixer {
    update = hoisted.mockMixerInstance.update;
    clipAction = hoisted.mockMixerInstance.clipAction;
    addEventListener = hoisted.mockMixerInstance.addEventListener;
    removeEventListener = hoisted.mockMixerInstance.removeEventListener;
  }

  class MockDirectionalLight {
    position = {
      set: vi.fn().mockReturnValue({ normalize: vi.fn() }),
    };
    castShadow = false;
    shadow = {
      mapSize: { setScalar: vi.fn() },
      camera: { near: 0, far: 0, left: 0, right: 0, top: 0, bottom: 0 },
    };
  }

  class MockAmbientLight {}

  class MockVector3 {
    x = 0;
    y = 0;
    z = 0;
    set = vi.fn().mockReturnThis();
    add = vi.fn().mockReturnThis();
    copy = vi.fn().mockReturnThis();
    sub = vi.fn().mockReturnThis();
    subVectors = vi.fn().mockReturnThis();
    cross = vi.fn().mockReturnThis();
    normalize = vi.fn().mockReturnThis();
    dot = vi.fn(() => 1);
    getWorldPosition = vi.fn().mockReturnThis();
    getWorldDirection = vi.fn().mockReturnThis();
    lengthSq = vi.fn(() => 1);
    length = vi.fn(() => 1);
    multiplyScalar = vi.fn().mockReturnThis();
    setFromSpherical = vi.fn().mockReturnThis();
  }

  class MockVector2 {
    x = 0;
    y = 0;
    set = vi.fn((x: number, y: number) => {
      this.x = x;
      this.y = y;
      return this;
    });
    copy = vi.fn((value: { x: number; y: number }) => {
      this.x = value.x;
      this.y = value.y;
      return this;
    });
    sub = vi.fn().mockReturnThis();
    lengthSq = vi.fn(() => 0);
    multiplyScalar = vi.fn().mockReturnThis();
    lerp = vi.fn((value: { x: number; y: number }, alpha: number) => {
      this.x += (value.x - this.x) * alpha;
      this.y += (value.y - this.y) * alpha;
      return this;
    });
  }

  class MockBox3 {
    setFromObject = vi.fn().mockReturnThis();
    isEmpty = vi.fn(() => false);
    min = { x: 0, y: 0, z: 0 };
    max = { x: 0, y: 1.6, z: 0 };
    getCenter = vi.fn(() => new MockVector3());
    getSize = vi.fn(() => {
      const v = new MockVector3();
      v.x = 0.4;
      v.y = 1.6;
      v.z = 0.3;
      return v;
    });
  }

  class MockSpherical {
    radius = 1;
    phi = Math.PI / 2;
    theta = 0;
    setFromVector3 = vi.fn().mockReturnThis();
  }

  return {
    WebGLRenderer: MockWebGLRenderer,
    Scene: MockScene,
    Group: MockGroup,
    PerspectiveCamera: MockPerspectiveCamera,
    Clock: MockClock,
    AnimationMixer: MockAnimationMixer,
    DirectionalLight: MockDirectionalLight,
    AmbientLight: MockAmbientLight,
    Vector2: MockVector2,
    Vector3: MockVector3,
    Box3: MockBox3,
    Spherical: MockSpherical,
    LoopRepeat,
    LoopOnce,
    PCFSoftShadowMap: 2,
    NoToneMapping: 0,
    SRGBColorSpace: "srgb",
    Mesh: class MockMesh {
      geometry = { dispose: vi.fn() };
      material = { opacity: 1, map: { dispose: vi.fn() }, dispose: vi.fn() };
      position = { set: vi.fn(), y: 0 };
      rotation = { x: 0, y: 0, z: 0 };
      receiveShadow = false;
    },
    PlaneGeometry: class MockPlaneGeometry {},
    MeshBasicMaterial: class MockMeshBasicMaterial {
      opacity = 1;
      dispose = vi.fn();
    },
    CanvasTexture: class MockCanvasTexture {
      dispose = vi.fn();
    },
    AnimationClip: Object.assign(
      class MockAnimationClip {
        tracks: unknown[] = [];
        name = "";
      },
      { findByName: vi.fn(() => null) },
    ),
    MathUtils: {
      clamp: vi.fn((value: number, min: number, max: number) =>
        Math.min(Math.max(value, min), max),
      ),
      degToRad: vi.fn((deg: number) => (deg * Math.PI) / 180),
      lerp: vi.fn(
        (start: number, end: number, alpha: number) =>
          start + (end - start) * alpha,
      ),
    },
  };
});

vi.mock("three/webgpu", () => ({
  WebGPURenderer: class MockWebGPURenderer {
    setPixelRatio = hoisted.mockWebGpuRendererInstance.setPixelRatio;
    setClearColor = hoisted.mockWebGpuRendererInstance.setClearColor;
    setSize = hoisted.mockWebGpuRendererInstance.setSize;
    render = hoisted.mockWebGpuRendererInstance.render;
    dispose = hoisted.mockWebGpuRendererInstance.dispose;
    domElement = hoisted.mockWebGpuRendererInstance.domElement;
    init = hoisted.mockWebGpuRendererInstance.init;
  },
}));

vi.mock("@sparkjsdev/spark", () => ({
  SparkRenderer: class MockSparkRenderer {
    renderOrder = 0;
    uniforms = { numSplats: { value: 0 } };
    focalDistance = 0;
    apertureAngle = 0;
    removeFromParent = vi.fn();
    constructor(options?: { focalDistance?: number; apertureAngle?: number }) {
      this.focalDistance = options?.focalDistance ?? 0;
      this.apertureAngle = options?.apertureAngle ?? 0;
      hoisted.mockSparkRendererOptions.push(options ?? {});
    }
  },
  SplatModifier: class MockSplatModifier {
    modifier: unknown;
    constructor(modifier: unknown) {
      this.modifier = modifier;
    }
  },
  SplatGenerator: class MockSplatGenerator {},
  SplatMesh: class MockSplatMesh {
    initialized = Promise.resolve();
    packedSplats = { numSplats: 0 };
    isInitialized = true;
    frustumCulled = false;
    renderOrder = 0;
    visible = true;
    opacity = 1;
    children: unknown[] = [];
    position = { set: vi.fn(), y: 0 };
    quaternion = { set: vi.fn(), identity: vi.fn() };
    scale = { setScalar: vi.fn() };
    worldModifier: unknown = null;
    objectModifier: unknown = null;
    getBoundingBox = vi.fn(() => ({
      min: { y: 0 },
      getCenter: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
      getSize: vi.fn(() => ({ x: 1, y: 1, z: 1 })),
    }));
    forEachSplat = vi.fn();
    update = vi.fn();
    updateGenerator = vi.fn();
    updateVersion = vi.fn();
    dispose = vi.fn();
    constructor(options?: unknown) {
      hoisted.mockSplatMeshOptions.push(options ?? {});
    }
  },
  dyno: {
    Gsplat: { type: "Gsplat" },
    dynoBlock: vi.fn(() => ({ kind: "dynoBlock" })),
    dynoFloat: vi.fn((value = 0) => ({ value })),
    dynoVec3: vi.fn((value = new MockVector3()) => ({ value })),
    dynoConst: vi.fn((_type: string, value: number) => ({ value })),
    splitGsplat: vi.fn(() => ({
      outputs: { center: {}, scales: {}, rgb: {}, opacity: {} },
    })),
    combineGsplat: vi.fn((value: unknown) => value),
    add: vi.fn(() => ({})),
    sub: vi.fn(() => ({})),
    mul: vi.fn(() => ({})),
    div: vi.fn(() => ({})),
    abs: vi.fn(() => ({})),
    clamp: vi.fn(() => ({})),
    max: vi.fn(() => ({})),
    mix: vi.fn(() => ({})),
    smoothstep: vi.fn(() => ({})),
    pow: vi.fn(() => ({})),
    length: vi.fn(() => ({})),
    swizzle: vi.fn(() => ({})),
  },
}));

vi.mock("@pixiv/three-vrm", () => ({
  MToonMaterialLoaderPlugin: hoisted.mockMToonMaterialLoaderPlugin,
  VRMLoaderPlugin: hoisted.mockVRMLoaderPlugin,
  VRMUtils: {
    deepDispose: vi.fn(),
    removeUnnecessaryVertices: vi.fn(),
    combineSkeletons: vi.fn(),
  },
}));

vi.mock("@pixiv/three-vrm/nodes", () => ({
  MToonNodeMaterial: class MockMToonNodeMaterial {},
}));

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class MockGLTFLoader {
    register = hoisted.mockLoaderRegister;
    setDRACOLoader = hoisted.mockLoaderSetDRACOLoader;
    setMeshoptDecoder = hoisted.mockLoaderSetMeshoptDecoder;
    loadAsync = hoisted.mockLoaderLoadAsync;
  },
}));

vi.mock("three/examples/jsm/loaders/DRACOLoader.js", () => ({
  DRACOLoader: class MockDRACOLoader {
    setDecoderConfig = hoisted.mockDracoLoaderSetDecoderConfig;
    setDecoderPath = hoisted.mockDracoLoaderSetDecoderPath;
    preload = hoisted.mockDracoLoaderPreload;
  },
}));

vi.mock("three/examples/jsm/libs/meshopt_decoder.module.js", () => ({
  MeshoptDecoder: { supported: true },
}));

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class MockOrbitControls {
    enablePan = true;
    enableRotate = true;
    enableZoom = true;
    enableDamping = false;
    dampingFactor = 0.05;
    zoomSpeed = 1;
    minDistance = 0;
    maxDistance = Infinity;
    minPolarAngle = 0;
    maxPolarAngle = Math.PI;
    target = { set: vi.fn(), copy: vi.fn(), x: 0, y: 0, z: 0 };
    update = vi.fn();
    dispose = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    enabled = true;
  },
}));

vi.mock("@elizaos/app-core/utils", () => ({
  resolveAppAssetUrl: vi.fn((p: string) => `/mock/${p}`),
}));

// Stub DOM APIs that VrmEngine relies on
const rafIds = { current: 0 };
Object.assign(globalThis, {
  requestAnimationFrame: vi.fn(() => {
    return ++rafIds.current;
  }),
  cancelAnimationFrame: vi.fn(),
});

// VrmEngine.setup() accesses window.devicePixelRatio
Object.assign(globalThis, {
  window: {
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    localStorage: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: hoisted.navigatorMock as unknown as Navigator,
});
Object.assign(globalThis, {
  fetch: hoisted.fetchMock,
});

// VrmEngine.createFootShadow accesses document.createElement
const mockCanvas2d = {
  createRadialGradient: vi.fn(() => ({
    addColorStop: vi.fn(),
  })),
  fillStyle: "",
  fillRect: vi.fn(),
  fill: vi.fn(),
  beginPath: vi.fn(),
  arc: vi.fn(),
};
Object.assign(globalThis, {
  document: {
    createElement: vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: vi.fn(() => mockCanvas2d),
    })),
  },
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { VrmEngine } from "../VrmEngine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCanvas(): HTMLCanvasElement {
  return {
    clientWidth: 800,
    clientHeight: 600,
    getBoundingClientRect: () => ({
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLCanvasElement;
}

function createMockLoadedVrm() {
  return {
    scene: {
      parent: null,
      visible: true,
      traverse: vi.fn(),
      updateMatrixWorld: vi.fn(),
      scale: { setScalar: vi.fn() },
      position: { set: vi.fn() },
    },
    humanoid: {
      getNormalizedBoneNode: vi.fn(() => null),
    },
    springBoneManager: {
      reset: vi.fn(),
    },
  };
}

async function waitForEngineReady(engine: VrmEngine): Promise<void> {
  await engine.whenReady();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VrmEngine", () => {
  let engine: VrmEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.mixerListeners.clear();
    hoisted.navigatorMock.gpu = undefined;
    hoisted.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: hoisted.responseArrayBufferMock,
    });
    hoisted.responseArrayBufferMock.mockResolvedValue(new ArrayBuffer(8));
    delete (window as Window & { __electrobunWindowId?: number })
      .__electrobunWindowId;
    delete (window as Window & { __electrobunWebviewId?: number })
      .__electrobunWebviewId;
    engine = new VrmEngine();
  });

  afterEach(() => {
    engine.dispose();
  });

  // ── 1. Setup / dispose lifecycle ─────────────────────────────────
  describe("setup / dispose lifecycle", () => {
    it("creates an engine without throwing", () => {
      expect(engine).toBeInstanceOf(VrmEngine);
    });

    it("is not initialized before setup()", () => {
      expect(engine.isInitialized()).toBe(false);
    });

    it("is initialized after setup()", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);
      expect(engine.isInitialized()).toBe(true);
    });

    it("dispose() does not throw on an un-initialized engine", () => {
      expect(() => engine.dispose()).not.toThrow();
    });

    it("dispose() cleans up after setup()", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);
      expect(engine.isInitialized()).toBe(true);

      engine.dispose();
      expect(engine.isInitialized()).toBe(false);
    });

    it("can be setup() again after dispose()", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);
      engine.dispose();
      expect(engine.isInitialized()).toBe(false);

      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);
      expect(engine.isInitialized()).toBe(true);
    });

    it("re-setup with the same canvas reuses the engine (no dispose)", async () => {
      const canvas = createMockCanvas();
      // Assign domElement so the "same canvas" check passes
      hoisted.mockRendererInstance.domElement = canvas;

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      engine.setup(canvas, cb1);
      await waitForEngineReady(engine);
      engine.setup(canvas, cb2);
      expect(engine.isInitialized()).toBe(true);
      // dispose should not have been called between the two setups
      expect(hoisted.mockRendererInstance.dispose).not.toHaveBeenCalled();
    });

    it("pauses and resumes the render loop without disposing the scene", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);

      engine.setPaused(true);
      expect(globalThis.cancelAnimationFrame).toHaveBeenCalledTimes(1);
      expect(hoisted.mockRendererInstance.dispose).not.toHaveBeenCalled();

      engine.setPaused(false);
      expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(2);
    });

    it("waits for the renderer to finish initializing", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());

      await expect(engine.whenReady()).resolves.toBeUndefined();
      expect(engine.isInitialized()).toBe(true);
    });

    it("defaults to WebGLRenderer when navigator.gpu is available", async () => {
      hoisted.navigatorMock.gpu = {};
      const canvas = createMockCanvas();

      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      const engineAny = engine as unknown as { rendererBackend: string };
      expect(engineAny.rendererBackend).toBe("webgl");
      expect(hoisted.mockWebGpuRendererInstance.init).not.toHaveBeenCalled();
      expect(hoisted.mockRendererInstance.setPixelRatio).toHaveBeenCalledWith(
        1,
      );
    });

    it("uses WebGPURenderer when navigator.gpu is available and opted in", async () => {
      hoisted.navigatorMock.gpu = {};
      (
        window.localStorage.getItem as ReturnType<typeof vi.fn>
      ).mockReturnValueOnce("webgpu");
      const canvas = createMockCanvas();

      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      const engineAny = engine as unknown as { rendererBackend: string };
      expect(engineAny.rendererBackend).toBe("webgpu");
      expect(hoisted.mockWebGpuRendererInstance.init).toHaveBeenCalledTimes(1);
      expect(
        hoisted.mockWebGpuRendererInstance.setPixelRatio,
      ).toHaveBeenCalledWith(1);
    });

    it("uses WebGPURenderer by default in Electrobun runtime", async () => {
      hoisted.navigatorMock.gpu = {};
      (
        window as Window & { __electrobunWindowId?: number }
      ).__electrobunWindowId = 1;
      const canvas = createMockCanvas();

      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      const engineAny = engine as unknown as { rendererBackend: string };
      expect(engineAny.rendererBackend).toBe("webgpu");
      expect(hoisted.mockWebGpuRendererInstance.init).toHaveBeenCalledTimes(1);
    });

    it("cleans up WebGL resources during dispose()", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      engine.dispose();

      expect(hoisted.mockRendererInstance.dispose).toHaveBeenCalled();
    });
  });

  // ── 2. playEmote doesn't throw ───────────────────────────────────
  describe("playEmote", () => {
    it("returns immediately when VRM is not loaded (no mixer)", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);
      // No VRM loaded — playEmote should resolve silently
      await expect(
        engine.playEmote("/mock/emote.glb", 2, false),
      ).resolves.toBeUndefined();
    });

    it("stopEmote() does not throw when no emote is playing", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);
      expect(() => engine.stopEmote()).not.toThrow();
    });
  });

  // ── 3. State transitions ─────────────────────────────────────────
  describe("state transitions", () => {
    it("initial state has no VRM loaded", () => {
      const state = engine.getState();
      expect(state.vrmLoaded).toBe(false);
      expect(state.vrmName).toBeNull();
      expect(state.idlePlaying).toBe(false);
      expect(state.idleTime).toBe(0);
      expect(state.idleTracks).toBe(0);
    });

    it("state after setup still has no VRM loaded", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);
      const state = engine.getState();
      expect(state.vrmLoaded).toBe(false);
      expect(state.vrmName).toBeNull();
    });

    it("state after dispose resets to initial", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);
      engine.dispose();
      const state = engine.getState();
      expect(state.vrmLoaded).toBe(false);
      expect(state.vrmName).toBeNull();
      expect(state.idlePlaying).toBe(false);
    });

    it("getState() returns the VrmEngineState shape", () => {
      const state = engine.getState();
      const keys = Object.keys(state).sort();
      expect(keys).toEqual(
        [
          "idlePlaying",
          "idleTime",
          "idleTracks",
          "loadError",
          "revealStarted",
          "vrmLoaded",
          "vrmName",
        ].sort(),
      );
    });
  });

  // ── 4. Public setters ────────────────────────────────────────────
  describe("public setters", () => {
    it("setMouthOpen clamps values to [0, 1]", () => {
      expect(() => engine.setMouthOpen(0)).not.toThrow();
      expect(() => engine.setMouthOpen(1)).not.toThrow();
      expect(() => engine.setMouthOpen(-0.5)).not.toThrow();
      expect(() => engine.setMouthOpen(2.0)).not.toThrow();
    });

    it("setSpeaking toggles without throwing", () => {
      expect(() => engine.setSpeaking(true)).not.toThrow();
      expect(() => engine.setSpeaking(false)).not.toThrow();
    });

    it("setCameraAnimation merges partial config", () => {
      expect(() => engine.setCameraAnimation({ enabled: false })).not.toThrow();
      expect(() =>
        engine.setCameraAnimation({ swayAmplitude: 0.1, speed: 1.5 }),
      ).not.toThrow();
    });

    it("setCompanionZoomNormalized clamps to the supported range", () => {
      const engineAny = engine as unknown as { companionZoomTarget: number };

      engine.setCompanionZoomNormalized(-0.5);
      expect(engineAny.companionZoomTarget).toBe(0);

      engine.setCompanionZoomNormalized(1.4);
      expect(engineAny.companionZoomTarget).toBe(1);
    });

    it("queues the first world reveal until the VRM is ready", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      const engineAny = engine as unknown as {
        worldReveal: {
          waitingForVrm: boolean;
          syncToTeleport: boolean;
          progress: number;
          controller: {
            mesh: {
              objectModifier: unknown;
              updateGenerator: ReturnType<typeof vi.fn>;
              updateVersion: ReturnType<typeof vi.fn>;
            };
          };
        } | null;
      };

      await engine.setWorldUrl("/worlds/companion-day.spz");

      expect(engineAny.worldReveal?.waitingForVrm).toBe(true);
      expect(engineAny.worldReveal?.syncToTeleport).toBe(false);
      expect(engineAny.worldReveal?.progress).toBe(0);
      expect(
        engineAny.worldReveal?.controller.mesh.objectModifier,
      ).toBeTruthy();
      expect(
        engineAny.worldReveal?.controller.mesh.updateGenerator,
      ).toHaveBeenCalled();
      expect(
        engineAny.worldReveal?.controller.mesh.updateVersion,
      ).toHaveBeenCalled();
    });

    it("resize() handles zero or negative dimensions gracefully", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);
      expect(() => engine.resize(0, 0)).not.toThrow();
      expect(() => engine.resize(-1, 600)).not.toThrow();
      expect(() => engine.resize(800, -1)).not.toThrow();
      expect(() => engine.resize(1024, 768)).not.toThrow();
    });

    it("resize() is a no-op before setup()", () => {
      expect(() => engine.resize(800, 600)).not.toThrow();
    });

    it("configures Spark native depth of field for world rendering", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      await engine.setWorldUrl("/worlds/companion-day.spz");

      expect(hoisted.mockSplatMeshOptions.at(-1)).toMatchObject({
        url: "/worlds/companion-day.spz",
      });
      expect(hoisted.mockSparkRendererOptions.at(-1)).toMatchObject({
        apertureAngle: 0,
        clipXY: 1.08,
        focalDistance: 5,
        maxStdDev: 2.35,
        minAlpha: 0.0016,
        view: expect.objectContaining({
          depthBias: 1,
          sortDistance: 0.035,
          sortRadial: true,
          sort360: false,
        }),
      });

      const engineAny = engine as unknown as {
        sparkRenderer: { focalDistance: number; apertureAngle: number };
        updateSparkDepthOfField: (camera: {
          position: { distanceTo: (target: unknown) => number };
        }) => void;
      };
      engineAny.updateSparkDepthOfField({
        position: { distanceTo: () => 4 },
      });

      expect(engineAny.sparkRenderer.focalDistance).toBe(4);
      expect(engineAny.sparkRenderer.apertureAngle).toBeCloseTo(
        2 * Math.atan(0.0125 / 4),
      );
    });

    it("uses theme-specific floor offsets for companion worlds", async () => {
      mockSceneInstance.add.mockClear();

      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      await engine.setWorldUrl("/worlds/companion-day.spz");
      const daySplat = mockSceneInstance.add.mock.calls.at(-1)?.[0] as {
        position: { set: ReturnType<typeof vi.fn> };
      };

      await engine.setWorldUrl("/worlds/companion-night.spz");
      const nightSplat = mockSceneInstance.add.mock.calls.at(-1)?.[0] as {
        position: { set: ReturnType<typeof vi.fn> };
      };

      const dayPosition = daySplat.position.set.mock.calls.at(-1) ?? [];
      const nightPosition = nightSplat.position.set.mock.calls.at(-1) ?? [];

      expect(dayPosition[0]).toBeCloseTo(0, 5);
      expect(dayPosition[1]).toBeCloseTo(-0.35, 5);
      expect(dayPosition[2]).toBeCloseTo(0, 5);
      expect(nightPosition[0]).toBeCloseTo(0, 5);
      expect(nightPosition[1]).toBeCloseTo(-0.95, 5);
      expect(nightPosition[2]).toBeCloseTo(0, 5);
    });

    it("starts a pending world reveal when the teleport dissolve begins", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      await engine.setWorldUrl("/worlds/companion-day.spz");

      const engineAny = engine as unknown as {
        teleportProgress: number;
        startPendingWorldReveal: (syncToTeleport: boolean) => void;
        worldReveal: {
          waitingForVrm: boolean;
          syncToTeleport: boolean;
          progress: number;
          controller: {
            mesh: {
              objectModifier: unknown;
              updateGenerator: ReturnType<typeof vi.fn>;
            };
          };
        } | null;
      };

      engineAny.teleportProgress = 0.35;
      engineAny.startPendingWorldReveal(true);

      expect(engineAny.worldReveal?.waitingForVrm).toBe(false);
      expect(engineAny.worldReveal?.syncToTeleport).toBe(true);
      expect(engineAny.worldReveal?.progress).toBeCloseTo(0.35);
      expect(
        engineAny.worldReveal?.controller.mesh.objectModifier,
      ).toBeTruthy();
      expect(
        engineAny.worldReveal?.controller.mesh.updateGenerator,
      ).toHaveBeenCalled();
    });

    it("keeps the previous world alive while the next world dissolves in", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      await engine.setWorldUrl("/worlds/companion-day.spz");

      const engineAny = engine as unknown as {
        vrmReady: boolean;
        worldMesh: {
          opacity: number;
          objectModifier: unknown;
          dispose: ReturnType<typeof vi.fn>;
        } | null;
        worldReveal: {
          waitingForVrm: boolean;
          syncToTeleport: boolean;
          progress: number;
          duration: number;
          controller: {
            progressUniform: { value: number };
            mesh: {
              opacity: number;
              objectModifier: unknown;
              dispose: ReturnType<typeof vi.fn>;
            };
            radius: number;
          };
          incoming: {
            progressUniform: { value: number };
            mesh: {
              opacity: number;
              objectModifier: unknown;
              dispose: ReturnType<typeof vi.fn>;
            };
            radius: number;
          };
          outgoing: {
            progressUniform: { value: number };
            mesh: {
              opacity: number;
              objectModifier: unknown;
              dispose: ReturnType<typeof vi.fn>;
            };
            radius: number;
          } | null;
        } | null;
        updateWorldReveal: (stableDelta: number) => void;
      };

      const firstWorld = engineAny.worldMesh;
      expect(firstWorld).toBeTruthy();

      engineAny.vrmReady = true;
      await engine.setWorldUrl("/worlds/companion-night.spz");
      const secondWorld = engineAny.worldMesh;

      expect(secondWorld).toBeTruthy();
      expect(secondWorld).not.toBe(firstWorld);
      expect(firstWorld?.dispose).not.toHaveBeenCalled();
      expect(engineAny.worldReveal?.waitingForVrm).toBe(false);
      expect(engineAny.worldReveal?.syncToTeleport).toBe(false);
      expect(engineAny.worldReveal?.incoming.mesh).toBe(secondWorld);
      expect(engineAny.worldReveal?.outgoing?.mesh).toBe(firstWorld);
      expect(engineAny.worldReveal?.controller.mesh).toBe(secondWorld);
      expect(engineAny.worldReveal?.incoming.radius).toBeCloseTo(
        engineAny.worldReveal?.outgoing?.radius ?? 0,
      );
      expect(engineAny.worldReveal?.incoming.mesh.objectModifier).toBeTruthy();
      expect(engineAny.worldReveal?.outgoing?.mesh.objectModifier).toBeTruthy();

      const halfDuration = (engineAny.worldReveal?.duration ?? 0) / 2;
      engineAny.updateWorldReveal(halfDuration);
      expect(engineAny.worldReveal?.progress).toBeCloseTo(0.5, 5);
      expect(engineAny.worldReveal?.incoming.progressUniform.value).toBeCloseTo(
        0.25,
        5,
      );
      expect(
        engineAny.worldReveal?.outgoing?.progressUniform.value,
      ).toBeCloseTo(0.25, 5);
      expect(firstWorld?.dispose).not.toHaveBeenCalled();
      for (let i = 0; i < 32 && engineAny.worldReveal; i++) {
        engineAny.updateWorldReveal(0.4);
      }
      expect(engineAny.worldReveal).toBeNull();
      expect(firstWorld?.dispose).toHaveBeenCalled();
      expect(secondWorld?.opacity).toBe(1);
    });
  });

  // ── 5. Animation blending basics ─────────────────────────────────
  describe("animation blending", () => {
    it("stopEmote calls fadeOut on any active emote action", () => {
      const engineAny = engine as unknown as {
        emoteAction: ReturnType<typeof createMockAction> | null;
        idleAction: ReturnType<typeof createMockAction> | null;
        emoteTimeout: ReturnType<typeof setTimeout> | null;
      };

      const fakeEmoteAction = createMockAction();
      const fakeIdleAction = createMockAction();
      engineAny.emoteAction = fakeEmoteAction;
      engineAny.idleAction = fakeIdleAction;

      engine.stopEmote();

      expect(fakeIdleAction.crossFadeFrom).toHaveBeenCalledWith(
        fakeEmoteAction,
        0.4,
        false,
      );
      expect(fakeIdleAction.play).toHaveBeenCalled();
      expect(engineAny.emoteAction).toBeNull();
    });

    it("playEmote crossfades from the current emote instead of bouncing through idle", async () => {
      const engineAny = engine as unknown as {
        vrm: object | null;
        mixer: {
          clipAction: ReturnType<typeof vi.fn>;
          addEventListener: ReturnType<typeof vi.fn>;
          removeEventListener: ReturnType<typeof vi.fn>;
        } | null;
        idleAction: ReturnType<typeof createMockAction> | null;
        emoteAction: ReturnType<typeof createMockAction> | null;
        loadEmoteClipCached: ReturnType<typeof vi.fn>;
      };
      const nextEmoteAction = createMockAction();
      const currentEmoteAction = createMockAction();
      const idleAction = createMockAction();

      engineAny.vrm = {
        scene: {
          parent: null,
        },
      };
      engineAny.mixer = {
        clipAction: vi.fn(() => nextEmoteAction),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      engineAny.idleAction = idleAction;
      engineAny.emoteAction = currentEmoteAction;
      engineAny.loadEmoteClipCached = vi.fn().mockResolvedValue({});

      await engine.playEmote("/mock/emote.glb", 2, false);

      expect(nextEmoteAction.crossFadeFrom).toHaveBeenCalledWith(
        currentEmoteAction,
        0.4,
        false,
      );
      expect(idleAction.fadeIn).not.toHaveBeenCalled();
      expect(engineAny.emoteAction).toBe(nextEmoteAction);
    });

    it("restores idle as soon as a one-shot emote finishes", async () => {
      const engineAny = engine as unknown as {
        vrm: object | null;
        mixer: typeof hoisted.mockMixerInstance | null;
        idleAction: ReturnType<typeof createMockAction> | null;
        emoteAction: ReturnType<typeof createMockAction> | null;
        loadEmoteClipCached: ReturnType<typeof vi.fn>;
      };
      const nextEmoteAction = createMockAction();
      const idleAction = createMockAction();

      engineAny.vrm = {
        scene: {
          parent: null,
        },
      };
      engineAny.mixer = hoisted.mockMixerInstance;
      engineAny.idleAction = idleAction;
      engineAny.emoteAction = null;
      engineAny.loadEmoteClipCached = vi
        .fn()
        .mockResolvedValue({ duration: 1.25 });
      hoisted.mockMixerInstance.clipAction.mockReturnValue(nextEmoteAction);

      await engine.playEmote("/mock/emote.glb", 4, false);
      hoisted.emitMixerEvent("finished", {
        type: "finished",
        action: nextEmoteAction,
        direction: 1,
      });

      expect(idleAction.play).toHaveBeenCalled();
      expect(idleAction.crossFadeFrom).toHaveBeenCalledWith(
        nextEmoteAction,
        0.4,
        false,
      );
      expect(engineAny.emoteAction).toBeNull();
      expect(
        hoisted.mockMixerInstance.removeEventListener,
      ).toHaveBeenCalledWith("finished", expect.any(Function));
    });

    it("re-enables idle before blending back from an emote", () => {
      const engineAny = engine as unknown as {
        emoteAction: ReturnType<typeof createMockAction> | null;
        idleAction: ReturnType<typeof createMockAction> | null;
      };
      const fakeEmoteAction = createMockAction();
      const fakeIdleAction = createMockAction();
      fakeIdleAction.enabled = false;
      fakeIdleAction.paused = true;

      engineAny.emoteAction = fakeEmoteAction;
      engineAny.idleAction = fakeIdleAction;

      engine.stopEmote();

      expect(fakeIdleAction.enabled).toBe(true);
      expect(fakeIdleAction.paused).toBe(false);
      expect(fakeIdleAction.setEffectiveTimeScale).toHaveBeenCalledWith(1);
      expect(fakeIdleAction.setEffectiveWeight).toHaveBeenCalledWith(1);
      expect(fakeIdleAction.crossFadeFrom).toHaveBeenCalledWith(
        fakeEmoteAction,
        0.4,
        false,
      );
    });

    it("uses the requested emote duration for one-shot fallback timing", async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const engineAny = engine as unknown as {
        vrm: object | null;
        mixer: typeof hoisted.mockMixerInstance | null;
        idleAction: ReturnType<typeof createMockAction> | null;
        emoteAction: ReturnType<typeof createMockAction> | null;
        loadEmoteClipCached: ReturnType<typeof vi.fn>;
      };
      const nextEmoteAction = createMockAction();
      const idleAction = createMockAction();

      try {
        engineAny.vrm = {
          scene: {
            parent: null,
          },
        };
        engineAny.mixer = hoisted.mockMixerInstance;
        engineAny.idleAction = idleAction;
        engineAny.emoteAction = null;
        engineAny.loadEmoteClipCached = vi
          .fn()
          .mockResolvedValue({ duration: 0.75 });
        hoisted.mockMixerInstance.clipAction.mockReturnValue(nextEmoteAction);

        await engine.playEmote("/mock/emote.glb", 4, false);

        expect(setTimeoutSpy).toHaveBeenLastCalledWith(
          expect.any(Function),
          4100,
        );
      } finally {
        engine.stopEmote();
        setTimeoutSpy.mockRestore();
      }
    });

    it("stopEmote clears pending emote timeout", () => {
      const engineAny = engine as unknown as {
        emoteTimeout: ReturnType<typeof setTimeout> | null;
      };
      engineAny.emoteTimeout = setTimeout(() => {}, 10_000);

      engine.stopEmote();

      expect(engineAny.emoteTimeout).toBeNull();
    });

    it("stopEmote restores idle lazily when the idle action is missing", () => {
      const fakeEmoteAction = createMockAction();
      const restoreIdleAfterEmote = vi.fn();
      const vrm = { scene: { parent: null } };
      const mixer = { clipAction: vi.fn() };
      const engineAny = engine as unknown as {
        emoteAction: ReturnType<typeof createMockAction> | null;
        idleAction: ReturnType<typeof createMockAction> | null;
        vrm: typeof vrm | null;
        mixer: typeof mixer | null;
        restoreIdleAfterEmote: ReturnType<typeof vi.fn>;
      };

      engineAny.emoteAction = fakeEmoteAction;
      engineAny.idleAction = null;
      engineAny.vrm = vrm;
      engineAny.mixer = mixer;
      engineAny.restoreIdleAfterEmote = restoreIdleAfterEmote;

      engine.stopEmote();

      expect(restoreIdleAfterEmote).toHaveBeenCalledWith(
        fakeEmoteAction,
        0.4,
        vrm,
        mixer,
      );
      expect(engineAny.emoteAction).toBeNull();
    });

    it("emote clip cache starts empty and is cleared on dispose", () => {
      const engineAny = engine as unknown as {
        emoteClipCache: Map<string, unknown>;
      };
      expect(engineAny.emoteClipCache.size).toBe(0);

      engineAny.emoteClipCache.set("test.glb", {});
      expect(engineAny.emoteClipCache.size).toBe(1);

      engine.dispose();
      expect(engineAny.emoteClipCache.size).toBe(0);
    });

    it("emoteRequestId is not incremented when no VRM is loaded", async () => {
      const engineAny = engine as unknown as {
        emoteRequestId: number;
      };
      const initial = engineAny.emoteRequestId;

      // playEmote bails early (no VRM loaded) before incrementing the id
      await engine.playEmote("/mock/emote.glb", 2, false);
      expect(engineAny.emoteRequestId).toBe(initial);
    });
  });

  // ── 6. loadVrmFromUrl guards ─────────────────────────────────────
  describe("loadVrmFromUrl guards", () => {
    it("throws when engine is not initialized", async () => {
      await expect(
        engine.loadVrmFromUrl("http://example.com/model.vrm"),
      ).rejects.toThrow("VrmEngine not initialized");
    });

    it("registers WebGPU-compatible VRM material loading when WebGPU is active", async () => {
      hoisted.navigatorMock.gpu = {};
      (
        window.localStorage.getItem as ReturnType<typeof vi.fn>
      ).mockReturnValueOnce("webgpu");
      hoisted.mockLoaderLoadAsync.mockRejectedValueOnce(
        new Error("stop-after-register"),
      );
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      await expect(
        engine.loadVrmFromUrl("http://example.com/model.vrm"),
      ).rejects.toThrow("stop-after-register");

      expect(hoisted.mockMToonMaterialLoaderPlugin).toHaveBeenCalledTimes(1);
      expect(hoisted.mockLoaderSetMeshoptDecoder).toHaveBeenCalledWith(
        expect.objectContaining({ supported: true }),
      );
      expect(hoisted.mockLoaderSetDRACOLoader).toHaveBeenCalledTimes(1);
      expect(hoisted.mockDracoLoaderSetDecoderConfig).toHaveBeenCalledWith({
        type: "wasm",
      });
      expect(hoisted.mockDracoLoaderSetDecoderPath).toHaveBeenCalledWith(
        expect.stringContaining("vrm-decoders/draco/"),
      );
      expect(hoisted.mockDracoLoaderPreload).toHaveBeenCalledTimes(1);
      expect(hoisted.mockMToonMaterialLoaderPlugin).toHaveBeenCalledWith(
        hoisted.mockLoaderParser,
        expect.objectContaining({
          materialType: expect.any(Function),
        }),
      );
      expect(hoisted.mockVRMLoaderPlugin).toHaveBeenCalledWith(
        hoisted.mockLoaderParser,
        expect.any(Object),
      );
    });

    it("captures load errors in engine state", async () => {
      hoisted.mockLoaderLoadAsync.mockRejectedValueOnce(
        new Error("meshopt decode failed"),
      );
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      await expect(
        engine.loadVrmFromUrl("http://example.com/model.vrm"),
      ).rejects.toThrow("meshopt decode failed");

      expect(engine.getState().loadError).toBe("meshopt decode failed");
    });

    it("fetches gzipped assets and parses the decompressed buffer", async () => {
      const parseResult = { userData: { vrm: undefined } };
      hoisted.mockLoaderLoadAsync.mockResolvedValueOnce(parseResult);
      const compressed = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]).buffer;
      hoisted.responseArrayBufferMock.mockResolvedValueOnce(compressed);

      class MockDecompressionStream {
        readable = new ReadableStream<Uint8Array>();
        writable = new WritableStream<Uint8Array>();
      }

      const originalDecompressionStream = globalThis.DecompressionStream;
      Object.assign(globalThis, {
        DecompressionStream:
          MockDecompressionStream as unknown as typeof DecompressionStream,
      });

      const pipeThroughSpy = vi
        .spyOn(Blob.prototype, "stream")
        .mockReturnValue({
          pipeThrough: vi.fn(() => new ReadableStream<Uint8Array>()),
        } as unknown as ReturnType<Blob["stream"]>);
      const responseArrayBuffer = vi
        .spyOn(Response.prototype, "arrayBuffer")
        .mockResolvedValueOnce(new ArrayBuffer(16));

      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      await expect(
        engine.loadVrmFromUrl("http://example.com/model.vrm.gz"),
      ).rejects.toThrow("Loaded asset is not a VRM");

      expect(hoisted.fetchMock).toHaveBeenCalledWith(
        "http://example.com/model.vrm.gz",
      );
      expect(pipeThroughSpy).toHaveBeenCalledTimes(1);
      expect(responseArrayBuffer).toHaveBeenCalledTimes(1);
      expect(hoisted.mockLoaderLoadAsync).toHaveBeenCalledWith(
        expect.stringMatching(/^blob:/),
      );

      responseArrayBuffer.mockRestore();
      pipeThroughSpy.mockRestore();
      Object.assign(globalThis, {
        DecompressionStream: originalDecompressionStream,
      });
    });
  });

  describe("camera framing transitions", () => {
    it("keeps the initial avatar load camera framing immediate", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      const engineAny = engine as unknown as {
        cameraManager: {
          centerAndFrame: ReturnType<typeof vi.fn>;
          ensureFacingCamera: ReturnType<typeof vi.fn>;
        };
        configureAvatarLookTracking: ReturnType<typeof vi.fn>;
        loadAndPlayIdle: ReturnType<typeof vi.fn>;
        playTeleportReveal: ReturnType<typeof vi.fn>;
        startPendingWorldReveal: ReturnType<typeof vi.fn>;
        isCameraTransitioning: boolean;
        transitionDuration: number;
      };
      const vrm = createMockLoadedVrm();

      engineAny.cameraManager.centerAndFrame = vi.fn((_vrm, camera) => {
        camera.fov = 31;
      });
      engineAny.cameraManager.ensureFacingCamera = vi.fn();
      engineAny.configureAvatarLookTracking = vi.fn();
      engineAny.loadAndPlayIdle = vi.fn().mockResolvedValue(undefined);
      engineAny.playTeleportReveal = vi.fn().mockResolvedValue(undefined);
      engineAny.startPendingWorldReveal = vi.fn();
      hoisted.mockLoaderLoadAsync.mockResolvedValueOnce({ userData: { vrm } });

      await engine.loadVrmFromUrl("http://example.com/model.vrm");

      expect(engineAny.cameraManager.centerAndFrame).toHaveBeenCalledTimes(1);
      expect(engineAny.isCameraTransitioning).toBe(false);
      expect(engineAny.transitionDuration).toBe(0.8);
    });

    it("smoothly transitions the camera when switching avatars", async () => {
      const canvas = createMockCanvas();
      engine.setup(canvas, vi.fn());
      await waitForEngineReady(engine);

      const engineAny = engine as unknown as {
        vrm: {
          scene: {
            parent: { remove: ReturnType<typeof vi.fn> } | null;
          };
        } | null;
        cameraManager: {
          centerAndFrame: ReturnType<typeof vi.fn>;
          ensureFacingCamera: ReturnType<typeof vi.fn>;
        };
        configureAvatarLookTracking: ReturnType<typeof vi.fn>;
        loadAndPlayIdle: ReturnType<typeof vi.fn>;
        playTeleportReveal: ReturnType<typeof vi.fn>;
        startPendingWorldReveal: ReturnType<typeof vi.fn>;
        isCameraTransitioning: boolean;
        transitionDuration: number;
      };
      const previousParent = { remove: vi.fn() };
      const vrm = createMockLoadedVrm();

      engineAny.vrm = {
        scene: {
          parent: previousParent,
        },
      };
      engineAny.cameraManager.centerAndFrame = vi.fn((_vrm, camera) => {
        camera.fov = 36;
      });
      engineAny.cameraManager.ensureFacingCamera = vi.fn();
      engineAny.configureAvatarLookTracking = vi.fn();
      engineAny.loadAndPlayIdle = vi.fn().mockResolvedValue(undefined);
      engineAny.playTeleportReveal = vi.fn().mockResolvedValue(undefined);
      engineAny.startPendingWorldReveal = vi.fn();
      hoisted.mockLoaderLoadAsync.mockResolvedValueOnce({ userData: { vrm } });

      await engine.loadVrmFromUrl("http://example.com/model.vrm");

      expect(previousParent.remove).toHaveBeenCalledTimes(1);
      expect(engineAny.cameraManager.centerAndFrame).toHaveBeenCalledTimes(1);
      expect(engineAny.isCameraTransitioning).toBe(true);
      expect(engineAny.transitionDuration).toBe(3);
    });
  });
});
