import { logger } from "@elizaos/core";
import { z } from "zod";
import type { VisionConfig, VisionMode } from "./types";

export const defaultVisionConfig: VisionConfig = {
  pixelChangeThreshold: 50,
  updateInterval: 100,
  enablePoseDetection: false,
  enableObjectDetection: false,
  tfUpdateInterval: 1000,
  vlmUpdateInterval: 10000,
  tfChangeThreshold: 10,
  vlmChangeThreshold: 50,
  visionMode: "CAMERA" as VisionMode,
  screenCaptureInterval: 2000,
  tileSize: 256,
  tileProcessingOrder: "priority",
  ocrEnabled: true,
  florence2Enabled: true,
};

export const VisionConfigSchema = z.object({
  cameraName: z.string().optional(),
  enableCamera: z.boolean().default(true),
  pixelChangeThreshold: z.number().min(0).max(100).default(50),
  updateInterval: z.number().min(10).max(10000).default(100),
  enableObjectDetection: z.boolean().default(false),
  objectConfidenceThreshold: z.number().min(0).max(1).default(0.5),
  enablePoseDetection: z.boolean().default(false),
  poseConfidenceThreshold: z.number().min(0).max(1).default(0.5),
  tfUpdateInterval: z.number().min(100).max(60000).default(1000),
  vlmUpdateInterval: z.number().min(1000).max(300000).default(10000),
  tfChangeThreshold: z.number().min(0).max(100).default(10),
  vlmChangeThreshold: z.number().min(0).max(100).default(50),
  visionMode: z.enum(["OFF", "CAMERA", "SCREEN", "BOTH"]).default("CAMERA"),
  screenCaptureInterval: z.number().min(100).max(60000).default(2000),
  tileSize: z.number().min(64).max(1024).default(256),
  tileProcessingOrder: z.enum(["sequential", "priority", "random"]).default("priority"),
  maxConcurrentTiles: z.number().min(1).max(10).default(3),
  ocrEnabled: z.boolean().default(true),
  ocrLanguage: z.string().default("eng"),
  ocrConfidenceThreshold: z.number().min(0).max(100).default(60),
  florence2Enabled: z.boolean().default(true),
  florence2Provider: z.enum(["local", "azure", "huggingface", "replicate"]).optional(),
  florence2Endpoint: z.string().url().optional(),
  florence2ApiKey: z.string().optional(),
  florence2Timeout: z.number().min(1000).max(300000).default(30000),
  enableFaceRecognition: z.boolean().default(false),
  faceMatchThreshold: z.number().min(0).max(1).default(0.6),
  maxFaceProfiles: z.number().min(10).max(10000).default(1000),
  entityTimeout: z.number().min(1000).max(300000).default(30000),
  maxTrackedEntities: z.number().min(10).max(1000).default(100),
  enableGPUAcceleration: z.boolean().default(true),
  maxMemoryUsageMB: z.number().min(100).max(8000).default(2000),
  debugMode: z.boolean().default(false),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
});

export type VisionConfigInput = z.input<typeof VisionConfigSchema>;
export type VisionConfigOutput = z.output<typeof VisionConfigSchema>;

interface RuntimeWithSettings {
  getSetting(key: string): string | undefined;
}

export class ConfigurationManager {
  private config: VisionConfigOutput;
  private runtime: RuntimeWithSettings;

  constructor(runtime: RuntimeWithSettings) {
    this.runtime = runtime;
    this.config = this.loadConfiguration();
  }

  private loadConfiguration(): VisionConfigOutput {
    const rawConfig: Partial<VisionConfigInput> = {
      cameraName: this.getSetting("CAMERA_NAME") || this.getSetting("VISION_CAMERA_NAME"),
      enableCamera: this.getBooleanSetting("ENABLE_CAMERA", true),
      pixelChangeThreshold: this.getNumberSetting("PIXEL_CHANGE_THRESHOLD", 50),
      updateInterval: this.getNumberSetting("UPDATE_INTERVAL", 100),
      enableObjectDetection: this.getBooleanSetting("ENABLE_OBJECT_DETECTION", false),
      objectConfidenceThreshold: this.getNumberSetting("OBJECT_CONFIDENCE_THRESHOLD", 0.5),
      enablePoseDetection: this.getBooleanSetting("ENABLE_POSE_DETECTION", false),
      poseConfidenceThreshold: this.getNumberSetting("POSE_CONFIDENCE_THRESHOLD", 0.5),
      tfUpdateInterval: this.getNumberSetting("TF_UPDATE_INTERVAL", 1000),
      vlmUpdateInterval: this.getNumberSetting("VLM_UPDATE_INTERVAL", 10000),
      tfChangeThreshold: this.getNumberSetting("TF_CHANGE_THRESHOLD", 10),
      vlmChangeThreshold: this.getNumberSetting("VLM_CHANGE_THRESHOLD", 50),
      visionMode: this.getSetting("VISION_MODE") as VisionMode,
      screenCaptureInterval: this.getNumberSetting("SCREEN_CAPTURE_INTERVAL", 2000),
      tileSize: this.getNumberSetting("TILE_SIZE", 256),
      tileProcessingOrder: this.getEnumSetting<"sequential" | "priority" | "random">(
        "TILE_PROCESSING_ORDER",
        "priority",
        ["sequential", "priority", "random"]
      ),
      maxConcurrentTiles: this.getNumberSetting("MAX_CONCURRENT_TILES", 3),
      ocrEnabled: this.getBooleanSetting("OCR_ENABLED", true),
      ocrLanguage: this.getSetting("OCR_LANGUAGE") || "eng",
      ocrConfidenceThreshold: this.getNumberSetting("OCR_CONFIDENCE_THRESHOLD", 60),
      florence2Enabled: this.getBooleanSetting("FLORENCE2_ENABLED", true),
      florence2Provider: this.getEnumSetting<"local" | "azure" | "huggingface" | "replicate">(
        "FLORENCE2_PROVIDER",
        undefined,
        ["local", "azure", "huggingface", "replicate"]
      ),
      florence2Endpoint: this.getSetting("FLORENCE2_ENDPOINT"),
      florence2ApiKey: this.getSetting("FLORENCE2_API_KEY"),
      florence2Timeout: this.getNumberSetting("FLORENCE2_TIMEOUT", 30000),
      enableFaceRecognition: this.getBooleanSetting("ENABLE_FACE_RECOGNITION", false),
      faceMatchThreshold: this.getNumberSetting("FACE_MATCH_THRESHOLD", 0.6),
      maxFaceProfiles: this.getNumberSetting("MAX_FACE_PROFILES", 1000),

      // Entity tracking
      entityTimeout: this.getNumberSetting("ENTITY_TIMEOUT", 30000),
      maxTrackedEntities: this.getNumberSetting("MAX_TRACKED_ENTITIES", 100),
      enableGPUAcceleration: this.getBooleanSetting("ENABLE_GPU_ACCELERATION", true),
      maxMemoryUsageMB: this.getNumberSetting("MAX_MEMORY_USAGE_MB", 2000),
      debugMode: this.getBooleanSetting("DEBUG_MODE", false),
      logLevel:
        (this.getSetting("LOG_LEVEL") as "error" | "warn" | "info" | "debug" | undefined) || "info",
    };

    try {
      const parsed = VisionConfigSchema.parse(rawConfig);
      logger.info("[ConfigurationManager] Configuration loaded successfully");

      if (parsed.debugMode) {
        logger.debug("[ConfigurationManager] Configuration:", JSON.stringify(parsed));
      }

      return parsed;
    } catch (error) {
      logger.error("[ConfigurationManager] Invalid configuration:", error);
      if (error instanceof z.ZodError) {
        logger.error("[ConfigurationManager] Validation errors:", JSON.stringify(error.issues));
      }

      return VisionConfigSchema.parse({});
    }
  }

  private getSetting(key: string): string | undefined {
    const visionKey = `VISION_${key}`;
    const value = this.runtime.getSetting(visionKey) || this.runtime.getSetting(key);
    return value || undefined;
  }

  private getBooleanSetting(key: string, defaultValue: boolean): boolean {
    const value = this.getSetting(key);
    if (value === undefined) {
      return defaultValue;
    }
    return value.toLowerCase() === "true";
  }

  private getNumberSetting(key: string, defaultValue: number): number {
    const value = this.getSetting(key);
    if (value === undefined) {
      return defaultValue;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }

  private getEnumSetting<T extends string>(
    key: string,
    defaultValue: T | undefined,
    validValues: readonly T[]
  ): T | undefined {
    const value = this.getSetting(key);
    if (value === undefined) {
      return defaultValue;
    }
    if (validValues.includes(value as T)) {
      return value as T;
    }
    return defaultValue;
  }

  get(): VisionConfigOutput {
    return { ...this.config };
  }

  update(updates: Partial<VisionConfigInput>): void {
    try {
      const newConfig = { ...this.config, ...updates };
      const parsed = VisionConfigSchema.parse(newConfig);
      this.config = parsed;
      logger.info("[ConfigurationManager] Configuration updated");
    } catch (error) {
      logger.error("[ConfigurationManager] Failed to update configuration:", error);
      throw error;
    }
  }

  static getPreset(name: string): Partial<VisionConfigInput> {
    const presets: Record<string, Partial<VisionConfigInput>> = {
      "high-performance": {
        updateInterval: 50,
        tfUpdateInterval: 500,
        vlmUpdateInterval: 5000,
        enableGPUAcceleration: true,
        maxConcurrentTiles: 5,
      },
      "low-resource": {
        updateInterval: 200,
        tfUpdateInterval: 2000,
        vlmUpdateInterval: 20000,
        enableObjectDetection: false,
        enablePoseDetection: false,
        maxMemoryUsageMB: 500,
        maxConcurrentTiles: 1,
      },
      "security-monitoring": {
        enableObjectDetection: true,
        enablePoseDetection: true,
        enableFaceRecognition: true,
        updateInterval: 100,
        entityTimeout: 60000,
      },
      "screen-reader": {
        visionMode: "SCREEN",
        ocrEnabled: true,
        florence2Enabled: true,
        screenCaptureInterval: 1000,
        tileProcessingOrder: "priority",
      },
    };

    return presets[name] || {};
  }
}
