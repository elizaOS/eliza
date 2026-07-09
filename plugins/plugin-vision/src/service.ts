/**
 * Long-running vision service for camera/screen capture, scene description,
 * OCR, object/person detection, entity tracking, and audio transcription.
 */

import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  type IAgentRuntime,
  logger,
  ModelType,
  Service,
  type ServiceTypeName,
  withStandaloneTrajectory,
} from "@elizaos/core";
import { AudioCaptureService, type AudioConfig } from "./audio-capture";
import {
  StreamingAudioCaptureService,
  type StreamingAudioConfig,
} from "./audio-capture-stream";
import {
  DescribeBackpressureController,
  type DescribePauseReason,
} from "./describe-backpressure";
import { DirtyTileDescriber } from "./dirty-tile-describer";
import {
  createTileDescribeFn,
  type FrameHash,
  type TileDescribeFn,
  tilePngToImageUrl,
} from "./dirty-tile-scene";
import { EntityTracker } from "./entity-tracker";
import type { FaceRecognition } from "./face-recognition-ggml";
import { getSharp } from "./image/sharp-compat";
import {
  assertValidVisionImageBuffer,
  parseVisionDataImageUrl,
} from "./image-input";
import { resolveArbiterFromRuntime } from "./lifecycle";
import {
  getMobileCameraSource,
  registerMobileCameraSource,
} from "./mobile/capacitor-camera";
import { FileBridgeCameraSource } from "./mobile/file-bridge-camera";
import { OCRService } from "./ocr-service";
import { ScreenCaptureService } from "./screen-capture";
import { getTestImage } from "./test-input";
import {
  type BoundingBox,
  type CameraInfo,
  type DetectedObject,
  type EnhancedSceneDescription,
  type PersonInfo,
  type SceneDescription,
  type ScreenCapture,
  type ScreenTile,
  type TileAnalysis,
  type VisionConfig,
  type VisionFrame,
  VisionMode,
  VisionServiceType,
} from "./types";
import { VisionWorkerManager } from "./vision-worker-manager";
import type { YOLODetector } from "./yolo-detector";

const execAsync = promisify(exec);

// Service type registered by plugin-computeruse's VisionContextProvider. We
// duck-type the consumer interface here rather than taking a hard package
// dependency on @elizaos/plugin-computeruse — the provider is optional and
// lives in a peer plugin. The structural contract must stay in sync with the
// `VisionContext` exported from plugin-computeruse.
const VISION_CONTEXT_SERVICE_TYPE = "vision-context";
const SCENE_CONTEXT_OPEN_APPS_LIMIT = 20;
const SCENE_CONTEXT_RECENT_ACTIONS_LIMIT = 10;
const SCENE_DESCRIPTION_OCR_LINE_LIMIT = 40;
const SCENE_DESCRIPTION_OCR_TEXT_LIMIT = 2000;
const SCENE_DESCRIPTION_OBJECT_LIMIT = 20;
const SCENE_DESCRIPTION_FACE_LIMIT = 10;

export interface VisionContextSnapshot {
  openApps: string[];
  focusedWindow: {
    app: string;
    title: string;
    bbox: [number, number, number, number] | null;
  } | null;
  recentActions: Array<{ action: string; ts: number }>;
  currentTaskGoal: string | null;
}

interface VisionContextProviderLike {
  getContext(): Promise<VisionContextSnapshot>;
}

const SCENE_DESCRIPTION_INSTRUCTIONS = [
  "Describe visible people, objects, UI, text, and notable scene changes.",
  "Keep the answer concise and factual.",
];

/**
 * A face that the ggml face-recognition pipeline matched to a known profile,
 * shaped for the VLM prompt. `label` is the profile's display name when set,
 * otherwise the opaque profile id. `bbox` is the detected face region.
 */
export interface RecognizedFace {
  label: string;
  bbox: BoundingBox;
}

/** Prompt-shaped detected object: label + confidence + region. */
interface DetectedObjectForPrompt {
  type: string;
  confidence: number;
  bbox: BoundingBox;
}

function isVisionContextProvider(
  candidate: unknown,
): candidate is VisionContextProviderLike {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { getContext?: unknown }).getContext === "function"
  );
}

function trimVisionContextForPrompt(
  context: VisionContextSnapshot,
): VisionContextSnapshot {
  return {
    openApps: context.openApps.slice(0, SCENE_CONTEXT_OPEN_APPS_LIMIT),
    focusedWindow: context.focusedWindow,
    recentActions: context.recentActions.slice(
      -SCENE_CONTEXT_RECENT_ACTIONS_LIMIT,
    ),
    currentTaskGoal: context.currentTaskGoal,
  };
}

export function buildSceneDescriptionPrompt(
  context: VisionContextSnapshot | null,
  ocrText?: string | null,
  detectedObjects?: DetectedObject[] | null,
  recognizedFaces?: RecognizedFace[] | null,
): string {
  const payload: Record<string, unknown> = {
    task: "describe_visual_scene",
    instructions: SCENE_DESCRIPTION_INSTRUCTIONS,
  };
  if (context) payload.context = trimVisionContextForPrompt(context);
  const detectedText = normalizeOcrTextForPrompt(ocrText);
  if (detectedText) payload.detectedText = detectedText;
  const objects = normalizeDetectedObjectsForPrompt(detectedObjects);
  if (objects.length > 0) payload.detectedObjects = objects;
  const faces = normalizeRecognizedFacesForPrompt(recognizedFaces);
  if (faces.length > 0) payload.recognizedFaces = faces;
  return JSON.stringify(payload, null, 2);
}

function normalizeDetectedObjectsForPrompt(
  objects?: DetectedObject[] | null,
): DetectedObjectForPrompt[] {
  if (!objects || objects.length === 0) return [];
  return [...objects]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, SCENE_DESCRIPTION_OBJECT_LIMIT)
    .map((obj) => ({
      type: obj.type,
      confidence: obj.confidence,
      bbox: obj.boundingBox,
    }));
}

function normalizeRecognizedFacesForPrompt(
  faces?: RecognizedFace[] | null,
): RecognizedFace[] {
  if (!faces || faces.length === 0) return [];
  const seen = new Set<string>();
  const result: RecognizedFace[] = [];
  for (const face of faces) {
    const label = face.label.trim();
    if (label.length === 0) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    result.push({ label, bbox: face.bbox });
    if (result.length >= SCENE_DESCRIPTION_FACE_LIMIT) break;
  }
  return result;
}

function normalizeOcrTextForPrompt(text?: string | null): string | null {
  if (!text) return null;
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length === 0) continue;
    const dedupeKey = line.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    lines.push(line);
    if (lines.length >= SCENE_DESCRIPTION_OCR_LINE_LIMIT) break;
  }

  const normalized = lines
    .join("\n")
    .slice(0, SCENE_DESCRIPTION_OCR_TEXT_LIMIT)
    .trim();
  return normalized.length > 0 ? normalized : null;
}

interface CameraDevice {
  id: string;
  name: string;
  capture: () => Promise<Buffer>;
}

export class VisionService extends Service {
  static override serviceType: ServiceTypeName =
    VisionServiceType.VISION as ServiceTypeName;
  override capabilityDescription =
    "Provides visual perception through camera integration and scene analysis.";

  private visionConfig: VisionConfig;
  private camera: CameraDevice | null = null;
  private lastFrame: VisionFrame | null = null;
  private lastSceneDescription: SceneDescription | null = null;
  private frameProcessingInterval: NodeJS.Timeout | null = null;
  private screenProcessingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isProcessingScreen = false;
  private objectDetector: YOLODetector | null = null;
  private hasObjectDetection = false;
  // Lazily constructed: the face backend is dynamically imported on first use
  // so plugin-vision's module graph never pulls native code at module-eval
  // (required for the Android bun-musl agent).
  private faceRecognition: FaceRecognition | null = null;
  private entityTracker: EntityTracker;
  private audioCapture: AudioCaptureService | null = null;
  private streamingAudioCapture: StreamingAudioCaptureService | null = null;

  // Screen vision components
  private screenCapture: ScreenCaptureService;
  private ocrService: OCRService;
  private lastScreenCapture: ScreenCapture | null = null;
  private lastEnhancedScene: EnhancedSceneDescription | null = null;

  // Worker manager for high-FPS processing
  private workerManager: VisionWorkerManager | null = null;

  // Add tracking for last update times
  private lastTfUpdateTime = 0;
  private lastVlmUpdateTime = 0;
  private lastTfDescription = "";

  // Memory-pressure pause owner for the continuous VLM describe step
  // (#9105 M8 / #9581). Gates only the expensive IMAGE_DESCRIPTION call;
  // OCR/YOLO/dHash keep running while describing is paused. Fed by both the
  // WS1 memory arbiter (when present) and a local RSS cap (always).
  private readonly describeBackpressure: DescribeBackpressureController;
  private arbiterUnsubscribe: (() => void) | null = null;

  // Change-gated per-tile describe (#9105). Built lazily on first VLM tick:
  // null until we know whether a perceptual hash is available. When present it
  // re-describes only the screen tiles that changed since the previous frame;
  // when absent the VLM path stays exactly as before (full-frame describe).
  private dirtyTileDescriber: DirtyTileDescriber | null = null;
  private dirtyTileDescriberInit = false;
  // Per-frame prompt context for the per-tile describe. Set immediately before
  // each `dirtyTileDescriber.describe(...)` and read by the bound describeTile
  // closure (screen/camera processing is serialized, so there is no overlap).
  private dirtyTileDescribeContext: {
    detectedObjects: DetectedObject[];
    recognizedFaces: RecognizedFace[];
  } = { detectedObjects: [], recognizedFaces: [] };

  // Default configuration
  private readonly DEFAULT_CONFIG: VisionConfig = {
    pixelChangeThreshold: 50, // 50% change required for VLM update
    updateInterval: 100, // Process frames every 100ms
    enablePoseDetection: false,
    enableObjectDetection: false,
    tfUpdateInterval: 1000, // TensorFlow update every 1 second
    vlmUpdateInterval: 10000, // VLM update every 10 seconds
    tfChangeThreshold: 10, // 10% change triggers TF update
    vlmChangeThreshold: 50, // 50% change triggers VLM update
    visionMode: VisionMode.CAMERA, // Default to camera only
    screenCaptureInterval: 2000, // Screen capture every 2 seconds
    tileSize: 256,
    tileProcessingOrder: "priority",
    ocrEnabled: true,
  };

  constructor(runtime?: IAgentRuntime) {
    super(runtime);

    // Load configuration from runtime settings
    this.visionConfig = this.parseConfig(this.runtime);

    // Face recognition is constructed lazily (see getFaceRecognition).

    // Initialize entity tracker
    const worldIdValue = this.runtime.getSetting("WORLD_ID");
    const worldId =
      typeof worldIdValue === "string" ? worldIdValue : "default-world";
    this.entityTracker = new EntityTracker(worldId);

    // Initialize screen capture
    this.screenCapture = new ScreenCaptureService(this.visionConfig);

    // Initialize OCR service
    this.ocrService = new OCRService();

    // Memory-pressure pause owner for the continuous describe loop. The cap
    // mirrors the documented MAX_MEMORY_USAGE_MB setting (default 2000 MB);
    // `0`/invalid disables the local RSS guard so only arbiter pressure pauses.
    const memoryCapMb = Number(
      this.runtime.getSetting("MAX_MEMORY_USAGE_MB") ??
        this.runtime.getSetting("VISION_MAX_MEMORY_USAGE_MB") ??
        2000,
    );
    this.describeBackpressure = new DescribeBackpressureController({
      memoryCapBytes:
        Number.isFinite(memoryCapMb) && memoryCapMb > 0
          ? memoryCapMb * 1024 * 1024
          : 0,
    });

    logger.info(
      "[VisionService] Constructed with config:",
      JSON.stringify(this.visionConfig),
    );
  }

  private parseConfig(runtime: IAgentRuntime): VisionConfig {
    const getSettingString = (key: string): string | undefined => {
      const value = runtime.getSetting(key);
      return value === true || value === false
        ? String(value)
        : typeof value === "string"
          ? value
          : typeof value === "number"
            ? String(value)
            : undefined;
    };
    const getBooleanSetting = (
      primaryKey: string,
      secondaryKey: string,
      defaultValue: boolean,
    ): boolean => {
      const raw =
        getSettingString(primaryKey) ?? getSettingString(secondaryKey);
      if (raw === undefined) return defaultValue;
      return raw.trim().toLowerCase() === "true";
    };

    return {
      ...this.DEFAULT_CONFIG,
      cameraName:
        getSettingString("CAMERA_NAME") ||
        getSettingString("VISION_CAMERA_NAME"),
      pixelChangeThreshold:
        Number(
          runtime.getSetting("PIXEL_CHANGE_THRESHOLD") ||
            runtime.getSetting("VISION_PIXEL_CHANGE_THRESHOLD"),
        ) || this.DEFAULT_CONFIG.pixelChangeThreshold,
      enableObjectDetection:
        runtime.getSetting("ENABLE_OBJECT_DETECTION") === "true" ||
        runtime.getSetting("VISION_ENABLE_OBJECT_DETECTION") === "true",
      enablePoseDetection:
        runtime.getSetting("ENABLE_POSE_DETECTION") === "true" ||
        runtime.getSetting("VISION_ENABLE_POSE_DETECTION") === "true",
      tfUpdateInterval:
        Number(
          runtime.getSetting("TF_UPDATE_INTERVAL") ||
            runtime.getSetting("VISION_TF_UPDATE_INTERVAL"),
        ) || this.DEFAULT_CONFIG.tfUpdateInterval,
      vlmUpdateInterval:
        Number(
          runtime.getSetting("VLM_UPDATE_INTERVAL") ||
            runtime.getSetting("VISION_VLM_UPDATE_INTERVAL"),
        ) || this.DEFAULT_CONFIG.vlmUpdateInterval,
      tfChangeThreshold:
        Number(
          runtime.getSetting("TF_CHANGE_THRESHOLD") ||
            runtime.getSetting("VISION_TF_CHANGE_THRESHOLD"),
        ) || this.DEFAULT_CONFIG.tfChangeThreshold,
      vlmChangeThreshold:
        Number(
          runtime.getSetting("VLM_CHANGE_THRESHOLD") ||
            runtime.getSetting("VISION_VLM_CHANGE_THRESHOLD"),
        ) || this.DEFAULT_CONFIG.vlmChangeThreshold,
      visionMode:
        (getSettingString("VISION_MODE") as VisionMode) ||
        this.DEFAULT_CONFIG.visionMode,
      screenCaptureInterval:
        Number(
          runtime.getSetting("SCREEN_CAPTURE_INTERVAL") ||
            runtime.getSetting("VISION_SCREEN_CAPTURE_INTERVAL"),
        ) || this.DEFAULT_CONFIG.screenCaptureInterval,
      ocrEnabled: getBooleanSetting(
        "OCR_ENABLED",
        "VISION_OCR_ENABLED",
        this.DEFAULT_CONFIG.ocrEnabled ?? true,
      ),
    };
  }

  static async start(runtime: IAgentRuntime): Promise<VisionService> {
    const service = new VisionService(runtime);
    await service.initialize();
    return service;
  }

  private async checkCameraTools(): Promise<{
    available: boolean;
    tool: string;
  }> {
    // A registered mobile camera source (Android CameraX / iOS AVFoundation via
    // the Capacitor bridge) captures in-process — it replaces the desktop CLI
    // tools entirely. On a phone there is no imagesnap/fswebcam/ffmpeg, so this
    // is the only working capture path there.
    if (getMobileCameraSource()) {
      return { available: true, tool: "mobile-bridge" };
    }

    const platform = process.platform;

    try {
      if (platform === "darwin") {
        // Check if imagesnap is installed
        await execAsync("which imagesnap");
        return { available: true, tool: "imagesnap" };
      } else if (platform === "linux") {
        // Check if fswebcam is installed
        await execAsync("which fswebcam");
        return { available: true, tool: "fswebcam" };
      } else if (platform === "win32") {
        // Check if ffmpeg is available
        await execAsync("where ffmpeg");
        return { available: true, tool: "ffmpeg" };
      }
      return { available: false, tool: "none" };
    } catch (_error) {
      // Tool not found
      return { available: false, tool: "none" };
    }
  }

  private async initialize(): Promise<void> {
    try {
      // On the Android on-device agent there is no desktop camera CLI and no
      // in-process Capacitor bridge, so register the file-drop camera source
      // that relays capture requests to the WebView's ElizaCamera. Gated on the
      // mobile platform env ElizaAgentService sets; a no-op everywhere else.
      // Static imports (not dynamic) so the source is in the mobile agent
      // bundle — a code-split chunk can't be loaded there (no filesystem).
      if (process.env.ELIZA_MOBILE_PLATFORM === "android") {
        registerMobileCameraSource(new FileBridgeCameraSource());
      }

      // Initialize the ggml YOLOv8 object detector when object detection is
      // enabled. There is no pose backend yet — pose detection falls through
      // to the heuristic path (detectPeopleFromMotion).
      if (this.visionConfig.enableObjectDetection) {
        try {
          const { YOLODetector } = await import("./yolo-detector");
          this.objectDetector = new YOLODetector();
          await this.objectDetector.initialize();
          this.hasObjectDetection = true;
          logger.info(
            "[VisionService] ggml YOLOv8 object detector initialized",
          );
        } catch (yoloError) {
          // Native lib / GGUF not built yet — leave object detection off so
          // the motion/heuristic + VLM fallback still runs. Never fake it.
          this.objectDetector = null;
          this.hasObjectDetection = false;
          logger.warn(
            "[VisionService] ggml YOLOv8 detector unavailable, object detection disabled (using motion/heuristic + VLM fallback):",
            yoloError instanceof Error ? yoloError.message : String(yoloError),
          );
        }
      }

      if (this.visionConfig.enablePoseDetection) {
        logger.warn(
          "[VisionService] ggml pose detection is not yet available; falling back to heuristic person detection",
        );
      }

      // Initialize screen vision if enabled
      if (
        this.visionConfig.visionMode === VisionMode.SCREEN ||
        this.visionConfig.visionMode === VisionMode.BOTH
      ) {
        await this.initializeScreenVision();
      }

      // Initialize camera if enabled
      if (
        this.visionConfig.visionMode === VisionMode.CAMERA ||
        this.visionConfig.visionMode === VisionMode.BOTH
      ) {
        await this.initializeCameraVision();
      }

      // Initialize audio capture if enabled
      await this.initializeAudioCapture();

      // Start processing based on mode
      this.startProcessing();
    } catch (error) {
      logger.error({ error }, "[VisionService] Failed to initialize:");
    }
  }

  private async initializeScreenVision(): Promise<void> {
    try {
      logger.info("[VisionService] Initializing screen vision...");

      // Check if we should use worker threads for high-FPS processing
      const useWorkers =
        this.visionConfig.targetScreenFPS &&
        this.visionConfig.targetScreenFPS > 10;

      if (useWorkers) {
        // Initialize worker manager for high-FPS processing
        logger.info(
          "[VisionService] Initializing worker threads for high-FPS processing...",
        );
        this.workerManager = new VisionWorkerManager(this.visionConfig);
        await this.workerManager.initialize();
        logger.info("[VisionService] Worker threads initialized");
      } else {
        // Initialize OCR if enabled
        if (this.visionConfig.ocrEnabled) {
          await this.ocrService.initialize();
        }
      }

      // Get screen info
      const screenInfo = await this.screenCapture.getScreenInfo();
      if (screenInfo) {
        logger.info(
          `[VisionService] Screen resolution: ${screenInfo.width}x${screenInfo.height}`,
        );
      }

      logger.info("[VisionService] Screen vision initialized");
    } catch (error) {
      logger.error(
        { error },
        "[VisionService] Failed to initialize screen vision:",
      );
    }
  }

  private async initializeCameraVision(): Promise<void> {
    // Check if camera tools are available
    const toolCheck = await this.checkCameraTools();
    if (!toolCheck.available) {
      const platform = process.platform;
      const toolName =
        platform === "darwin"
          ? "imagesnap"
          : platform === "linux"
            ? "fswebcam"
            : "ffmpeg";
      logger.warn(
        `[VisionService] Camera capture tool '${toolName}' not found. Install it to enable camera functionality.`,
      );
      logger.warn("[VisionService] For macOS: brew install imagesnap");
      logger.warn("[VisionService] For Linux: sudo apt-get install fswebcam");
      logger.warn(
        "[VisionService] For Windows: Install ffmpeg and add to PATH",
      );
      return;
    }

    // Find and connect to camera
    const camera = await this.findCamera();
    if (camera) {
      this.camera = camera;
      logger.info(`[VisionService] Connected to camera: ${camera.name}`);
    } else {
      logger.warn("[VisionService] No suitable camera found");
    }
  }

  private async initializeAudioCapture(): Promise<void> {
    const getSettingString = (key: string): string | undefined => {
      const value = this.runtime.getSetting(key);
      return value === true || value === false
        ? String(value)
        : typeof value === "string"
          ? value
          : typeof value === "number"
            ? String(value)
            : undefined;
    };
    const enableMicrophone = getSettingString("ENABLE_MICROPHONE") === "true";
    const useStreamingAudio =
      getSettingString("USE_STREAMING_AUDIO") === "true";

    if (!enableMicrophone) {
      logger.info("[VisionService] Microphone capture disabled");
      return;
    }

    try {
      if (useStreamingAudio) {
        // Use new streaming audio with VAD
        const getSettingNumber = (
          key: string,
          defaultValue: number,
        ): number => {
          const value = this.runtime.getSetting(key);
          if (typeof value === "number") return value;
          if (typeof value === "string") {
            const parsed = Number(value);
            return Number.isNaN(parsed) ? defaultValue : parsed;
          }
          return defaultValue;
        };
        const streamingConfig: StreamingAudioConfig = {
          enabled: true,
          sampleRate: 16000,
          channels: 1,
          vadThreshold: getSettingNumber("VAD_THRESHOLD", 0.01),
          silenceTimeout: getSettingNumber("SILENCE_TIMEOUT", 1500),
          responseDelay: getSettingNumber("RESPONSE_DELAY", 3000),
        };

        this.streamingAudioCapture = new StreamingAudioCaptureService(
          this.runtime,
          streamingConfig,
        );

        // Set up event listeners
        this.streamingAudioCapture.on("speechStart", () => {
          logger.info("[VisionService] User started speaking");
        });

        this.streamingAudioCapture.on("speechEnd", () => {
          logger.info("[VisionService] User stopped speaking");
        });

        this.streamingAudioCapture.on(
          "transcription",
          (data: { text: string; isFinal: boolean }) => {
            logger.info(
              `[VisionService] Transcription (${data.isFinal ? "final" : "partial"}): ${data.text}`,
            );
          },
        );

        this.streamingAudioCapture.on(
          "utteranceComplete",
          async (text: string) => {
            logger.info("[VisionService] Processing complete utterance:", text);
            // Store the transcription in memory for context
            await this.storeAudioTranscription(text);
          },
        );

        await this.streamingAudioCapture.initialize();
        logger.info(
          "[VisionService] Streaming audio capture initialized with VAD",
        );
      } else {
        // Use original batch audio capture
        const getSettingNumber = (
          key: string,
          defaultValue: number,
        ): number => {
          const value = this.runtime.getSetting(key);
          if (typeof value === "number") return value;
          if (typeof value === "string") {
            const parsed = Number(value);
            return Number.isNaN(parsed) ? defaultValue : parsed;
          }
          return defaultValue;
        };
        const audioConfig: AudioConfig = {
          enabled: true,
          transcriptionInterval: getSettingNumber(
            "TRANSCRIPTION_INTERVAL",
            30000,
          ),
        };

        this.audioCapture = new AudioCaptureService(this.runtime, audioConfig);
        await this.audioCapture.initialize();
        logger.info("[VisionService] Batch audio capture initialized");
      }
    } catch (error) {
      logger.error(
        { error },
        "[VisionService] Failed to initialize audio capture:",
      );
      // Continue without audio
    }
  }

  private async storeAudioTranscription(text: string): Promise<void> {
    try {
      // Store transcription in the current scene description
      if (this.lastSceneDescription) {
        this.lastSceneDescription.audioTranscription = text;
      }

      // You could also create a memory here if needed
      logger.debug(
        "[VisionService] Stored audio transcription in scene context",
      );
    } catch (error) {
      logger.error(
        { error },
        "[VisionService] Failed to store audio transcription:",
      );
    }
  }

  private startProcessing(): void {
    // Wire the continuous describe loop to the memory arbiter (if WS1 is
    // loaded) so device memory pressure pauses the expensive VLM describe.
    this.attachMemoryArbiter();

    // Start camera processing if enabled
    if (
      (this.visionConfig.visionMode === VisionMode.CAMERA ||
        this.visionConfig.visionMode === VisionMode.BOTH) &&
      this.camera
    ) {
      this.startFrameProcessing();
    }

    // Start screen processing if enabled
    if (
      this.visionConfig.visionMode === VisionMode.SCREEN ||
      this.visionConfig.visionMode === VisionMode.BOTH
    ) {
      this.startScreenProcessing();
    }
  }

  /**
   * Subscribe the describe-backpressure controller to WS1 memory-pressure
   * events. Resolves the arbiter dynamically (no hard dependency on
   * `@elizaos/plugin-local-inference`); when none is registered the controller
   * still pauses on the local RSS cap. Idempotent — a prior subscription is
   * released first so a restart doesn't double-subscribe.
   */
  private attachMemoryArbiter(): void {
    if (this.arbiterUnsubscribe) {
      this.arbiterUnsubscribe();
      this.arbiterUnsubscribe = null;
    }
    const arbiter = resolveArbiterFromRuntime(this.runtime);
    if (!arbiter) return;
    // `onPressure` fires with a non-empty holder list when pressure is high
    // enough to shed load, and (on the WS1 bridge) an empty list on any
    // non-nominal tier. Either way that means "pause describing"; the next
    // tick with no pressure event keeps describing. The bridge only emits on
    // pressure, so we treat any callback as "critical" and rely on the WS1
    // side clearing — for finer levels a direct IModelArbiter can be extended
    // later. Empty/any callback ⇒ pause.
    this.arbiterUnsubscribe = arbiter.onPressure(() => {
      this.describeBackpressure.setPressure("critical");
    });
    logger.debug("[VisionService] Memory arbiter attached to describe loop");
  }

  /**
   * Clear the arbiter-driven pause. Called by the WS1 bridge consumer when
   * pressure returns to nominal; also exposed so an embedder can resume the
   * describe loop explicitly.
   */
  public resumeDescribeLoop(): void {
    this.describeBackpressure.setPressure("nominal");
  }

  /** Current describe-backpressure stats (telemetry / tests). */
  public getBackpressureStats() {
    return this.describeBackpressure.stats();
  }

  private startFrameProcessing(): void {
    if (this.frameProcessingInterval) {
      return;
    }

    this.frameProcessingInterval = setInterval(async () => {
      if (!this.isProcessing && this.camera) {
        this.isProcessing = true;
        try {
          await this.captureAndProcessFrame();
        } catch (error) {
          logger.error({ error }, "[VisionService] Frame processing error:");
        }
        this.isProcessing = false;
      }
    }, this.visionConfig.updateInterval || 100);

    logger.debug("[VisionService] Started frame processing loop");
  }

  private async captureAndProcessFrame(): Promise<void> {
    if (!this.camera) {
      return;
    }

    try {
      // Capture frame from camera
      const frameData = await this.camera.capture();

      // Skip if no data
      if (!frameData || frameData.length === 0) {
        logger.debug("[VisionService] Camera returned empty frame, skipping");
        return;
      }

      // Convert to standardized format
      const frame = await this.processFrameData(frameData);

      // Validate frame before processing
      if (!frame || frame.width === 0 || frame.height === 0) {
        logger.warn("[VisionService] Invalid frame dimensions, skipping");
        return;
      }

      // Check if scene has changed significantly
      const changePercentage = this.lastFrame
        ? await this.calculatePixelChange(this.lastFrame, frame)
        : 100;

      // Update scene description if change is significant or enough time has passed
      // Always call updateSceneDescription - it will decide what to update based on thresholds
      await this.updateSceneDescription(frame, changePercentage);

      this.lastFrame = frame;
    } catch (error) {
      logger.error({ error }, "[VisionService] Error capturing frame:");
    }
  }

  private async processFrameData(data: Buffer): Promise<VisionFrame> {
    await assertValidVisionImageBuffer(data);

    // Use sharp to ensure consistent format
    const sharp = await getSharp();
    const image = sharp(data);
    const metadata = await image.metadata();

    // Validate metadata
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width === 0 ||
      metadata.height === 0
    ) {
      throw new Error(
        `Invalid image dimensions: ${metadata.width}x${metadata.height}`,
      );
    }

    const rgbaBuffer = await image.ensureAlpha().raw().toBuffer();

    return {
      timestamp: Date.now(),
      width: metadata.width,
      height: metadata.height,
      data: rgbaBuffer,
      format: "rgba",
    };
  }

  private async calculatePixelChange(
    frame1: VisionFrame,
    frame2: VisionFrame,
  ): Promise<number> {
    if (frame1.width !== frame2.width || frame1.height !== frame2.height) {
      return 100; // Different dimensions = complete change
    }

    const pixels1 = frame1.data;
    const pixels2 = frame2.data;
    let changedPixels = 0;
    const totalPixels = frame1.width * frame1.height;
    const threshold = 30; // RGB difference threshold

    for (let i = 0; i < pixels1.length; i += 4) {
      const r1 = pixels1[i];
      const g1 = pixels1[i + 1];
      const b1 = pixels1[i + 2];
      const r2 = pixels2[i];
      const g2 = pixels2[i + 1];
      const b2 = pixels2[i + 2];

      const diff = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
      if (diff > threshold) {
        changedPixels++;
      }
    }

    return (changedPixels / totalPixels) * 100;
  }

  private async updateSceneDescription(
    frame: VisionFrame,
    changePercentage: number,
  ): Promise<void> {
    try {
      const currentTime = Date.now();
      const previousSceneDescription = this.lastSceneDescription;

      // Test-input override: when ELIZA_VISION_TEST_INPUT=image, replace the
      // captured frame with the fixture PNG so the rest of the pipeline runs
      // unmodified. Returns null when no override is active.
      const testImage = getTestImage();

      // Convert frame to base64 for VLM
      const sharp = await getSharp();
      const jpegBuffer = testImage
        ? await sharp(testImage).jpeg().toBuffer()
        : await sharp(frame.data, {
            raw: {
              width: frame.width,
              height: frame.height,
              channels: 4,
            },
          })
            .jpeg()
            .toBuffer();

      const base64Image = jpegBuffer.toString("base64");
      const imageUrl = `data:image/jpeg;base64,${base64Image}`;

      // Determine if we should update VLM description
      const timeSinceVlmUpdate = currentTime - this.lastVlmUpdateTime;
      const vlmUpdateInterval = this.visionConfig.vlmUpdateInterval ?? 10000;
      const vlmChangeThreshold = this.visionConfig.vlmChangeThreshold ?? 50;
      const shouldUpdateVlm =
        timeSinceVlmUpdate >= vlmUpdateInterval || // Time threshold
        changePercentage >= vlmChangeThreshold; // Change threshold

      let description =
        previousSceneDescription?.description ?? this.lastTfDescription;
      let descriptionTimestamp =
        previousSceneDescription?.descriptionTimestamp ??
        previousSceneDescription?.timestamp ??
        frame.timestamp;
      let descriptionStale = false;
      let describePaused = false;
      let describePauseReason: Exclude<DescribePauseReason, null> | undefined;

      // Determine if we should update TensorFlow detections
      const timeSinceTfUpdate = currentTime - this.lastTfUpdateTime;
      const tfUpdateInterval = this.visionConfig.tfUpdateInterval ?? 1000;
      const tfChangeThreshold = this.visionConfig.tfChangeThreshold ?? 10;
      const shouldUpdateTf =
        timeSinceTfUpdate >= tfUpdateInterval || // Time threshold
        changePercentage >= tfChangeThreshold; // Change threshold

      let detectedObjects: DetectedObject[] = [];
      let people: PersonInfo[] = [];

      if (
        shouldUpdateTf &&
        (this.visionConfig.enableObjectDetection ||
          this.visionConfig.enablePoseDetection)
      ) {
        this.lastTfUpdateTime = currentTime;
        logger.debug(
          `[VisionService] TF updating: ${timeSinceTfUpdate}ms since last update, ${changePercentage.toFixed(1)}% change`,
        );

        // Object detection via the ggml YOLOv8 detector. The detector
        // consumes an encoded image buffer (it reads metadata via sharp), so
        // we reuse the JPEG already produced above for the VLM path.
        if (this.visionConfig.enableObjectDetection && this.objectDetector) {
          try {
            detectedObjects = await this.objectDetector.detect(jpegBuffer);
            logger.debug(
              `[VisionService] YOLOv8 detected ${detectedObjects.length} objects`,
            );
          } catch (detectError) {
            logger.warn(
              "[VisionService] YOLOv8 object detection failed, falling back to motion-based:",
              detectError instanceof Error
                ? detectError.message
                : String(detectError),
            );
            detectedObjects = await this.detectMotionObjects(frame);
          }
        }

        // No ggml pose backend yet — when pose detection is requested, fall
        // through to the heuristic person detector (motion-derived candidates
        // → coarse pose/facing). Keeps the PersonInfo shape intact.
        if (this.visionConfig.enablePoseDetection && people.length === 0) {
          const motionObjects = await this.detectMotionObjects(frame);
          people = await this.detectPeopleFromMotion(frame, motionObjects);
        }

        // If no people detected via pose but objects detected, check for person objects
        if (people.length === 0 && detectedObjects.length > 0) {
          const personObjects = detectedObjects.filter(
            (obj) => obj.type === "person",
          );
          people = personObjects.map((obj) => ({
            id: `person-${obj.id}`,
            pose: "unknown" as const,
            facing: "unknown" as const,
            confidence: obj.confidence,
            boundingBox: obj.boundingBox,
          }));
        }
      } else if (!shouldUpdateTf && this.lastSceneDescription) {
        // Reuse last detection results if not updating
        detectedObjects = this.lastSceneDescription.objects;
        people = this.lastSceneDescription.people;
      } else {
        // Fall back to motion-based detection
        detectedObjects = await this.detectMotionObjects(frame);
        people = await this.detectPeopleFromMotion(frame, detectedObjects);
      }

      // Face recognition and entity tracking
      const faceProfiles = new Map<string, string>();
      const recognizedFaces: RecognizedFace[] = [];
      const getSettingString = (key: string): string | undefined => {
        const value = this.runtime.getSetting(key);
        return value === true || value === false
          ? String(value)
          : typeof value === "string"
            ? value
            : typeof value === "number"
              ? String(value)
              : undefined;
      };
      const enableFaceRecognition =
        getSettingString("ENABLE_FACE_RECOGNITION") === "true";

      if (
        enableFaceRecognition &&
        people.length > 0 &&
        frame.width > 0 &&
        frame.height > 0 &&
        frame.data.length > 0
      ) {
        try {
          // Detect faces in the frame
          const faceRecognition = await this.getFaceRecognition();
          const faces = await faceRecognition.detectFaces(
            frame.data,
            frame.width,
            frame.height,
          );

          // Match faces to people based on bounding box overlap
          for (const face of faces) {
            const faceBox = face.detection.box;

            // Find the person this face belongs to
            for (const person of people) {
              const overlap = this.calculateBoxOverlap(person.boundingBox, {
                x: Math.round(faceBox.x),
                y: Math.round(faceBox.y),
                width: Math.round(faceBox.width),
                height: Math.round(faceBox.height),
              });

              if (overlap > 0.5) {
                // 50% overlap threshold
                // Recognize or register the face
                const match = await faceRecognition.recognizeFace(
                  face.descriptor,
                );
                let profileId: string;

                if (match) {
                  profileId = match.profileId;
                  logger.debug(
                    `[VisionService] Recognized face: ${profileId} (distance: ${match.distance})`,
                  );
                } else {
                  // Register new face. The native ggml backend produces no
                  // expression / age-gender estimates, so no attributes.
                  profileId = await faceRecognition.addOrUpdateFace(
                    face.descriptor,
                  );
                  logger.info(
                    `[VisionService] New face registered: ${profileId}`,
                  );
                }

                faceProfiles.set(person.id, profileId);
                const profile = faceRecognition.getFaceProfile(profileId);
                recognizedFaces.push({
                  label: profile?.name ?? profileId,
                  bbox: {
                    x: Math.round(faceBox.x),
                    y: Math.round(faceBox.y),
                    width: Math.round(faceBox.width),
                    height: Math.round(faceBox.height),
                  },
                });
                break;
              }
            }
          }
        } catch (faceError) {
          logger.error(
            { error: faceError },
            "[VisionService] Face recognition error:",
          );
        }
      }

      // VLM scene description runs after detection so the success path can
      // feed the model the freshly-computed YOLO objects + recognized faces
      // as additional context alongside the image. The describe step is the
      // dominant token + RAM cost, so it is gated by the memory-pressure
      // backpressure owner: under device pressure or over the RSS cap we skip
      // the VLM call (keeping the cheap OCR/YOLO/dHash work) and reuse the last
      // description until pressure clears (#9105 M8 / #9581).
      const describeGate = shouldUpdateVlm
        ? this.describeBackpressure.evaluate()
        : null;
      if (describeGate?.transitionedTo === "paused") {
        logger.info(
          `[VisionService] VLM describe paused (${describeGate.reason}); reusing last scene description`,
        );
      } else if (describeGate?.transitionedTo === "active") {
        logger.info("[VisionService] VLM describe resumed");
      }
      if (describeGate?.warnPaused) {
        const stats = this.describeBackpressure.stats();
        logger.warn(
          {
            reason: describeGate.reason,
            pausedForMs: describeGate.pausedForMs,
            describesSkipped: stats.describesSkipped,
            memoryGrowthBytes: stats.memoryGrowthBytes,
          },
          "[VisionService] VLM describe still paused; reusing stale scene description",
        );
      }
      if (shouldUpdateVlm && describeGate?.describe) {
        // Prefer the change-gated per-tile describe on incremental updates: once
        // a prior scene description exists we only re-describe the tiles that
        // changed since the last frame (the rest reuse cached tile text), which
        // avoids paying for a full-frame VLM pass every tick. The first frame,
        // the test-image override, and any unavailable/empty result fall back to
        // the full-frame describe below.
        const incremental =
          !testImage && this.lastSceneDescription
            ? await this.describeSceneWithDirtyTiles(
                await sharp(frame.data, {
                  raw: {
                    width: frame.width,
                    height: frame.height,
                    channels: 4,
                  },
                })
                  .png()
                  .toBuffer(),
                frame.width,
                frame.height,
                detectedObjects,
                recognizedFaces,
              )
            : null;
        description =
          incremental ??
          (await this.describeSceneWithVLM(
            imageUrl,
            detectedObjects,
            recognizedFaces,
          ));
        this.lastVlmUpdateTime = currentTime;
        this.lastTfDescription = description;
        descriptionTimestamp = frame.timestamp;
        logger.debug(
          `[VisionService] VLM updated: ${timeSinceVlmUpdate}ms since last update, ${changePercentage.toFixed(1)}% change${
            incremental ? " (per-tile)" : " (full-frame)"
          }`,
        );
      } else if (shouldUpdateVlm && describeGate && !describeGate.describe) {
        describePaused = true;
        describePauseReason = describeGate.reason ?? undefined;
        if (previousSceneDescription?.description) {
          description = previousSceneDescription.description;
          descriptionTimestamp =
            previousSceneDescription.descriptionTimestamp ??
            previousSceneDescription.timestamp;
          descriptionStale = true;
        }
      }

      // Update entity tracker
      const _trackedEntities = await this.entityTracker.updateEntities(
        detectedObjects,
        people,
        faceProfiles,
        this.runtime,
      );

      // Create scene description
      this.lastSceneDescription = {
        timestamp: frame.timestamp,
        descriptionTimestamp,
        description,
        objects: detectedObjects,
        people,
        sceneChanged: shouldUpdateVlm || shouldUpdateTf,
        changePercentage,
        descriptionStale,
        describePaused,
        ...(describePauseReason ? { describePauseReason } : {}),
      };

      // Enhanced logging
      if (shouldUpdateVlm || shouldUpdateTf) {
        logger.info("[VisionService] Scene Analysis Complete:");
        logger.info(`  VLM Description: ${description.substring(0, 100)}...`);
        logger.info(`  Change: ${changePercentage.toFixed(1)}%`);
        logger.info(
          `  Updates: ${shouldUpdateVlm ? "VLM" : ""}${shouldUpdateVlm && shouldUpdateTf ? " + " : ""}${shouldUpdateTf ? "TF" : ""}`,
        );
        logger.info(
          `  Detection Mode: ${this.hasObjectDetection ? "ggml YOLOv8" : "Motion-based"}`,
        );

        if (detectedObjects.length > 0) {
          logger.info(`  Objects: ${detectedObjects.length} detected`);

          // Group objects by type for summary
          const objectSummary = detectedObjects.reduce(
            (acc, obj) => {
              acc[obj.type] = (acc[obj.type] || 0) + 1;
              return acc;
            },
            {} as Record<string, number>,
          );

          for (const [type, count] of Object.entries(objectSummary)) {
            logger.info(`    - ${count} ${type}(s)`);
          }
        }

        if (people.length > 0) {
          logger.info(`  People: ${people.length} detected`);
          for (const person of people) {
            logger.info(
              `    - Person: ${person.pose} pose, facing ${person.facing}, confidence: ${person.confidence.toFixed(2)}`,
            );
          }
        }
      }
    } catch (error) {
      logger.error(
        { error },
        "[VisionService] Failed to update scene description:",
      );
    }
  }

  /**
   * Normalize the various shapes that `useModel(IMAGE_DESCRIPTION, …)` may
   * return into a non-empty string. Returns `null` when the result is the
   * "I'm unable to analyze images" sentinel or empty.
   */
  private extractDescriptionFromUseModel(result: unknown): string | null {
    if (!result) return null;
    let description = "";
    if (typeof result === "string") description = result;
    else if (
      typeof result === "object" &&
      result !== null &&
      "description" in result
    ) {
      const d = (result as { description?: unknown }).description;
      if (typeof d === "string") description = d;
    }
    if (!description) return null;
    if (
      description.includes("I'm unable to analyze images") ||
      description.includes("I can't analyze images")
    ) {
      return null;
    }
    return description;
  }

  /**
   * Pull the latest desktop scene context from plugin-computeruse's
   * VisionContextProvider when registered. Returns `null` when no provider is
   * available (or when the lookup fails) so the VLM still receives a valid
   * prompt — the context block is purely additive.
   */
  private async collectVisionContext(): Promise<VisionContextSnapshot | null> {
    const candidate = this.runtime.getService(VISION_CONTEXT_SERVICE_TYPE);
    if (!isVisionContextProvider(candidate)) return null;
    try {
      return await candidate.getContext();
    } catch (error) {
      logger.warn(
        { error },
        "[VisionService] vision-context provider getContext() failed:",
      );
      return null;
    }
  }

  private collectCurrentOcrTextForPrompt(): string | null {
    const screenAnalysis = this.lastEnhancedScene?.screenAnalysis;
    const candidates = [
      screenAnalysis?.fullScreenOCR,
      screenAnalysis?.activeTile?.ocr?.fullText,
      screenAnalysis?.activeTile?.text,
    ];
    const text = candidates
      .filter((candidate): candidate is string => Boolean(candidate?.trim()))
      .join("\n");
    return text.length > 0 ? text : null;
  }

  /**
   * Resolve the change-gated per-tile describer, building it once. Returns
   * `null` (and degrades to full-frame describe) when no perceptual hash is
   * available — i.e. plugin-computeruse's `frameDhash` cannot be imported.
   *
   * The dHash is resolved via a best-effort dynamic import so plugin-vision
   * never eagerly pulls computeruse's module graph at boot (same idiom as the
   * coord-OCR bridge wiring in `index.ts`).
   */
  private async ensureDirtyTileDescriber(): Promise<DirtyTileDescriber | null> {
    if (this.dirtyTileDescriberInit) {
      return this.dirtyTileDescriber;
    }
    this.dirtyTileDescriberInit = true;
    const hashTile = await this.resolveFrameHash();
    if (!hashTile) {
      logger.debug(
        "[VisionService] per-tile dHash unavailable; using full-frame VLM describe",
      );
      return null;
    }
    const describeTile = this.buildTileDescribeFn();
    this.dirtyTileDescriber = new DirtyTileDescriber({
      hashTile,
      describeTile,
    });
    logger.info(
      "[VisionService] change-gated per-tile describe enabled (#9105)",
    );
    return this.dirtyTileDescriber;
  }

  private async resolveFrameHash(): Promise<FrameHash | null> {
    // Indirect the specifier through a const so the bundler does not eagerly
    // resolve the optional peer at build time (same idiom as the OCR-bridge
    // dynamic import in index.ts) — plugin-computeruse is an optional peer.
    const computerUseSpecifier = "@elizaos/plugin-computeruse";
    try {
      const mod = (await import(/* @vite-ignore */ computerUseSpecifier)) as {
        frameDhash?: FrameHash;
      };
      return typeof mod.frameDhash === "function" ? mod.frameDhash : null;
    } catch (err) {
      logger.debug(
        `[VisionService] plugin-computeruse dHash not available (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return null;
    }
  }

  /**
   * Build the per-tile describe call bound to this service's runtime. Reads the
   * current frame's prompt context (`dirtyTileDescribeContext`) so each tile is
   * described with the same context the full-frame path would use.
   */
  private buildTileDescribeFn(): TileDescribeFn {
    return createTileDescribeFn({
      buildTileImageUrl: tilePngToImageUrl,
      buildTilePrompt: async () => {
        const sceneContext = await this.collectVisionContext();
        return buildSceneDescriptionPrompt(
          sceneContext,
          this.collectCurrentOcrTextForPrompt(),
          this.dirtyTileDescribeContext.detectedObjects,
          this.dirtyTileDescribeContext.recognizedFaces,
        );
      },
      invokeModel: (imageUrl, prompt) =>
        this.runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
          imageUrl,
          prompt,
        }),
      extractDescription: (result) =>
        this.extractDescriptionFromUseModel(result),
    });
  }

  /**
   * Per-tile incremental scene describe. Re-describes only the tiles whose
   * perceptual hash changed since the previous frame; unchanged tiles reuse
   * their cached description. Returns `null` when the per-tile path is
   * unavailable or yields no usable text, so the caller falls back to the
   * full-frame describe.
   */
  private async describeSceneWithDirtyTiles(
    pngBytes: Buffer,
    width: number,
    height: number,
    detectedObjects: DetectedObject[],
    recognizedFaces: RecognizedFace[],
  ): Promise<string | null> {
    const describer = await this.ensureDirtyTileDescriber();
    if (!describer) return null;
    this.dirtyTileDescribeContext = { detectedObjects, recognizedFaces };
    const out = await describer.describe({
      displayId: 0,
      width,
      height,
      pngBytes,
    });
    const stats = describer.getStats();
    logger.debug(
      `[VisionService] dirty-tile describe: ${out.tiles.length} tiles, ${stats.tilesSkipped} reused, ~${stats.approxTokensSaved} tokens saved`,
    );
    const scene = out.vlmScene.trim();
    return scene.length > 0 ? scene : null;
  }

  private async describeSceneWithVLM(
    imageUrl: string,
    detectedObjects: DetectedObject[] = [],
    recognizedFaces: RecognizedFace[] = [],
  ): Promise<string> {
    return withStandaloneTrajectory(
      this.runtime,
      {
        source: "plugin-vision:scene-description",
        metadata: { modelType: ModelType.IMAGE_DESCRIPTION },
      },
      () =>
        this.describeSceneWithVLMInTrajectory(
          imageUrl,
          detectedObjects,
          recognizedFaces,
        ),
    );
  }

  private async describeSceneWithVLMInTrajectory(
    imageUrl: string,
    detectedObjects: DetectedObject[],
    recognizedFaces: RecognizedFace[],
  ): Promise<string> {
    try {
      try {
        parseVisionDataImageUrl(imageUrl);
      } catch (inputError) {
        logger.warn(
          "[VisionService] rejected unsafe VLM image input:",
          inputError instanceof Error ? inputError.message : String(inputError),
        );
        return "Unable to describe scene";
      }

      // Route every VLM call through the runtime IMAGE_DESCRIPTION handler.
      // When eliza-1 local Gemma vision is registered it owns this slot;
      // otherwise the runtime rotates to whichever cloud/remote provider
      // has registered IMAGE_DESCRIPTION. plugin-vision no longer ships its
      // own VLM.
      const sceneContext = await this.collectVisionContext();
      const prompt = buildSceneDescriptionPrompt(
        sceneContext,
        this.collectCurrentOcrTextForPrompt(),
        detectedObjects,
        recognizedFaces,
      );
      try {
        const result = await this.runtime.useModel(
          ModelType.IMAGE_DESCRIPTION,
          { imageUrl, prompt },
        );
        const description = this.extractDescriptionFromUseModel(result);
        if (description) {
          return description;
        }
      } catch (modelError) {
        logger.warn(
          { error: modelError },
          "[VisionService] IMAGE_DESCRIPTION call failed:",
        );
      }

      // No usable VLM result — synthesize a description from the latest
      // detector (YOLO / pose) outputs so callers always get something.
      if (this.lastSceneDescription) {
        const { objects, people } = this.lastSceneDescription;
        let description = "Scene contains";

        if (people.length > 0) {
          description += ` ${people.length} person${people.length > 1 ? "s" : ""}`;
          const poses = people
            .map((p) => p.pose)
            .filter((p) => p !== "unknown");
          if (poses.length > 0) {
            description += ` (${poses.join(", ")})`;
          }
        }

        if (objects.length > 0 && people.length > 0) {
          description += " and";
        }

        if (objects.length > 0) {
          const objectTypes = [...new Set(objects.map((o) => o.type))];
          description += ` ${objectTypes.join(", ")}`;
        }

        if (people.length === 0 && objects.length === 0) {
          description = "Scene appears to be empty or static";
        }

        return description;
      }

      // Final fallback
      return "Visual scene captured";
    } catch (error) {
      logger.error({ error }, "[VisionService] VLM description failed:");
      return "Unable to describe scene";
    }
  }

  private async detectMotionObjects(
    frame: VisionFrame,
  ): Promise<DetectedObject[]> {
    if (!this.lastFrame) {
      return [];
    }

    const objects: DetectedObject[] = [];
    const blockSize = 64; // Larger blocks for less noise
    const motionThreshold = 50; // Higher threshold for more significant changes

    // Divide frame into blocks and detect motion regions
    for (let y = 0; y < frame.height - blockSize; y += blockSize / 2) {
      // Overlap blocks
      for (let x = 0; x < frame.width - blockSize; x += blockSize / 2) {
        let blockMotion = 0;
        let pixelCount = 0;

        // Check motion in this block
        for (let by = 0; by < blockSize; by += 2) {
          // Sample every other pixel for speed
          for (let bx = 0; bx < blockSize; bx += 2) {
            const px = x + bx;
            const py = y + by;
            const idx = (py * frame.width + px) * 4;

            if (idx < frame.data.length && idx < this.lastFrame.data.length) {
              const r1 = frame.data[idx];
              const g1 = frame.data[idx + 1];
              const b1 = frame.data[idx + 2];
              const r2 = this.lastFrame.data[idx];
              const g2 = this.lastFrame.data[idx + 1];
              const b2 = this.lastFrame.data[idx + 2];

              const diff =
                Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
              if (diff > motionThreshold) {
                blockMotion++;
              }
              pixelCount++;
            }
          }
        }

        // If significant motion in block, consider it an object
        const motionPercentage = (blockMotion / pixelCount) * 100;
        if (motionPercentage > 30) {
          // 30% of sampled pixels show motion
          objects.push({
            id: `motion-${x}-${y}-${frame.timestamp}`,
            type: "motion-object",
            confidence: Math.min(motionPercentage / 100, 1),
            boundingBox: {
              x,
              y,
              width: blockSize,
              height: blockSize,
            },
          });
        }
      }
    }

    // Merge adjacent motion blocks into larger objects
    const merged = this.mergeAdjacentObjects(objects);

    // Filter out very small objects (likely noise)
    const filtered = merged.filter((obj) => {
      const area = obj.boundingBox.width * obj.boundingBox.height;
      return area > 2000; // Minimum area threshold
    });

    return filtered;
  }

  private mergeAdjacentObjects(objects: DetectedObject[]): DetectedObject[] {
    if (objects.length === 0) {
      return [];
    }

    const merged: DetectedObject[] = [];
    const used = new Set<number>();
    const mergeDistance = 80; // Distance to consider objects adjacent

    for (let i = 0; i < objects.length; i++) {
      if (used.has(i)) {
        continue;
      }

      const current = objects[i];
      const cluster: DetectedObject[] = [current];
      used.add(i);

      // Find all adjacent objects
      let foundNew = true;
      while (foundNew) {
        foundNew = false;
        for (let j = 0; j < objects.length; j++) {
          if (used.has(j)) {
            continue;
          }

          const other = objects[j];

          // Check if adjacent to any object in cluster
          for (const clusterObj of cluster) {
            const isAdjacent =
              Math.abs(clusterObj.boundingBox.x - other.boundingBox.x) <=
                mergeDistance &&
              Math.abs(clusterObj.boundingBox.y - other.boundingBox.y) <=
                mergeDistance;

            if (isAdjacent) {
              cluster.push(other);
              used.add(j);
              foundNew = true;
              break;
            }
          }
        }
      }

      // Merge cluster into single object
      if (cluster.length > 0) {
        const minX = Math.min(...cluster.map((o) => o.boundingBox.x));
        const minY = Math.min(...cluster.map((o) => o.boundingBox.y));
        const maxX = Math.max(
          ...cluster.map((o) => o.boundingBox.x + o.boundingBox.width),
        );
        const maxY = Math.max(
          ...cluster.map((o) => o.boundingBox.y + o.boundingBox.height),
        );
        const avgConfidence =
          cluster.reduce((sum, o) => sum + o.confidence, 0) / cluster.length;

        merged.push({
          id: `merged-${minX}-${minY}-${Date.now()}`,
          type: this.classifyObjectBySize(maxX - minX, maxY - minY),
          confidence: avgConfidence,
          boundingBox: {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
          },
        });
      }
    }

    return merged;
  }

  private classifyObjectBySize(width: number, height: number): string {
    const area = width * height;
    const aspectRatio = width / height;

    // Improved classification heuristics
    if (area > 30000 && aspectRatio > 0.4 && aspectRatio < 0.8) {
      return "person-candidate";
    } else if (area > 20000) {
      return "large-object";
    } else if (area > 8000) {
      return "medium-object";
    } else {
      return "small-object";
    }
  }

  private async detectPeopleFromMotion(
    frame: VisionFrame,
    objects: DetectedObject[],
  ): Promise<PersonInfo[]> {
    const people: PersonInfo[] = [];
    const personCandidates = objects.filter(
      (o) => o.type === "person-candidate",
    );

    for (let i = 0; i < personCandidates.length; i++) {
      const candidate = personCandidates[i];
      const box = candidate.boundingBox;

      // Simple heuristic: if height > width * 1.5, likely standing
      // if width > height, likely sitting/lying
      const aspectRatio = box.width / box.height;
      let pose: "standing" | "sitting" | "lying" | "unknown" = "unknown";

      if (aspectRatio < 0.6) {
        pose = "standing";
      } else if (aspectRatio > 1.2) {
        pose = "lying";
      } else {
        pose = "sitting";
      }

      // Estimate facing based on motion direction (simplified)
      let facing: "camera" | "away" | "left" | "right" | "unknown" = "unknown";
      if (this.lastFrame) {
        // Without a pose backend this service only records a coarse default.
        facing = "camera"; // Default assumption
      }

      people.push({
        id: `person-${i}-${frame.timestamp}`,
        confidence: candidate.confidence,
        pose,
        facing,
        boundingBox: box,
      });
    }

    return people;
  }

  private startScreenProcessing(): void {
    if (this.screenProcessingInterval) {
      return;
    }

    this.screenProcessingInterval = setInterval(async () => {
      if (!this.isProcessingScreen) {
        this.isProcessingScreen = true;
        try {
          await this.captureAndProcessScreen();
        } catch (error) {
          logger.error({ error }, "[VisionService] Screen processing error:");
        }
        this.isProcessingScreen = false;
      }
    }, this.visionConfig.screenCaptureInterval || 2000);

    logger.debug("[VisionService] Started screen processing loop");
  }

  private async captureAndProcessScreen(): Promise<void> {
    try {
      // Capture screen
      const capture = await this.screenCapture.captureScreen();
      this.lastScreenCapture = capture;

      // Process active tile
      const activeTile = this.screenCapture.getActiveTile();
      if (activeTile?.data) {
        const tileAnalysis = await this.analyzeTile(activeTile);
        activeTile.analysis = tileAnalysis;
      }

      // Update enhanced scene description
      await this.updateEnhancedSceneDescription();
    } catch (error) {
      logger.error({ error }, "[VisionService] Error capturing screen:");
    }
  }

  private async analyzeTile(tile: ScreenTile): Promise<TileAnalysis> {
    const analysis: TileAnalysis = {
      timestamp: Date.now(),
    };

    try {
      // Run OCR if enabled — coordinates feed back to the agent for grounding.
      if (this.visionConfig.ocrEnabled && tile.data) {
        analysis.ocr = await this.ocrService.extractFromTile(tile);
        analysis.text = analysis.ocr.fullText;
      }
    } catch (error) {
      logger.error({ error }, "[VisionService] Error analyzing tile:");
    }

    return analysis;
  }

  private async updateEnhancedSceneDescription(): Promise<void> {
    if (!this.lastScreenCapture) {
      return;
    }

    const enhancedScene: EnhancedSceneDescription = {
      ...(this.lastSceneDescription || {
        timestamp: Date.now(),
        description: "",
        objects: [],
        people: [],
        sceneChanged: false,
        changePercentage: 0,
      }),
      screenCapture: this.lastScreenCapture,
      screenAnalysis: {
        fullScreenOCR: "",
        activeTile: this.screenCapture.getActiveTile()?.analysis,
        gridSummary: "",
        focusedApp: "",
        uiElements: [],
      },
    };

    // Aggregate OCR from all processed tiles
    const processedTiles = this.lastScreenCapture.tiles.filter(
      (t) => t.analysis?.ocr,
    );
    if (processedTiles.length > 0 && enhancedScene.screenAnalysis) {
      enhancedScene.screenAnalysis.fullScreenOCR = processedTiles
        .map((t) => t.analysis?.ocr?.fullText)
        .join("\n");
    }

    // Generate grid summary
    if (
      this.lastScreenCapture.tiles.length > 0 &&
      enhancedScene.screenAnalysis
    ) {
      const tilesWithContent = this.lastScreenCapture.tiles.filter(
        (t) => t.analysis,
      );
      enhancedScene.screenAnalysis.gridSummary = `Screen divided into ${this.lastScreenCapture.tiles.length} tiles, ${tilesWithContent.length} analyzed`;
    }

    this.lastEnhancedScene = enhancedScene;
  }

  // Public API methods

  public async getCurrentFrame(): Promise<VisionFrame | null> {
    return this.lastFrame;
  }

  public async getSceneDescription(): Promise<SceneDescription | null> {
    return this.lastSceneDescription;
  }

  public async getEnhancedSceneDescription(): Promise<EnhancedSceneDescription | null> {
    // If worker manager is available, use its high-FPS data
    if (this.workerManager) {
      return this.workerManager.getLatestEnhancedScene();
    }

    // Otherwise fall back to standard processing
    return this.lastEnhancedScene || this.lastSceneDescription;
  }

  public async getScreenCapture(): Promise<ScreenCapture | null> {
    return this.lastScreenCapture;
  }

  public getVisionMode(): VisionMode {
    return this.visionConfig.visionMode || VisionMode.CAMERA;
  }

  /**
   * Enable the camera input. If screen is already active, switches to BOTH;
   * otherwise to CAMERA.
   */
  public async enableCamera(): Promise<void> {
    const current = this.getVisionMode();
    const next =
      current === VisionMode.SCREEN || current === VisionMode.BOTH
        ? VisionMode.BOTH
        : VisionMode.CAMERA;
    await this.setVisionMode(next);
  }

  /**
   * Disable the camera input. Keeps screen capture if active; otherwise OFF.
   */
  public async disableCamera(): Promise<void> {
    const current = this.getVisionMode();
    const next =
      current === VisionMode.BOTH || current === VisionMode.SCREEN
        ? VisionMode.SCREEN
        : VisionMode.OFF;
    await this.setVisionMode(next);
  }

  /**
   * Enable screen capture. If displayIds are passed, the first id wins as
   * the `displayIndex` (multi-display capture is still single-display
   * upstream).
   */
  public async enableScreen(displayIds?: number[]): Promise<void> {
    if (displayIds && displayIds.length > 0) {
      this.visionConfig.displayIndex = displayIds[0];
      this.visionConfig.captureAllDisplays = displayIds.length > 1;
    }
    const current = this.getVisionMode();
    const next =
      current === VisionMode.CAMERA || current === VisionMode.BOTH
        ? VisionMode.BOTH
        : VisionMode.SCREEN;
    await this.setVisionMode(next);
  }

  /**
   * Disable screen capture. Keeps camera if active; otherwise OFF.
   */
  public async disableScreen(): Promise<void> {
    const current = this.getVisionMode();
    const next =
      current === VisionMode.BOTH || current === VisionMode.CAMERA
        ? VisionMode.CAMERA
        : VisionMode.OFF;
    await this.setVisionMode(next);
  }

  public async setVisionMode(mode: VisionMode): Promise<void> {
    logger.info(
      `[VisionService] Changing vision mode from ${this.visionConfig.visionMode} to ${mode}`,
    );

    // Stop current processing
    this.stopProcessing();

    // Update configuration
    this.visionConfig.visionMode = mode;

    // Reinitialize based on new mode
    if (mode === VisionMode.OFF) {
      logger.info("[VisionService] Vision disabled");
      return;
    }

    // Initialize components for new mode
    if (
      (mode === VisionMode.CAMERA || mode === VisionMode.BOTH) &&
      !this.camera
    ) {
      await this.initializeCameraVision();
    }

    if (
      (mode === VisionMode.SCREEN || mode === VisionMode.BOTH) &&
      !this.ocrService.isInitialized()
    ) {
      await this.initializeScreenVision();
    }

    // Start processing for new mode
    this.startProcessing();
  }

  private stopProcessing(): void {
    if (this.frameProcessingInterval) {
      clearInterval(this.frameProcessingInterval);
      this.frameProcessingInterval = null;
    }

    if (this.screenProcessingInterval) {
      clearInterval(this.screenProcessingInterval);
      this.screenProcessingInterval = null;
    }

    if (this.arbiterUnsubscribe) {
      this.arbiterUnsubscribe();
      this.arbiterUnsubscribe = null;
    }
  }

  public getCameraInfo(): CameraInfo | null {
    if (!this.camera) {
      return null;
    }

    return {
      id: this.camera.id,
      name: this.camera.name,
      connected: true,
    };
  }

  public isActive(): boolean {
    return this.camera !== null && this.frameProcessingInterval !== null;
  }

  // Helper methods for face recognition
  private calculateBoxOverlap(box1: BoundingBox, box2: BoundingBox): number {
    const x1 = Math.max(box1.x, box2.x);
    const y1 = Math.max(box1.y, box2.y);
    const x2 = Math.min(box1.x + box1.width, box2.x + box2.width);
    const y2 = Math.min(box1.y + box1.height, box2.y + box2.height);

    if (x2 < x1 || y2 < y1) {
      return 0;
    }

    const intersection = (x2 - x1) * (y2 - y1);
    const area1 = box1.width * box1.height;
    const area2 = box2.width * box2.height;
    const union = area1 + area2 - intersection;

    return intersection / union;
  }

  // Public methods for entity tracking
  public getEntityTracker(): EntityTracker {
    return this.entityTracker;
  }

  public async getFaceRecognition(): Promise<FaceRecognition> {
    if (!this.faceRecognition) {
      const { FaceRecognition } = await import("./face-recognition-ggml");
      this.faceRecognition = new FaceRecognition();
    }
    return this.faceRecognition;
  }

  async stop(): Promise<void> {
    logger.info("[VisionService] Stopping vision service...");

    this.stopProcessing();

    if (this.audioCapture) {
      await this.audioCapture.stop();
      this.audioCapture = null;
    }

    if (this.streamingAudioCapture) {
      await this.streamingAudioCapture.stop();
      this.streamingAudioCapture = null;
    }

    if (this.objectDetector) {
      await this.objectDetector.dispose();
      this.objectDetector = null;
      this.hasObjectDetection = false;
    }

    if (this.workerManager) {
      await this.workerManager.stop();
      this.workerManager = null;
    }

    this.camera = null;
    this.lastFrame = null;
    this.lastSceneDescription = null;
    this.lastScreenCapture = null;
    this.lastEnhancedScene = null;
    this.dirtyTileDescriber = null;
    this.dirtyTileDescriberInit = false;
    this.isProcessing = false;
    this.isProcessingScreen = false;

    // Dispose of models
    await this.ocrService.dispose();

    logger.info("[VisionService] Stopped.");
  }

  private async findCamera(): Promise<CameraDevice | null> {
    try {
      // Get list of available cameras
      const cameras = await this.listCameras();

      if (cameras.length === 0) {
        logger.warn("[VisionService] No cameras detected");
        return null;
      }

      // If camera name is specified, try to find it
      if (this.visionConfig.cameraName) {
        const searchName = this.visionConfig.cameraName.toLowerCase();
        const matchedCamera = cameras.find((cam) =>
          cam.name.toLowerCase().includes(searchName),
        );

        if (matchedCamera) {
          return this.createCameraDevice(matchedCamera);
        }

        logger.warn(
          `[VisionService] Camera "${this.visionConfig.cameraName}" not found, using default`,
        );
      }

      // Use first available camera
      return this.createCameraDevice(cameras[0]);
    } catch (error) {
      logger.error({ error }, "[VisionService] Error finding camera:");
      return null;
    }
  }

  private async listCameras(): Promise<CameraInfo[]> {
    // Mobile bridge (if registered) enumerates the phone's cameras; the desktop
    // CLI probes below don't exist on Android/iOS.
    const mobileSource = getMobileCameraSource();
    if (mobileSource) {
      return mobileSource.listCameras();
    }

    const platform = process.platform;

    try {
      if (platform === "darwin") {
        // macOS: Use system_profiler
        const { stdout } = await execAsync(
          "system_profiler SPCameraDataType -json",
        );
        const data = JSON.parse(stdout);
        const cameras: CameraInfo[] = [];

        if (data.SPCameraDataType && Array.isArray(data.SPCameraDataType)) {
          for (const camera of data.SPCameraDataType) {
            cameras.push({
              id: camera.unique_id || camera._name,
              name: camera._name,
              connected: true,
            });
          }
        }

        return cameras;
      } else if (platform === "linux") {
        // Linux: Use v4l2
        const { stdout } = await execAsync("v4l2-ctl --list-devices");
        const cameras: CameraInfo[] = [];
        const lines = stdout.split("\n");

        let currentName = "";
        for (const line of lines) {
          if (line && !line.startsWith("\t")) {
            currentName = line.replace(":", "").trim();
          } else if (line.trim().startsWith("/dev/video")) {
            const devicePath = line.trim();
            const id = devicePath.replace("/dev/video", "");
            cameras.push({
              id,
              name: currentName,
              connected: true,
            });
          }
        }

        return cameras;
      } else if (platform === "win32") {
        // Windows: Use PowerShell
        const { stdout } = await execAsync(
          'powershell -Command "Get-PnpDevice -Class Camera | Select-Object FriendlyName, InstanceId | ConvertTo-Json"',
        );
        const devices = JSON.parse(stdout);
        const cameras: CameraInfo[] = [];

        if (Array.isArray(devices)) {
          for (const device of devices) {
            cameras.push({
              id: device.InstanceId,
              name: device.FriendlyName,
              connected: true,
            });
          }
        }

        return cameras;
      }

      return [];
    } catch (error) {
      logger.error({ error }, "[VisionService] Error listing cameras:");
      return [];
    }
  }

  private createCameraDevice(info: CameraInfo): CameraDevice {
    const platform = process.platform;

    return {
      id: info.id,
      name: info.name,
      capture: async () => {
        // Mobile: the registered bridge captures a JPEG in-process (no temp
        // file, no CLI tool). Preferred over the desktop paths below whenever a
        // source is registered — on a phone it is the only one that works.
        const mobileSource = getMobileCameraSource();
        if (mobileSource) {
          return mobileSource.captureJpeg();
        }

        const tempFile = path.join(
          process.cwd(),
          `temp_capture_${Date.now()}.jpg`,
        );

        try {
          if (platform === "darwin") {
            // macOS: Use imagesnap
            try {
              await execAsync(`imagesnap -d "${info.name}" "${tempFile}"`);
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              if (errorMessage.includes("command not found")) {
                throw new Error(
                  "imagesnap not installed. Run: brew install imagesnap",
                );
              }
              throw error;
            }
          } else if (platform === "linux") {
            // Linux: Use fswebcam
            try {
              await execAsync(
                `fswebcam -d /dev/video${info.id} -r 1280x720 --jpeg 85 "${tempFile}"`,
              );
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              if (errorMessage.includes("command not found")) {
                throw new Error(
                  "fswebcam not installed. Run: sudo apt-get install fswebcam",
                );
              }
              throw error;
            }
          } else if (platform === "win32") {
            // Windows: Use DirectShow via ffmpeg
            try {
              await execAsync(
                `ffmpeg -f dshow -i video="${info.name}" -frames:v 1 -q:v 2 "${tempFile}" -y`,
              );
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              if (
                errorMessage.includes("not recognized") ||
                errorMessage.includes("not found")
              ) {
                throw new Error(
                  "ffmpeg not installed. Download from ffmpeg.org and add to PATH",
                );
              }
              throw error;
            }
          } else {
            throw new Error(`Unsupported platform: ${platform}`);
          }

          // Read the captured image
          const imageBuffer = await fs.readFile(tempFile);

          // Command-line camera tools write through a temporary image file.
          await fs.unlink(tempFile).catch(() => {});

          return imageBuffer;
        } catch (error) {
          // Failed captures still need to release temporary image files.
          await fs.unlink(tempFile).catch(() => {});
          throw error;
        }
      },
    };
  }

  public async captureImage(): Promise<Buffer | null> {
    if (!this.camera) {
      logger.warn("[VisionService] No camera available for capture");
      return null;
    }

    try {
      return await this.camera.capture();
    } catch (error) {
      logger.error({ error }, "[VisionService] Failed to capture image:");
      return null;
    }
  }
}
