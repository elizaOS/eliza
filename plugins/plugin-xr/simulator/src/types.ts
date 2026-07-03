export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface XRPose {
  position: Vec3;
  orientation: Quat;
}

export interface EmulatorStats {
  sessionActive: boolean;
  framesInjected: number;
  cameraStreamActive: boolean;
  wsConnected: boolean;
}

export type Handedness = "left" | "right";

export type XRSessionMode = "immersive-vr" | "immersive-ar";

/** Screen-space telemetry for one agent-surface-tagged element. */
export interface ElementTelemetry {
  /** The element's `data-agent-id` (falls back to its `id`). */
  elementId: string;
  /** Screen-space bounding rect in CSS px. */
  rect: { x: number; y: number; width: number; height: number };
  /** Screen-space center in CSS px. */
  center: { x: number; y: number };
  /** World-space position (metres) when a 3D scene is mounted; absent in flat mode. */
  world?: Vec3;
  /** Owning panel id when a 3D scene is mounted. */
  panelId?: string;
}

/** A device's world-space aiming ray (origin + unit forward direction). */
export interface DeviceRay {
  origin: Vec3;
  direction: Vec3;
}

/**
 * The emulated device a ray/hit belongs to. `"left"`/`"right"` are the
 * controllers; hand-tracking inputs are namespaced `"hand-<handedness>"`.
 */
export type RaySource = "headset" | Handedness | `hand-${Handedness}`;

/** A controller/hand/headset aiming ray in emulated world space. */
export interface AimingRay {
  source: RaySource;
  origin: Vec3;
  /** Unit forward direction (the device's -Z rotated by its orientation). */
  direction: Vec3;
  /** Where that ray lands in screen space (CSS px), via the pinhole projection. */
  reticle: { x: number; y: number };
}

/** The element a ray resolves to, computed via document.elementFromPoint. */
export interface HitResult {
  source: RaySource;
  /** `data-agent-id` / `id` of the hit element, or null when the ray hits nothing. */
  elementId: string | null;
  point: { x: number; y: number };
  /** World-space intersection point when a 3D scene resolved the hit. */
  world?: Vec3;
  /** The panel the ray hit (3D scene mode only). */
  panelId?: string | null;
}

/** A full deterministic snapshot of the emulated scene for assertions + capture. */
export interface TelemetrySnapshot {
  /** ms since the emulator installed (monotonic, for the per-frame log). */
  t: number;
  sessionActive: boolean;
  /** "scene" when a 3D XRSpatialScene resolved the hits; "flat" for 2D DOM. */
  mode: "flat" | "scene";
  headset: XRPose;
  controllers: Partial<Record<Handedness, XRPose>>;
  /** Pose id ("default" / "pinch" / "point") per hand the harness activated. */
  hands: Partial<Record<Handedness, string>>;
  elements: ElementTelemetry[];
  rays: AimingRay[];
  /** Per-source computed hit (which element each aiming ray intersects). */
  hits: HitResult[];
}

/** window.__XREmulator — set by emulator.ts, consumed by Playwright via page.evaluate() */
export interface XREmulatorAPI {
  setPose(pose: Partial<XRPose>): void;
  injectCameraFrame(jpegDataUrl: string): Promise<void>;
  getStats(): EmulatorStats;
  /** Simulate device disconnection (closes WebSocket) */
  simulateDisconnect(): void;
  /** Simulate reconnect after a disconnect */
  simulateReconnect(): void;

  // ── Immersive session ────────────────────────────────────────────────────
  /** Start an immersive WebXR session via the IWER-polyfilled navigator.xr. */
  startSession(mode?: XRSessionMode): Promise<boolean>;
  /** End the active session. */
  endSession(): Promise<void>;

  // ── Controller + hand pose ───────────────────────────────────────────────
  /** Set a controller's world pose (connects it if needed). */
  setControllerPose(handedness: Handedness, pose: Partial<XRPose>): void;
  /**
   * Set a hand's named pose (e.g. "default", "pinch", "point"). Connects the
   * hand, makes hands the primary input modality (IWER routes select events by
   * `primaryInputMode`, like a Quest switching to hand-tracking), and places it
   * at a natural offset from the head.
   */
  setHandPose(handedness: Handedness, poseId: string): void;
  /**
   * Orient a controller so its forward ray hits the first element matching
   * `selector`. In 3D-scene mode this aims at the element's world position; in
   * flat mode it aims at the element's screen center. Returns false if not found.
   */
  aimControllerAt(handedness: Handedness, selector: string): boolean;
  /**
   * Orient a hand-tracking input so its target ray hits the first element
   * matching `selector` (same aiming semantics as aimControllerAt). Activates
   * the hand like setHandPose. Returns false if the element is not found.
   */
  aimHandAt(handedness: Handedness, selector: string): boolean;
  /**
   * Orient the HEADSET so its forward (gaze) ray hits the first element
   * matching `selector`. The headset ray is the only gaze-style ray IWER can
   * emulate — see getInputSources() for the input-source-level limitation.
   */
  aimHeadAt(selector: string): boolean;

  // ── Pose read-back (consumed by the 3D scene + assertions) ────────────────
  /** The current emulated headset world pose. */
  getHeadPose(): XRPose;
  /** A connected controller's world pose, or null when it isn't connected. */
  getControllerPose(handedness: Handedness): XRPose | null;
  /** A controller's world-space aiming ray, or null when it isn't connected. */
  getControllerRay(handedness: Handedness): DeviceRay | null;
  /** True when an XRSpatialScene is mounted and driving 3D hit-tests. */
  hasScene(): boolean;

  // ── Manipulation ─────────────────────────────────────────────────────────
  /**
   * Drag the panel a controller is aimed at by a world delta (metres), as a
   * grab-move. Returns the panel's new world position, or null when the
   * controller isn't aimed at a panel / no scene is mounted.
   */
  dragController(handedness: Handedness, delta: Vec3): Vec3 | null;
  /**
   * Drag the panel a hand-tracking input is aimed at by a world delta (metres),
   * as a pinch-grab-move — the hand-tracking analogue of {@link dragController}.
   * Returns the panel's new world position, or null when the hand isn't aimed
   * at a panel / no scene is mounted.
   */
  dragHand(handedness: Handedness, delta: Vec3): Vec3 | null;

  // ── Input events ─────────────────────────────────────────────────────────
  /** Fire selectstart/select/selectend on the controller (trigger button). */
  pressSelect(handedness: Handedness): Promise<void>;
  /** Fire squeezestart/squeeze/squeezeend on the controller (grip button). */
  pressSqueeze(handedness: Handedness): Promise<void>;
  /**
   * Pinch-select with a hand-tracking input: drives the hand's analog "pinch"
   * gamepad button 0→1→0 so IWER fires real selectstart/select/selectend from
   * the HAND XRInputSource, and (in 3D-scene mode) presses the element the
   * hand ray currently hits so the authored view's real handler fires.
   */
  pressHandSelect(handedness: Handedness): Promise<void>;

  // ── Telemetry + capture ──────────────────────────────────────────────────
  /**
   * Snapshot the emulated scene: head/controller/hand poses, every
   * `selector`-matched element's screen rect, each device's aiming ray, and the
   * computed hit per ray. Also appended to the per-frame log.
   */
  getElementTelemetry(selector?: string): TelemetrySnapshot;
  /** The accumulated per-frame telemetry log (for the capture JSON artifact). */
  getFrameLog(): TelemetrySnapshot[];
  /** select events the active session received (proves pressSelect fired). */
  getSelectLog(): InputEventRecord[];
  /** squeeze events the active session received (proves pressSqueeze fired). */
  getSqueezeLog(): InputEventRecord[];
  /**
   * The active session's live XRInputSource list (what a WebXR app would see).
   * IWER 2.2.1 can only surface `targetRayMode: "tracked-pointer"` sources
   * (controllers + hands) — there is no gaze/transient-pointer emulation; the
   * gaze e2e pins that limitation with this read-back.
   */
  getInputSources(): InputSourceSnapshot[];
}

/** A session `select`/`squeeze` event as observed by the harness. */
export interface InputEventRecord {
  handedness: Handedness | "unknown";
  /** True when the event's XRInputSource is a hand-tracking input. */
  viaHand: boolean;
  /** The event source's targetRayMode ("tracked-pointer" for IWER inputs). */
  targetRayMode: string;
  t: number;
}

/** Read-back of one live session XRInputSource. */
export interface InputSourceSnapshot {
  handedness: string;
  targetRayMode: string;
  /** True when the source carries an XRHand (hand-tracking input). */
  hasHand: boolean;
  profiles: string[];
}

/**
 * The imperative surface a mounted `XRSpatialScene` (`@elizaos/ui/spatial`)
 * publishes. The emulator reads poses out and pushes rays in to drive real 3D
 * hit-tests. Structurally typed here so the simulator stays decoupled from the UI
 * package (the scene owns the canonical definition).
 */
export interface XRSceneBridge {
  readonly version: number;
  hitTest(ray: DeviceRay): {
    panelId: string;
    elementId: string | null;
    world: Vec3;
    u: number;
    v: number;
    screen: { x: number; y: number };
  } | null;
  getPanels(): Array<{
    id: string;
    position: Vec3;
    depth: number;
    visible: boolean;
  }>;
  worldPositionOf(elementId: string): Vec3 | null;
  aimFor(from: Vec3, elementId: string): Quat | null;
  dragPanel(panelId: string, delta: Vec3): Vec3 | null;
  pressRay(
    ray: DeviceRay,
  ): { panelId: string; elementId: string | null } | null;
  sync(): void;
}

declare global {
  interface Window {
    __XREmulator: XREmulatorAPI;
    /** Present iff an XRSpatialScene is mounted (3D-scene mode). */
    __elizaXRScene?: XRSceneBridge;
    /** Set by app-xr/src/main.ts in VITE_TEST mode */
    __xrTestHooks: {
      sendAudioChunk(
        base64: string,
        sampleRate: number,
        encoding: string,
      ): void;
      getSocketState(): "CONNECTING" | "OPEN" | "CLOSING" | "CLOSED";
      sendPing?(): void;
    };
  }
}
