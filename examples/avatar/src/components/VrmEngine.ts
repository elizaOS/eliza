import * as THREE from "three";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type VrmEngineState = {
  vrmLoaded: boolean;
  vrmName: string | null;
  idlePlaying: boolean;
  idleTime: number;
  idleTracks: number;
};

type UpdateCallback = () => void;

export type CameraAnimationConfig = {
  /** Enable subtle camera movement */
  enabled: boolean;
  /** Horizontal sway amplitude (default: 0.08) */
  swayAmplitude: number;
  /** Vertical bob amplitude (default: 0.04) */
  bobAmplitude: number;
  /** Rotation amplitude in radians (default: 0.015) */
  rotationAmplitude: number;
  /** Animation speed multiplier (default: 1) */
  speed: number;
};

const DEFAULT_CAMERA_ANIMATION: CameraAnimationConfig = {
  enabled: true,
  swayAmplitude: 0.08,
  bobAmplitude: 0.04,
  rotationAmplitude: 0.015,
  speed: 1,
};

export class VrmEngine {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private clock = new THREE.Clock();
  private vrm: VRM | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private animationFrameId: number | null = null;
  private onUpdate: UpdateCallback | null = null;
  private initialized = false;
  private loadingAborted = false;

  private mouthValue = 0;
  private mouthSmoothed = 0;
  private vrmName: string | null = null;
  private lookAtTarget = new THREE.Vector3(0, 1, 0);
  private readonly idleGlbUrl = "/animations/idle.glb";
  private forceFaceCameraFlip = true;

  // Camera animation state
  private cameraAnimation: CameraAnimationConfig = { ...DEFAULT_CAMERA_ANIMATION };
  private baseCameraPosition = new THREE.Vector3();
  private elapsedTime = 0;

  setup(canvas: HTMLCanvasElement, onUpdate: UpdateCallback): void {
    // If already initialized with this canvas, just update the callback
    if (this.initialized && this.renderer?.domElement === canvas) {
      this.onUpdate = onUpdate;
      return;
    }

    // If initialized with a different canvas, dispose first
    if (this.initialized) {
      this.dispose();
    }

    this.onUpdate = onUpdate;
    this.loadingAborted = false;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(25, 1, 0.01, 1000);
    // Will be re-framed once a VRM loads; keep a sane default.
    camera.position.set(0, 1.1, 2.8);
    this.camera = camera;

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(1.5, 2.0, 1.5);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
    fillLight.position.set(-1.8, 1.0, 1.0);
    scene.add(fillLight);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);

    this.resize(canvas.clientWidth, canvas.clientHeight);
    this.initialized = true;
    this.loop();
  }

  isInitialized(): boolean {
    return this.initialized && this.renderer !== null;
  }

  dispose(): void {
    this.loadingAborted = true;
    this.initialized = false;

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.scene && this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.vrm = null;
    this.vrmName = null;
    this.mixer = null;
    this.idleAction = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.onUpdate = null;
  }

  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    if (width <= 0 || height <= 0) return;
    const aspect = width / height;
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    // In some edge cases (e.g. transient 0/NaN layout sizes during mount),
    // updating the projection can throw. Keep resize safe.
    this.renderer.setSize(width, height, false);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  getState(): VrmEngineState {
    const idlePlaying = this.idleAction?.isRunning() ?? false;
    return {
      vrmLoaded: this.vrm !== null,
      vrmName: this.vrmName,
      idlePlaying,
      idleTime: this.idleAction?.time ?? 0,
      idleTracks: this.idleAction?.getClip()?.tracks.length ?? 0,
    };
  }

  setMouthOpen(value: number): void {
    this.mouthValue = Math.max(0, Math.min(1, value));
  }

  setCameraAnimation(config: Partial<CameraAnimationConfig>): void {
    this.cameraAnimation = { ...this.cameraAnimation, ...config };
  }

  getCameraAnimation(): CameraAnimationConfig {
    return { ...this.cameraAnimation };
  }

  /**
   * Some VRMs ship facing the opposite direction. When true (default), we apply
   * a deterministic 180° Y-rotation after load to ensure the character faces the camera.
   */
  setForceFaceCameraFlip(enabled: boolean): void {
    this.forceFaceCameraFlip = enabled;
  }

  async loadVrmFromUrl(url: string, name?: string): Promise<void> {
    if (!this.scene) throw new Error("VrmEngine not initialized");
    if (!this.camera) throw new Error("VrmEngine not initialized");
    if (this.loadingAborted) return;

    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
      this.vrmName = null;
      this.mixer = null;
      this.idleAction = null;
    }

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    // three-vrm can emit noisy warnings for some VRMs (e.g. duplicate expression entries).
    // Filter those during load so the console stays usable.
    const originalWarn = console.warn;
    type ConsoleArg = string | number | boolean | bigint | symbol | null | undefined | object;
    console.warn = (...args: ConsoleArg[]) => {
      const msg = args.map((a) => String(a)).join(" ");
      if (msg.includes("VRMExpressionLoaderPlugin: An expression preset")) return;
      originalWarn(...args);
    };

    let gltf: Awaited<ReturnType<typeof loader.loadAsync>>;
    try {
      gltf = await loader.loadAsync(url);
    } finally {
      console.warn = originalWarn;
    }

    // Check if aborted after async load
    if (this.loadingAborted || !this.scene) return;

    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      throw new Error("Loaded asset is not a VRM");
    }

    // Critical for animation: if we animate normalized bones (common for retargeting),
    // `autoUpdateHumanBones` must be enabled so the pose is transferred to the raw bones
    // that the skinned mesh is actually bound to. If this is off, you'll see "T-pose mesh"
    // while something else appears to animate.
    if (vrm.humanoid) {
      vrm.humanoid.autoUpdateHumanBones = true;
    }

    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    // `removeUnnecessaryJoints` is deprecated in recent three-vrm.
    // `combineSkeletons` tends to improve performance and will remain supported.
    VRMUtils.combineSkeletons(vrm.scene);

    // Auto-center + frame camera based on the model bounds.
    this.centerAndFrame(vrm);
    // Ensure the model faces the camera.
    // The heuristic can be unreliable depending on bone forward vectors, so we provide a
    // deterministic flip for this demo (default on), then run the heuristic as a fallback.
    if (this.forceFaceCameraFlip) {
      vrm.scene.rotateY(Math.PI);
      vrm.scene.updateMatrixWorld(true);
    } else {
      // Some models/exports end up facing away from the camera (common across VRM0/VRM1 sources).
      // Use a cheap heuristic to flip the avatar 180° if it's looking away.
      this.ensureFacingCamera(vrm);
    }

    // Check again before modifying scene
    if (this.loadingAborted || !this.scene) return;

    // Avoid a brief "T-pose flash" while the idle animation is still loading/retargeting.
    // We'll reveal the model once the mixer is playing (or once we've given up).
    vrm.scene.visible = false;
    this.scene.add(vrm.scene);
    this.vrm = vrm;
    this.vrmName = name ?? null;

    // Try to load and play an idle animation (best-effort).
    try {
      await this.loadAndPlayIdle(vrm);
      // Final check before making visible
      if (!this.loadingAborted && this.vrm === vrm) {
        vrm.scene.visible = true;
      }
    } catch {
      // If the idle animation can't load/retarget, keep the avatar static.
      if (!this.loadingAborted && this.vrm === vrm) {
        vrm.scene.visible = true;
      }
    }
  }

  private loop(): void {
    this.animationFrameId = requestAnimationFrame(() => this.loop());
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera) return;

    const delta = this.clock.getDelta();
    this.elapsedTime += delta;
    this.mixer?.update(delta);
    if (this.vrm) {
      this.applyMouthToVrm(this.vrm, this.mouthValue);
      this.vrm.update(delta);
    }

    // Apply subtle camera animation
    if (this.cameraAnimation.enabled && this.baseCameraPosition.length() > 0) {
      const t = this.elapsedTime * this.cameraAnimation.speed;

      // Layered sine waves for organic movement
      const swayX =
        Math.sin(t * 0.5) * 0.6 +
        Math.sin(t * 0.8 + 1.2) * 0.25 +
        Math.sin(t * 1.3 + 2.5) * 0.15;

      const bobY =
        Math.sin(t * 0.7 + 0.5) * 0.5 +
        Math.sin(t * 1.1 + 1.8) * 0.3 +
        Math.sin(t * 0.3) * 0.2;

      const swayZ =
        Math.sin(t * 0.4 + 1.0) * 0.4 +
        Math.sin(t * 0.9 + 2.0) * 0.3;

      camera.position.x =
        this.baseCameraPosition.x + swayX * this.cameraAnimation.swayAmplitude;
      camera.position.y =
        this.baseCameraPosition.y + bobY * this.cameraAnimation.bobAmplitude;
      camera.position.z =
        this.baseCameraPosition.z + swayZ * this.cameraAnimation.swayAmplitude * 0.5;

      // Subtle rotation for more life
      const rotX = Math.sin(t * 0.6 + 0.3) * this.cameraAnimation.rotationAmplitude * 0.5;
      const rotY = Math.sin(t * 0.4) * this.cameraAnimation.rotationAmplitude;

      camera.rotation.x = rotX;
      camera.rotation.y = rotY;
    }

    camera.lookAt(this.lookAtTarget);
    renderer.render(scene, camera);
    this.onUpdate?.();
  }

  private centerAndFrame(vrm: VRM): void {
    const camera = this.camera;
    if (!camera) return;

    // Compute bounds in current pose.
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // Move VRM so its bounding box center is at origin.
    vrm.scene.position.sub(center);

    // Recompute after centering (more stable).
    const box2 = new THREE.Box3().setFromObject(vrm.scene);
    const size2 = box2.getSize(new THREE.Vector3());

    const height = Math.max(0.001, size2.y);
    const width = Math.max(0.001, size2.x);
    const depth = Math.max(0.001, size2.z);
    const maxDim = Math.max(width, height, depth);

    // Position camera at chest height (~70% of avatar height from bottom)
    const chestHeight = height * 0.35; // 0.35 since model is centered (0 = center, so 0.35 up = ~70% from ground)

    // Look at chest level
    this.lookAtTarget.set(0, chestHeight, 0);

    // Fit to vertical FOV.
    const fovRad = (camera.fov * Math.PI) / 180;
    const fitDistance = (maxDim * 0.5) / Math.tan(fovRad * 0.5);
    const distance = fitDistance * 1.1; // slightly closer framing

    camera.near = Math.max(0.01, distance / 100);
    camera.far = Math.max(100, distance * 100);
    camera.updateProjectionMatrix();

    // Camera at chest height
    camera.position.set(0, chestHeight, distance);

    // Store base position for camera animation
    this.baseCameraPosition.copy(camera.position);
  }

  private async loadAndPlayIdle(vrm: VRM): Promise<void> {
    // Check if aborted before starting
    if (this.loadingAborted) return;

    const { retargetMixamoGltfToVrm } = await import("../vrm/retargetMixamoGltfToVrm");

    // Check again after dynamic import
    if (this.loadingAborted || this.vrm !== vrm) return;

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(this.idleGlbUrl);

    // Check after animation load
    if (this.loadingAborted || this.vrm !== vrm) return;

    // Ensure the source scene has valid world matrices before retargeting.
    gltf.scene.updateMatrixWorld(true);
    vrm.scene.updateMatrixWorld(true);
    const clip = retargetMixamoGltfToVrm(
      { scene: gltf.scene, animations: gltf.animations },
      vrm,
    );

    // Final check before setting up mixer
    if (this.loadingAborted || this.vrm !== vrm) return;

    const mixer = new THREE.AnimationMixer(vrm.scene);
    this.mixer = mixer;

    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.fadeIn(0.25);
    action.play();
    this.idleAction = action;
  }

  private applyMouthToVrm(vrm: VRM, mouth: number): void {
    const manager = vrm.expressionManager;
    if (!manager) return;

    // Smooth a bit so it doesn't chatter (volume is very spiky).
    const next = Math.max(0, Math.min(1, mouth));
    this.mouthSmoothed = this.mouthSmoothed * 0.75 + next * 0.25;

    // Most VRM avatars support viseme presets like: aa/ih/ou/ee/oh.
    // If a model doesn't, these calls are no-ops.
    manager.setValue("aa", this.mouthSmoothed);
  }

  private ensureFacingCamera(vrm: VRM): void {
    const camera = this.camera;
    if (!camera) return;

    // Prefer a humanoid bone if available (more reliable than root).
    const probe = vrm.humanoid?.getNormalizedBoneNode("hips") ?? vrm.scene;
    vrm.scene.updateMatrixWorld(true);

    const forward = new THREE.Vector3();
    probe.getWorldDirection(forward);

    const vrmPos = new THREE.Vector3();
    vrm.scene.getWorldPosition(vrmPos);

    const toCamera = new THREE.Vector3().subVectors(camera.position, vrmPos);

    // Compare in XZ plane (ignore vertical tilt).
    forward.y = 0;
    toCamera.y = 0;
    if (forward.lengthSq() < 1e-6 || toCamera.lengthSq() < 1e-6) return;

    forward.normalize();
    toCamera.normalize();

    // If the avatar's forward is pointing away from the camera, flip it.
    if (forward.dot(toCamera) < 0) {
      vrm.scene.rotateY(Math.PI);
      vrm.scene.updateMatrixWorld(true);
    }
  }
}

