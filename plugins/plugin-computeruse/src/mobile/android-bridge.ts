/**
 * Android computer-use bridge — Capacitor JS↔Kotlin contract.
 *
 * Android allows more cross-app surface than iOS, but the consumer-app
 * path still requires explicit permissions:
 *
 *   1. AccessibilityService (BIND_ACCESSIBILITY_SERVICE) — walk and drive
 *      the active window's view hierarchy, dispatch gestures.
 *   2. MediaProjection — user-consent screen capture at 1–2 Hz.
 *   3. UsageStatsManager (PACKAGE_USAGE_STATS) — app history; manually
 *      granted in Settings > Usage Access.
 *   4. Camera2 — CAMERA permission; service-friendly (no Activity).
 *   5. onTrimMemory → MemoryArbiter pressure (ComponentCallbacks2).
 *
 * The AOSP system-app path (SurfaceControl.captureDisplay, injectInputEvent,
 * IActivityManager) is documented separately in AOSP_SYSTEM_APP.md but is
 * never compiled into the consumer build.
 *
 * The Kotlin counterpart is:
 *   plugin-capacitor-bridge/android/src/main/java/ai/elizaos/computeruse/ComputerUsePlugin.kt
 *
 * The Capacitor plugin jsName is "ComputerUse" — same as iOS. Both platforms
 * resolve through `Capacitor.Plugins.ComputerUse` so the planner layer can
 * dispatch without a platform branch at the call site.
 *
 * MARK: - Contract
 * Every method in AndroidComputerUseBridge below has a matching @PluginMethod
 * in ComputerUsePlugin.kt. Keep them in lock-step or the bridge silently drifts.
 */

// ── Result envelope ───────────────────────────────────────────────────────────

/**
 * Standard result envelope mirroring IosBridgeResult<T> from ios-bridge.ts.
 * `ok=true` means the native side completed and `data` is shaped per-method.
 * `ok=false` carries a machine-readable `code` and human-readable `message`.
 */
export type AndroidBridgeResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly code: AndroidBridgeErrorCode;
      readonly message: string;
    };

export type AndroidBridgeErrorCode =
  | "unsupported_platform" // API level below minimum
  | "permission_denied" // runtime or special permission not granted
  | "permission_pending" // consent dialog shown, result pending
  | "accessibility_unavailable" // MiladyAccessibilityService not running
  | "capture_unavailable" // MediaProjection not started or no frame yet
  | "camera_not_open" // startCamera not called
  | "invalid_argument" // unknown gesture type / action name
  | "internal_error";

// ── 1. MediaProjection screen capture ────────────────────────────────────────

export interface MediaProjectionStartOptions {
  /** Capture frame rate, Hz. Default 1. */
  readonly fps?: number;
}

export interface MediaProjectionHandle {
  readonly running: boolean;
}

export interface CapturedScreenFrame {
  /** Base64-encoded JPEG at quality 75. */
  readonly jpegBase64: string;
  readonly width: number;
  readonly height: number;
  /** Wall-clock ms when the frame was committed to the ImageReader. */
  readonly timestampMs: number;
}

// ── 2. AccessibilityService — element tree ────────────────────────────────────

/**
 * Compact node shape matching WS6 Scene.ax:
 *   [{ id, role, label, bbox, actions }]
 *
 * `id`      — integer cast to string; stable within a single snapshot,
 *             not across snapshots (AccessibilityNodeInfo has no stable ids).
 * `role`    — Android class name, e.g. "android.widget.Button".
 * `label`   — contentDescription or text, whichever is non-null.
 * `bbox`    — screen-coordinates rectangle {x, y, w, h}.
 * `actions` — subset of {"click","longClick","scroll","type","focus"}.
 */
export interface AndroidAxNode {
  readonly id: string;
  readonly role: string;
  readonly label: string | null;
  readonly bbox: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
  readonly actions: readonly string[];
}

export interface AccessibilityTreeResult {
  /** JSON-serialized AndroidAxNode[]. Parsed by the JS caller. */
  readonly nodes: string;
}

// ── 3. Gesture dispatch ───────────────────────────────────────────────────────

export type GestureType = "tap" | "swipe";

export interface TapGestureArgs {
  readonly type: "tap";
  readonly x: number;
  readonly y: number;
}

export interface SwipeGestureArgs {
  readonly type: "swipe";
  readonly x: number;
  readonly y: number;
  readonly x2: number;
  readonly y2: number;
  /** Swipe duration in ms. Minimum 50ms enforced on native side. Default 300. */
  readonly durationMs?: number;
}

export type GestureArgs = TapGestureArgs | SwipeGestureArgs;

export interface GestureResult {
  readonly ok: boolean;
}

// ── 4. Global actions ─────────────────────────────────────────────────────────

export type GlobalAction = "back" | "home" | "recents" | "notifications";

export interface GlobalActionResult {
  readonly ok: boolean;
}

export interface SetTextArgs {
  readonly text: string;
}

export interface SetTextResult {
  readonly ok: boolean;
}

// ── 5. UsageStats / app enumeration ──────────────────────────────────────────

/**
 * Mirrors WS6's `enumerateApps()` interface.
 * `isForeground` is true when the package appears as the last
 * MOVE_TO_FOREGROUND event in the past 5 minutes.
 */
export interface AppUsageEntry {
  readonly packageName: string;
  readonly label: string;
  readonly lastUsedMs: number;
  readonly totalForegroundMs: number;
  readonly isForeground: boolean;
}

export interface EnumerateAppsResult {
  /** JSON-serialized AppUsageEntry[]. Parsed by the JS caller. */
  readonly apps: string;
}

// ── 6. Memory pressure ────────────────────────────────────────────────────────

export type AndroidPressureLevel = "nominal" | "low" | "critical";

/**
 * Snapshot of the Android process memory state.
 * Aligns with IPressureSignal from ios-bridge.ts (source = "android-low-memory").
 */
export interface AndroidMemoryPressureSnapshot {
  readonly level: AndroidPressureLevel;
  readonly freeMb: number;
  readonly maxMb: number;
  readonly usedMb: number;
  readonly source: "android-runtime";
}

// ── 7. Camera (MobileCameraSource) ───────────────────────────────────────────

export interface AndroidCameraOpenOptions {
  readonly cameraId?: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
}

export interface AndroidCameraOpenResult {
  /** JSON-serialized CameraEntry[]. */
  readonly cameras: string;
}

export interface AndroidCameraEntry {
  readonly id: string;
  readonly label: string;
  readonly position: "back" | "front" | "external";
}

export interface AndroidCameraFrameResult {
  /** Base64-encoded JPEG. */
  readonly jpegBase64: string;
}

// ── 8. Probe ──────────────────────────────────────────────────────────────────

export interface AndroidBridgeProbe {
  readonly platform: "android";
  /** e.g. "14" — Build.VERSION.RELEASE. */
  readonly osVersion: string;
  /** SDK integer, e.g. 34. */
  readonly sdkInt: number;
  readonly capabilities: {
    readonly mediaProjection: boolean;
    readonly accessibilityService: boolean;
    readonly usageStats: boolean;
    readonly camera: boolean;
    readonly aospPrivileged: boolean;
  };
}

// ── Bridge interface ──────────────────────────────────────────────────────────

/**
 * Strict TS interface for the Capacitor Android plugin. Every method returns
 * AndroidBridgeResult<T> — Kotlin never throws across the bridge.
 *
 * The Capacitor plugin name on the Kotlin side is "ComputerUse". The jsName
 * resolves to `Capacitor.Plugins.ComputerUse` on Android and iOS alike.
 */
export interface AndroidComputerUseBridge {
  // --- Probe ---
  readonly probe: () => Promise<AndroidBridgeResult<AndroidBridgeProbe>>;

  // --- MediaProjection ---
  /** Triggers the system screen-capture consent dialog, then starts the service. */
  readonly startMediaProjection: (
    options?: MediaProjectionStartOptions,
  ) => Promise<AndroidBridgeResult<MediaProjectionHandle>>;
  readonly stopMediaProjection: () => Promise<
    AndroidBridgeResult<{ readonly stopped: boolean }>
  >;
  /** Drain the latest frame from the ImageReader ring-buffer. */
  readonly captureFrame: () => Promise<
    AndroidBridgeResult<CapturedScreenFrame>
  >;

  // --- AccessibilityService ---
  /** Walk getRootInActiveWindow() and return compact JSON node array. */
  readonly getAccessibilityTree: () => Promise<
    AndroidBridgeResult<AccessibilityTreeResult>
  >;
  readonly dispatchGesture: (
    args: GestureArgs,
  ) => Promise<AndroidBridgeResult<GestureResult>>;
  readonly performGlobalAction: (args: {
    readonly action: GlobalAction;
  }) => Promise<AndroidBridgeResult<GlobalActionResult>>;
  readonly setText: (
    args: SetTextArgs,
  ) => Promise<AndroidBridgeResult<SetTextResult>>;

  // --- UsageStats ---
  readonly enumerateApps: () => Promise<
    AndroidBridgeResult<EnumerateAppsResult>
  >;

  // --- Memory ---
  readonly getMemoryPressureSnapshot: () => Promise<
    AndroidBridgeResult<AndroidMemoryPressureSnapshot>
  >;
  /**
   * Called from the onTrimMemory ComponentCallbacks2 listener to propagate
   * the pressure level to the JS-side WS1 MemoryArbiter.
   *
   * Call chain:
   *   Kotlin ComponentCallbacks2.onTrimMemory(level)
   *   → notifyListeners("memoryPressure", { level, freeMb })
   *   → JS capacitorPressureSource.dispatch(level, freeMb)
   *   → MemoryArbiter pressure listener
   */
  readonly dispatchMemoryPressure: (args: {
    readonly level: AndroidPressureLevel;
    readonly freeMb?: number;
  }) => Promise<AndroidBridgeResult<{ readonly ok: boolean }>>;

  // --- Camera (MobileCameraSource) ---
  readonly startCamera: (
    options?: AndroidCameraOpenOptions,
  ) => Promise<AndroidBridgeResult<AndroidCameraOpenResult>>;
  readonly stopCamera: () => Promise<
    AndroidBridgeResult<{ readonly ok: boolean }>
  >;
  readonly captureFrameCamera: () => Promise<
    AndroidBridgeResult<AndroidCameraFrameResult>
  >;
}

// ── Default constants ─────────────────────────────────────────────────────────

/** Capacitor plugin jsName — resolves to `Capacitor.Plugins.ComputerUse` on both platforms. */
export const ANDROID_BRIDGE_JS_NAME = "ComputerUse" as const;

/** Default MediaProjection frame rate. Higher values drain battery significantly. */
export const ANDROID_DEFAULT_FPS = 1 as const;

/** Default Camera2 capture resolution. */
export const ANDROID_DEFAULT_CAMERA_WIDTH = 640 as const;
export const ANDROID_DEFAULT_CAMERA_HEIGHT = 480 as const;
