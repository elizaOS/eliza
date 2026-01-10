import { z } from 'zod';
import { logger } from '@elizaos/core';
import type { VisionConfig, VisionMode } from './types';

// Default configuration for backward compatibility
export const defaultVisionConfig: VisionConfig = {
  pixelChangeThreshold: 50,
  updateInterval: 100,
  enablePoseDetection: false,
  enableObjectDetection: false,
  tfUpdateInterval: 1000,
  vlmUpdateInterval: 10000,
  tfChangeThreshold: 10,
  vlmChangeThreshold: 50,
  visionMode: 'CAMERA' as VisionMode,
  screenCaptureInterval: 2000,
  tileSize: 256,
  tileProcessingOrder: 'priority',
  ocrEnabled: true,
  florence2Enabled: true,
};

// Configuration schema using Zod for validation
export const VisionConfigSchema = z.object({
  // Camera configuration
  cameraName: z.string().optional(),
  enableCamera: z.boolean().default(true),

  // Vision processing
  pixelChangeThreshold: z.number().min(0).max(100).default(50),
  updateInterval: z.number().min(10).max(10000).default(100),

  // Object detection
  enableObjectDetection: z.boolean().default(false),
  objectConfidenceThreshold: z.number().min(0).max(1).default(0.5),

  // Pose detection
  enablePoseDetection: z.boolean().default(false),
  poseConfidenceThreshold: z.number().min(0).max(1).default(0.5),

  // Update intervals
  tfUpdateInterval: z.number().min(100).max(60000).default(1000),
  vlmUpdateInterval: z.number().min(1000).max(300000).default(10000),
  tfChangeThreshold: z.number().min(0).max(100).default(10),
  vlmChangeThreshold: z.number().min(0).max(100).default(50),

  // Vision mode
  visionMode: z.enum(['OFF', 'CAMERA', 'SCREEN', 'BOTH']).default('CAMERA'),

  // Screen capture
  screenCaptureInterval: z.number().min(100).max(60000).default(2000),
  tileSize: z.number().min(64).max(1024).default(256),
  tileProcessingOrder: z.enum(['sequential', 'priority', 'random']).default('priority'),
  maxConcurrentTiles: z.number().min(1).max(10).default(3),

  // OCR configuration
  ocrEnabled: z.boolean().default(true),
  ocrLanguage: z.string().default('eng'),
  ocrConfidenceThreshold: z.number().min(0).max(100).default(60),

  // Florence-2 configuration
  florence2Enabled: z.boolean().default(true),
  florence2Provider: z.enum(['local', 'azure', 'huggingface', 'replicate']).optional(),
  florence2Endpoint: z.string().url().optional(),
  florence2ApiKey: z.string().optional(),
  florence2Timeout: z.number().min(1000).max(300000).default(30000),

  // Face recognition
  enableFaceRecognition: z.boolean().default(false),
  faceMatchThreshold: z.number().min(0).max(1).default(0.6),
  maxFaceProfiles: z.number().min(10).max(10000).default(1000),

  // Entity tracking
  entityTimeout: z.number().min(1000).max(300000).default(30000),
  maxTrackedEntities: z.number().min(10).max(1000).default(100),

  // Performance
  enableGPUAcceleration: z.boolean().default(true),
  maxMemoryUsageMB: z.number().min(100).max(8000).default(2000),

  // Logging
  debugMode: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

export type VisionConfigInput = z.input<typeof VisionConfigSchema>;
export type VisionConfigOutput = z.output<typeof VisionConfigSchema>;

export class ConfigurationManager {
  private config: VisionConfigOutput;
  private runtime: any;

  constructor(runtime: any) {
    this.runtime = runtime;
    this.config = this.loadConfiguration();
  }

  private loadConfiguration(): VisionConfigOutput {
    // Load from environment variables and runtime settings
    const rawConfig: Partial<VisionConfigInput> = {
      // Camera
      cameraName: this.getSetting('CAMERA_NAME') || this.getSetting('VISION_CAMERA_NAME'),
      enableCamera: this.getBooleanSetting('ENABLE_CAMERA', true),

      // Vision processing
      pixelChangeThreshold: this.getNumberSetting('PIXEL_CHANGE_THRESHOLD', 50),
      updateInterval: this.getNumberSetting('UPDATE_INTERVAL', 100),

      // Object detection
      enableObjectDetection: this.getBooleanSetting('ENABLE_OBJECT_DETECTION', false),
      objectConfidenceThreshold: this.getNumberSetting('OBJECT_CONFIDENCE_THRESHOLD', 0.5),

      // Pose detection
      enablePoseDetection: this.getBooleanSetting('ENABLE_POSE_DETECTION', false),
      poseConfidenceThreshold: this.getNumberSetting('POSE_CONFIDENCE_THRESHOLD', 0.5),

      // Update intervals
      tfUpdateInterval: this.getNumberSetting('TF_UPDATE_INTERVAL', 1000),
      vlmUpdateInterval: this.getNumberSetting('VLM_UPDATE_INTERVAL', 10000),
      tfChangeThreshold: this.getNumberSetting('TF_CHANGE_THRESHOLD', 10),
      vlmChangeThreshold: this.getNumberSetting('VLM_CHANGE_THRESHOLD', 50),

      // Vision mode
      visionMode: this.getSetting('VISION_MODE') as VisionMode,

      // Screen capture
      screenCaptureInterval: this.getNumberSetting('SCREEN_CAPTURE_INTERVAL', 2000),
      tileSize: this.getNumberSetting('TILE_SIZE', 256),
      tileProcessingOrder: this.getSetting('TILE_PROCESSING_ORDER') as any,
      maxConcurrentTiles: this.getNumberSetting('MAX_CONCURRENT_TILES', 3),

      // OCR
      ocrEnabled: this.getBooleanSetting('OCR_ENABLED', true),
      ocrLanguage: this.getSetting('OCR_LANGUAGE') || 'eng',
      ocrConfidenceThreshold: this.getNumberSetting('OCR_CONFIDENCE_THRESHOLD', 60),

      // Florence-2
      florence2Enabled: this.getBooleanSetting('FLORENCE2_ENABLED', true),
      florence2Provider: this.getSetting('FLORENCE2_PROVIDER') as any,
      florence2Endpoint: this.getSetting('FLORENCE2_ENDPOINT'),
      florence2ApiKey: this.getSetting('FLORENCE2_API_KEY'),
      florence2Timeout: this.getNumberSetting('FLORENCE2_TIMEOUT', 30000),

      // Face recognition
      enableFaceRecognition: this.getBooleanSetting('ENABLE_FACE_RECOGNITION', false),
      faceMatchThreshold: this.getNumberSetting('FACE_MATCH_THRESHOLD', 0.6),
      maxFaceProfiles: this.getNumberSetting('MAX_FACE_PROFILES', 1000),

      // Entity tracking
      entityTimeout: this.getNumberSetting('ENTITY_TIMEOUT', 30000),
      maxTrackedEntities: this.getNumberSetting('MAX_TRACKED_ENTITIES', 100),

      // Performance
      enableGPUAcceleration: this.getBooleanSetting('ENABLE_GPU_ACCELERATION', true),
      maxMemoryUsageMB: this.getNumberSetting('MAX_MEMORY_USAGE_MB', 2000),

      // Logging
      debugMode: this.getBooleanSetting('DEBUG_MODE', false),
      logLevel: (this.getSetting('LOG_LEVEL') as any) || 'info',
    };

    // Validate and parse configuration
    try {
      const parsed = VisionConfigSchema.parse(rawConfig);
      logger.info('[ConfigurationManager] Configuration loaded successfully');

      if (parsed.debugMode) {
        logger.debug('[ConfigurationManager] Configuration:', parsed);
      }

      return parsed;
    } catch (error) {
      logger.error('[ConfigurationManager] Invalid configuration:', error);
      if (error instanceof z.ZodError) {
        logger.error('[ConfigurationManager] Validation errors:', error.errors);
      }

      // Return default configuration on error
      return VisionConfigSchema.parse({});
    }
  }

  private getSetting(key: string): string | undefined {
    // Try with VISION_ prefix first
    const visionKey = `VISION_${key}`;
    const value = this.runtime.getSetting(visionKey) || this.runtime.getSetting(key);
    return value || undefined;
  }

  private getBooleanSetting(key: string, defaultValue: boolean): boolean {
    const value = this.getSetting(key);
    if (value === undefined) {
      return defaultValue;
    }
    return value.toLowerCase() === 'true';
  }

  private getNumberSetting(key: string, defaultValue: number): number {
    const value = this.getSetting(key);
    if (value === undefined) {
      return defaultValue;
    }
    const parsed = Number(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  // Public API
  get(): VisionConfigOutput {
    return { ...this.config };
  }

  update(updates: Partial<VisionConfigInput>): void {
    try {
      const newConfig = { ...this.config, ...updates };
      const parsed = VisionConfigSchema.parse(newConfig);
      this.config = parsed;
      logger.info('[ConfigurationManager] Configuration updated');
    } catch (error) {
      logger.error('[ConfigurationManager] Failed to update configuration:', error);
      throw error;
    }
  }

  // Convert to legacy VisionConfig format for backward compatibility
  toLegacyFormat(): VisionConfig {
    return {
      cameraName: this.config.cameraName,
      pixelChangeThreshold: this.config.pixelChangeThreshold,
      updateInterval: this.config.updateInterval,
      enableObjectDetection: this.config.enableObjectDetection,
      enablePoseDetection: this.config.enablePoseDetection,
      tfUpdateInterval: this.config.tfUpdateInterval,
      vlmUpdateInterval: this.config.vlmUpdateInterval,
      tfChangeThreshold: this.config.tfChangeThreshold,
      vlmChangeThreshold: this.config.vlmChangeThreshold,
      visionMode: this.config.visionMode as VisionMode,
      screenCaptureInterval: this.config.screenCaptureInterval,
      tileSize: this.config.tileSize,
      tileProcessingOrder: this.config.tileProcessingOrder,
      ocrEnabled: this.config.ocrEnabled,
      florence2Enabled: this.config.florence2Enabled,
    };
  }

  // Configuration presets
  static getPreset(name: string): Partial<VisionConfigInput> {
    const presets: Record<string, Partial<VisionConfigInput>> = {
      'high-performance': {
        updateInterval: 50,
        tfUpdateInterval: 500,
        vlmUpdateInterval: 5000,
        enableGPUAcceleration: true,
        maxConcurrentTiles: 5,
      },
      'low-resource': {
        updateInterval: 200,
        tfUpdateInterval: 2000,
        vlmUpdateInterval: 20000,
        enableObjectDetection: false,
        enablePoseDetection: false,
        maxMemoryUsageMB: 500,
        maxConcurrentTiles: 1,
      },
      'security-monitoring': {
        enableObjectDetection: true,
        enablePoseDetection: true,
        enableFaceRecognition: true,
        updateInterval: 100,
        entityTimeout: 60000,
      },
      'screen-reader': {
        visionMode: 'SCREEN',
        ocrEnabled: true,
        florence2Enabled: true,
        screenCaptureInterval: 1000,
        tileProcessingOrder: 'priority',
      },
    };

    return presets[name] || {};
  }
}
