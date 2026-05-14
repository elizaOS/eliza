/**
 * iOS computer-use bridge — Capacitor JS↔Swift contract.
 *
 * iOS does not let third-party apps drive other apps. The only surfaces
 * available to us are:
 *
 *   1. ReplayKit foreground capture     — own-app screen frames
 *   2. ReplayKit broadcast extension    — system-wide capture (~50MB ceiling,
 *                                         iOS 26/26.1 beta regression noted)
 *   3. Apple Vision OCR                 — VNRecognizeTextRequest, on-device
 *   4. App Intents                      — invoke other apps' Shortcuts-style
 *                                         intents (the only sanctioned UI driver)
 *   5. UIAccessibility (own app only)
 *   6. Apple Foundation Models (iOS 26) — opportunistic on-device LLM
 *
 * What is NOT exposed (and never will be on stock iOS):
 *   - Cross-app input or pixel scraping
 *   - Process listing of other running apps
 *   - Background inference past ~30s outside `BGProcessingTask`
 *
 * See `eliza/plugins/plugin-computeruse/docs/IOS_CONSTRAINTS.md` for the
 * honest scope discussion and per-method validation checklist.
 *
 * The Swift counterpart lives at
 * `apps/app/ios/App/App/ComputerUseBridge.swift`. The `// MARK: - Contract`
 * block in that file mirrors the signatures below verbatim — keep them in
 * lock-step or the bridge silently drifts.
 */

// ── Common envelope ──────────────────────────────────────────────────────────

/**
 * Unified result envelope for every bridge call.
 *
 * `ok=true` means the native side completed successfully and `data` is shaped
 * to the per-method type. `ok=false` carries a `code` (machine-readable) and
 * `message` (human-readable). No fallbacks, no silent defaults — if the call
 * failed, the JS caller sees it.
 */
export type IosBridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: IosBridgeErrorCode; message: string };

export type IosBridgeErrorCode =
  | "unsupported_platform" // not iOS, or iOS version below required minimum
  | "permission_denied" // user dismissed system prompt
  | "permission_pending" // first-launch — prompt is being shown
  | "extension_unavailable" // broadcast extension not installed/registered
  | "extension_died" // iOS 26/26.1 beta regression: extension killed within ~3s
  | "memory_pressure" // os_proc_available_memory under threshold
  | "intent_not_found" // requested AppIntent not registered on this device
  | "intent_invocation_failed"
  | "vision_no_text" // OCR ran but found nothing
  | "foundation_model_unavailable" // Apple Intelligence disabled / OS too old
  | "internal_error";

// ── 1. ReplayKit foreground (own-app) capture ────────────────────────────────

/**
 * Configures `RPScreenRecorder.shared().startCapture(handler:completionHandler:)`.
 *
 * `frameRate` caps how often the Swift side forwards frames to JS — Apple
 * delivers at display refresh rate, we throttle. `maxDurationSec` is a
 * hard upper bound; anything past 30s requires `BGProcessingTask` and is
 * not supported by this method.
 */
export interface ReplayKitForegroundOptions {
  /** Hard cap, default 1. Apple delivers at display refresh; we drop frames. */
  readonly frameRate?: number;
  /** Max session duration in seconds, default 30. Capped at 30 server-side. */
  readonly maxDurationSec?: number;
  /** Include audio sample buffers (mic). Default false. */
  readonly includeAudio?: boolean;
}

export interface ReplayKitForegroundFrame {
  /** Monotonic capture timestamp from CMSampleBuffer presentation time, ns. */
  readonly timestampNs: number;
  /** Pixel width in image-buffer coordinates. */
  readonly width: number;
  /** Pixel height. */
  readonly height: number;
  /** Base64-encoded JPEG of the frame at quality 0.7. */
  readonly jpegBase64: string;
}

export interface ReplayKitForegroundHandle {
  /** Opaque session id; pass to `replayKitForegroundStop`. */
  readonly sessionId: string;
  /** Echoed effective options after server-side clamping. */
  readonly effective: Required<ReplayKitForegroundOptions>;
}

// ── 2. Broadcast extension (system-wide capture) ─────────────────────────────

/**
 * Handshake with the broadcast extension. Returns whether the extension is
 * registered, the App Group container path used to stream frames, and a
 * pre-flight memory headroom check.
 *
 * The extension itself runs in a separate process with a ~50MB ceiling. The
 * main app cannot start the extension programmatically — the user must tap
 * the system share-sheet broadcast picker. This call only verifies the
 * pipeline is wired and the App Group container is writable.
 *
 * iOS 26 / 26.1 beta regression: extensions are killed within ~3 seconds even
 * when memory is well under the limit. The bridge surfaces this as
 * `extension_died` with `details.regressionFB` referencing the Apple feedback
 * id when known. The caller should fall back to foreground capture.
 */
export interface BroadcastHandshakeResult {
  /** True if the broadcast extension target is bundled with this build. */
  readonly extensionInstalled: boolean;
  /** App Group identifier (e.g. `group.com.miladyai.milady`). */
  readonly appGroupId: string;
  /** Absolute path to the App Group container used for IPC frames. */
  readonly sharedContainerPath: string;
  /** Available memory in MB the extension would have at start time. */
  readonly availableMemoryMb: number;
  /** True if iOS reports an active broadcast session. */
  readonly broadcastActive: boolean;
  /** Last known iOS-26-beta regression status, if observed. */
  readonly regression?: {
    readonly observed: boolean;
    readonly note: string;
  };
}

// ── 3. Apple Vision OCR ──────────────────────────────────────────────────────

export interface VisionOcrOptions {
  /**
   * ISO 639-1 language hints. Vision falls back to autodetect when omitted.
   * Examples: ["en-US"], ["zh-Hans","en-US"].
   */
  readonly languages?: readonly string[];
  /**
   * "fast" uses a smaller model with lower latency (~80ms typical),
   * "accurate" runs the higher-quality model (~250ms typical).
   */
  readonly recognitionLevel?: "fast" | "accurate";
  /** Minimum text height as a fraction of image height. Default 0.0 (off). */
  readonly minimumTextHeight?: number;
  /**
   * Whether to use language-correction post-pass. Default true on iOS 16+.
   * Adds ~30ms but materially improves CJK and handwriting accuracy.
   */
  readonly usesLanguageCorrection?: boolean;
}

export interface VisionOcrLine {
  readonly text: string;
  readonly confidence: number;
  /** Normalized 0..1 origin-bottom-left rect, matching VNRectangleObservation. */
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface VisionOcrResult {
  readonly lines: readonly VisionOcrLine[];
  readonly fullText: string;
  /** Total time spent in VNImageRequestHandler.perform, ms. */
  readonly elapsedMs: number;
  /** Languages Vision actually used. */
  readonly languagesUsed: readonly string[];
}

// ── 4. App Intents ───────────────────────────────────────────────────────────

/**
 * Parameter spec for an AppIntent. Mirrors the subset of `IntentParameter`
 * shapes we can portably express across iOS 16+ AppIntent and the legacy
 * Intents framework. The Swift side validates and rejects extras.
 */
export interface IntentParameterSpec {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "date" | "url" | "enum";
  readonly required: boolean;
  /** Present when type === "enum". */
  readonly enumValues?: readonly string[];
  /** Human-readable description for the planner. */
  readonly description?: string;
}

export interface IntentSpec {
  /** Bundle id of the owning app, e.g. `com.apple.mobilenotes`. */
  readonly bundleId: string;
  /** Reverse-DNS intent identifier, e.g. `com.apple.mobilenotes.create-note`. */
  readonly id: string;
  /** Display name surfaced in the planner. */
  readonly displayName: string;
  /** Free-form summary used as planner context. */
  readonly summary: string;
  readonly parameters: readonly IntentParameterSpec[];
  /**
   * `donated` means the app has run at least once and donated this intent to
   * Shortcuts on this device. `system` is a known-stable Apple intent that
   * ships with the OS.
   */
  readonly source: "donated" | "system";
}

export interface IntentInvocationRequest {
  readonly intentId: string;
  readonly parameters: Readonly<Record<string, IntentParameterValue>>;
}

export type IntentParameterValue =
  | string
  | number
  | boolean
  | { readonly kind: "date"; readonly iso: string }
  | { readonly kind: "url"; readonly url: string };

export interface IntentInvocationResult {
  readonly intentId: string;
  /** Whether iOS reported the intent ran end-to-end. */
  readonly success: boolean;
  /** Optional structured response payload from the intent. */
  readonly response?: Readonly<Record<string, unknown>>;
  /** Time from invocation to completion, ms. */
  readonly elapsedMs: number;
}

// ── 5. UIAccessibility (own-app reading only) ────────────────────────────────

export interface AccessibilitySnapshotNode {
  readonly id: string;
  readonly role: string;
  readonly label?: string;
  readonly value?: string;
  readonly isFocused: boolean;
  readonly children: readonly AccessibilitySnapshotNode[];
}

export interface AccessibilitySnapshotResult {
  readonly screenName: string;
  readonly tree: AccessibilitySnapshotNode;
  readonly capturedAt: number;
}

// ── 6. Apple Foundation Models (iOS 26+) ─────────────────────────────────────

export interface FoundationModelOptions {
  /** Sampling temperature in [0,1]. Default 0.2 for deterministic-ish output. */
  readonly temperature?: number;
  /** Max generated tokens. Default 256. */
  readonly maxTokens?: number;
  /** System-style instruction; mapped to the iOS 26 system role. */
  readonly instruction?: string;
}

export interface FoundationModelResult {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly elapsedMs: number;
}

// ── Bridge interface (this is the JS↔Swift contract) ─────────────────────────

/**
 * Strict TS interface for the Capacitor plugin. Every method returns an
 * `IosBridgeResult<T>` — Swift never throws across the bridge.
 *
 * The Capacitor plugin name on the Swift side is `ComputerUseBridge`. The
 * `jsName` is `ComputerUse`. Method names below are the exact strings
 * registered with `CAPPluginMethod`.
 */
export interface IosComputerUseBridge {
  /** `{ available: true }` if iOS 26+ with all four targets bundled. */
  readonly probe: () => Promise<IosBridgeResult<IosBridgeProbe>>;

  // --- ReplayKit foreground ---
  readonly replayKitForegroundStart: (
    options?: ReplayKitForegroundOptions,
  ) => Promise<IosBridgeResult<ReplayKitForegroundHandle>>;
  /** Stops capture and discards the in-flight buffer. */
  readonly replayKitForegroundStop: (args: {
    readonly sessionId: string;
  }) => Promise<IosBridgeResult<{ readonly sessionId: string }>>;
  /**
   * Drains the next batch of frames since last drain. Returns up to `max`
   * frames. The Swift side ring-buffers at most 30 frames; older ones drop.
   */
  readonly replayKitForegroundDrain: (args: {
    readonly sessionId: string;
    readonly max?: number;
  }) => Promise<IosBridgeResult<{ readonly frames: readonly ReplayKitForegroundFrame[] }>>;

  // --- Broadcast extension ---
  readonly broadcastExtensionHandshake: () => Promise<
    IosBridgeResult<BroadcastHandshakeResult>
  >;

  // --- Vision OCR ---
  readonly visionOcr: (args: {
    /** Base64-encoded image (PNG or JPEG), no data URI prefix. */
    readonly imageBase64: string;
    readonly options?: VisionOcrOptions;
  }) => Promise<IosBridgeResult<VisionOcrResult>>;

  // --- App Intents ---
  /** Lists intents iOS knows about for the given bundle ids (or all donated). */
  readonly appIntentList: (args: {
    readonly bundleIds?: readonly string[];
  }) => Promise<IosBridgeResult<{ readonly intents: readonly IntentSpec[] }>>;
  readonly appIntentInvoke: (
    request: IntentInvocationRequest,
  ) => Promise<IosBridgeResult<IntentInvocationResult>>;

  // --- UIAccessibility ---
  readonly accessibilitySnapshot: () => Promise<
    IosBridgeResult<AccessibilitySnapshotResult>
  >;

  // --- Foundation Models ---
  readonly foundationModelGenerate: (args: {
    readonly prompt: string;
    readonly options?: FoundationModelOptions;
  }) => Promise<IosBridgeResult<FoundationModelResult>>;

  // --- Memory pressure (used by WS1 arbiter) ---
  /**
   * One-shot read of `os_proc_available_memory()` plus a digest of recent
   * `UIApplicationDidReceiveMemoryWarningNotification` events. The arbiter
   * also subscribes to push events via `addPressureListener`.
   */
  readonly memoryPressureProbe: () => Promise<
    IosBridgeResult<MemoryPressureSample>
  >;
}

export interface IosBridgeProbe {
  readonly platform: "ios";
  /** e.g. "26.1" — `UIDevice.current.systemVersion`. */
  readonly osVersion: string;
  /** Capability matrix discovered at probe time. */
  readonly capabilities: {
    readonly replayKitForeground: boolean;
    readonly broadcastExtension: boolean;
    readonly visionOcr: boolean;
    readonly appIntents: boolean;
    readonly accessibilityRead: boolean;
    readonly foundationModel: boolean;
  };
}

// ── Memory-pressure contract (WS1 arbiter handoff) ───────────────────────────

/**
 * Thin contract WS1 owns. The iOS bridge implements the producer side; WS1's
 * arbiter consumes via this shape. Defined here so plugin-computeruse can
 * publish samples without taking a runtime dep on the arbiter package.
 */
export interface IPressureSignal {
  readonly source: "ios-uikit" | "android-low-memory" | "host-os" | "synthetic";
  readonly capturedAt: number;
  /** 0 = nominal, 1 = critical. iOS warning notification → 0.7. */
  readonly severity: number;
  /** Available process memory in MB, when the source can report it. */
  readonly availableMb?: number;
  /** Free-form details for diagnostics. Never load-bearing for arbiter logic. */
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface MemoryPressureSample extends IPressureSignal {
  readonly source: "ios-uikit";
  /** Last received `UIApplicationDidReceiveMemoryWarningNotification`, ms epoch. */
  readonly lastWarningAt?: number;
  /** Available process memory in MB from `os_proc_available_memory`. */
  readonly availableMb: number;
  /** True if the broadcast extension is currently active. */
  readonly broadcastActive: boolean;
}

// ── Default IDs (kept in sync with Swift) ────────────────────────────────────

/** App Group identifier — must match `App.entitlements`. */
export const IOS_APP_GROUP_ID = "group.com.miladyai.milady" as const;

/** Capacitor plugin jsName (Capacitor injects `Capacitor.Plugins.ComputerUse`). */
export const IOS_BRIDGE_JS_NAME = "ComputerUse" as const;

/** Maximum frames buffered server-side for ReplayKit foreground draining. */
export const REPLAYKIT_FOREGROUND_MAX_BUFFER = 30 as const;

/** Hard cap on session duration; anything beyond requires BGProcessingTask. */
export const REPLAYKIT_FOREGROUND_MAX_SESSION_SEC = 30 as const;
