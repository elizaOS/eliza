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
}

/** A controller/headset aiming ray in emulated world space. */
export interface AimingRay {
  source: "headset" | Handedness;
  origin: Vec3;
  /** Unit forward direction (the device's -Z rotated by its orientation). */
  direction: Vec3;
  /** Where that ray lands in screen space (CSS px), via the pinhole projection. */
  reticle: { x: number; y: number };
}

/** The element a ray resolves to, computed via document.elementFromPoint. */
export interface HitResult {
  source: "headset" | Handedness;
  /** `data-agent-id` / `id` of the hit element, or null when the ray hits nothing. */
  elementId: string | null;
  point: { x: number; y: number };
}

/** A full deterministic snapshot of the emulated scene for assertions + capture. */
export interface TelemetrySnapshot {
  /** ms since the emulator installed (monotonic, for the per-frame log). */
  t: number;
  sessionActive: boolean;
  headset: XRPose;
  controllers: Partial<Record<Handedness, XRPose>>;
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
  /** Set a hand's named pose (e.g. "default", "pinch"); connects it if needed. */
  setHandPose(handedness: Handedness, poseId: string): void;
  /**
   * Orient a controller so its forward ray's reticle lands on the screen center
   * of the first element matching `selector`. Returns false if not found.
   */
  aimControllerAt(handedness: Handedness, selector: string): boolean;

  // ── Input events ─────────────────────────────────────────────────────────
  /** Fire selectstart/select/selectend on the controller (trigger button). */
  pressSelect(handedness: Handedness): Promise<void>;
  /** Fire squeezestart/squeeze/squeezeend on the controller (grip button). */
  pressSqueeze(handedness: Handedness): Promise<void>;

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
}

export interface InputEventRecord {
  handedness: Handedness | "unknown";
  t: number;
}

declare global {
  interface Window {
    __XREmulator: XREmulatorAPI;
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
