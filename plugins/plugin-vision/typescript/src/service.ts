// Vision service for camera integration and scene analysis
import {
  logger,
  ModelType,
  Service,
  type IAgentRuntime,
  type ServiceTypeName,
} from '@elizaos/core';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import { promisify } from 'util';
import { AudioCaptureService, type AudioConfig } from './audio-capture';
import { StreamingAudioCaptureService, type StreamingAudioConfig } from './audio-capture-stream';
import { EntityTracker } from './entity-tracker';
import { FaceRecognition } from './face-recognition';
import { Florence2Model } from './florence2-model';
import { OCRService } from './ocr-service';
import { ScreenCaptureService } from './screen-capture';
import {
  VisionMode,
  VisionServiceType,
  type BoundingBox,
  type CameraInfo,
  type DetectedObject,
  type EnhancedSceneDescription,
  type PersonInfo,
  type SceneDescription,
  type ScreenCapture,
  type TileAnalysis,
  type VisionConfig,
  type VisionFrame,
} from './types';
import { VisionModels } from './vision-models';
import { VisionWorkerManager } from './vision-worker-manager';

const execAsync = promisify(exec);

interface CameraDevice {
  id: string;
  name: string;
  capture: () => Promise<Buffer>;
}

export class VisionService extends Service {
  static override serviceType: ServiceTypeName = VisionServiceType.VISION;
  override capabilityDescription =
    'Provides visual perception through camera integration and scene analysis.';

  private visionConfig: VisionConfig;
  private camera: CameraDevice | null = null;
  private lastFrame: VisionFrame | null = null;
  private lastSceneDescription: SceneDescription | null = null;
  private frameProcessingInterval: NodeJS.Timeout | null = null;
  private screenProcessingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isProcessingScreen = false;
  private visionModels: VisionModels;
  private faceRecognition: FaceRecognition;
  private entityTracker: EntityTracker;
  private audioCapture: AudioCaptureService | null = null;
  private streamingAudioCapture: StreamingAudioCaptureService | null = null;

  // Screen vision components
  private screenCapture: ScreenCaptureService;
  private florence2: Florence2Model;
  private ocrService: OCRService;
  private lastScreenCapture: ScreenCapture | null = null;
  private lastEnhancedScene: EnhancedSceneDescription | null = null;

  // Worker manager for high-FPS processing
  private workerManager: VisionWorkerManager | null = null;

  // Add tracking for last update times
  private lastTfUpdateTime = 0;
  private lastVlmUpdateTime = 0;
  private lastTfDescription = '';

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
    tileProcessingOrder: 'priority',
    ocrEnabled: true,
    florence2Enabled: true,
  };

  constructor(runtime: IAgentRuntime) {
    super(runtime);

    // Load configuration from runtime settings
    this.visionConfig = this.parseConfig(runtime);

    // Initialize vision models
    this.visionModels = new VisionModels(runtime);

    // Initialize face recognition
    this.faceRecognition = new FaceRecognition();

    // Initialize entity tracker
    const worldId = runtime.getSetting('WORLD_ID') || 'default-world';
    this.entityTracker = new EntityTracker(worldId);

    // Initialize screen capture
    this.screenCapture = new ScreenCaptureService(this.visionConfig);

    // Initialize Florence-2
    this.florence2 = new Florence2Model();

    // Initialize OCR service
    this.ocrService = new OCRService();

    logger.info('[VisionService] Constructed with config:', this.visionConfig);
  }

  private parseConfig(runtime: IAgentRuntime): VisionConfig {
    return {
      ...this.DEFAULT_CONFIG,
      cameraName: runtime.getSetting('CAMERA_NAME') || runtime.getSetting('VISION_CAMERA_NAME'),
      pixelChangeThreshold:
        Number(
          runtime.getSetting('PIXEL_CHANGE_THRESHOLD') ||
            runtime.getSetting('VISION_PIXEL_CHANGE_THRESHOLD')
        ) || this.DEFAULT_CONFIG.pixelChangeThreshold,
      enableObjectDetection:
        runtime.getSetting('ENABLE_OBJECT_DETECTION') === 'true' ||
        runtime.getSetting('VISION_ENABLE_OBJECT_DETECTION') === 'true',
      enablePoseDetection:
        runtime.getSetting('ENABLE_POSE_DETECTION') === 'true' ||
        runtime.getSetting('VISION_ENABLE_POSE_DETECTION') === 'true',
      tfUpdateInterval:
        Number(
          runtime.getSetting('TF_UPDATE_INTERVAL') ||
            runtime.getSetting('VISION_TF_UPDATE_INTERVAL')
        ) || this.DEFAULT_CONFIG.tfUpdateInterval,
      vlmUpdateInterval:
        Number(
          runtime.getSetting('VLM_UPDATE_INTERVAL') ||
            runtime.getSetting('VISION_VLM_UPDATE_INTERVAL')
        ) || this.DEFAULT_CONFIG.vlmUpdateInterval,
      tfChangeThreshold:
        Number(
          runtime.getSetting('TF_CHANGE_THRESHOLD') ||
            runtime.getSetting('VISION_TF_CHANGE_THRESHOLD')
        ) || this.DEFAULT_CONFIG.tfChangeThreshold,
      vlmChangeThreshold:
        Number(
          runtime.getSetting('VLM_CHANGE_THRESHOLD') ||
            runtime.getSetting('VISION_VLM_CHANGE_THRESHOLD')
        ) || this.DEFAULT_CONFIG.vlmChangeThreshold,
      visionMode:
        (runtime.getSetting('VISION_MODE') as VisionMode) || this.DEFAULT_CONFIG.visionMode,
      screenCaptureInterval:
        Number(
          runtime.getSetting('SCREEN_CAPTURE_INTERVAL') ||
            runtime.getSetting('VISION_SCREEN_CAPTURE_INTERVAL')
        ) || this.DEFAULT_CONFIG.screenCaptureInterval,
      ocrEnabled:
        runtime.getSetting('OCR_ENABLED') === 'true' ||
        runtime.getSetting('VISION_OCR_ENABLED') === 'true',
      florence2Enabled:
        runtime.getSetting('FLORENCE2_ENABLED') === 'true' ||
        runtime.getSetting('VISION_FLORENCE2_ENABLED') === 'true',
    };
  }

  static async start(runtime: IAgentRuntime): Promise<VisionService> {
    const service = new VisionService(runtime);
    await service.initialize();
    return service;
  }

  private async checkCameraTools(): Promise<{ available: boolean; tool: string }> {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        // Check if imagesnap is installed
        await execAsync('which imagesnap');
        return { available: true, tool: 'imagesnap' };
      } else if (platform === 'linux') {
        // Check if fswebcam is installed
        await execAsync('which fswebcam');
        return { available: true, tool: 'fswebcam' };
      } else if (platform === 'win32') {
        // Check if ffmpeg is available
        await execAsync('where ffmpeg');
        return { available: true, tool: 'ffmpeg' };
      }
      return { available: false, tool: 'none' };
    } catch (_error) {
      // Tool not found
      return { available: false, tool: 'none' };
    }
  }

  private async initialize(): Promise<void> {
    try {
      // Initialize vision models if enabled
      const useEnhancedModels =
        this.visionConfig.enableObjectDetection || this.visionConfig.enablePoseDetection;

      if (useEnhancedModels) {
        try {
          // Try to initialize TensorFlow models first
          await this.visionModels.initialize({
            enableObjectDetection: this.visionConfig.enableObjectDetection || false,
            enablePoseDetection: this.visionConfig.enablePoseDetection || false,
          });
          logger.info('[VisionService] Using TensorFlow.js models for advanced detection');
        } catch (_tfError) {
          logger.warn(
            '[VisionService] TensorFlow.js not available, falling back to enhanced heuristics'
          );
          // Fall back to enhanced heuristics
          await this.visionModels.initialize({
            enableObjectDetection: this.visionConfig.enableObjectDetection || false,
            enablePoseDetection: this.visionConfig.enablePoseDetection || false,
          });
          logger.info('[VisionService] Using enhanced heuristics for detection');
        }
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
      logger.error('[VisionService] Failed to initialize:', error);
    }
  }

  private async initializeScreenVision(): Promise<void> {
    try {
      logger.info('[VisionService] Initializing screen vision...');

      // Check if we should use worker threads for high-FPS processing
      const useWorkers =
        this.visionConfig.targetScreenFPS && this.visionConfig.targetScreenFPS > 10;

      if (useWorkers) {
        // Initialize worker manager for high-FPS processing
        logger.info('[VisionService] Initializing worker threads for high-FPS processing...');
        this.workerManager = new VisionWorkerManager(this.visionConfig);
        await this.workerManager.initialize();
        logger.info('[VisionService] Worker threads initialized');
      } else {
        // Initialize standard components
        // Initialize Florence-2 if enabled
        if (this.visionConfig.florence2Enabled) {
          await this.florence2.initialize();
        }

        // Initialize OCR if enabled
        if (this.visionConfig.ocrEnabled) {
          await this.ocrService.initialize();
        }
      }

      // Get screen info
      const screenInfo = await this.screenCapture.getScreenInfo();
      if (screenInfo) {
        logger.info(`[VisionService] Screen resolution: ${screenInfo.width}x${screenInfo.height}`);
      }

      logger.info('[VisionService] Screen vision initialized');
    } catch (error) {
      logger.error('[VisionService] Failed to initialize screen vision:', error);
    }
  }

  private async initializeCameraVision(): Promise<void> {
    // Check if camera tools are available
    const toolCheck = await this.checkCameraTools();
    if (!toolCheck.available) {
      const platform = process.platform;
      const toolName =
        platform === 'darwin' ? 'imagesnap' : platform === 'linux' ? 'fswebcam' : 'ffmpeg';
      logger.warn(
        `[VisionService] Camera capture tool '${toolName}' not found. Install it to enable camera functionality.`
      );
      logger.warn('[VisionService] For macOS: brew install imagesnap');
      logger.warn('[VisionService] For Linux: sudo apt-get install fswebcam');
      logger.warn('[VisionService] For Windows: Install ffmpeg and add to PATH');
      return;
    }

    // Find and connect to camera
    const camera = await this.findCamera();
    if (camera) {
      this.camera = camera;
      logger.info(`[VisionService] Connected to camera: ${camera.name}`);
    } else {
      logger.warn('[VisionService] No suitable camera found');
    }
  }

  private async initializeAudioCapture(): Promise<void> {
    const enableMicrophone = this.runtime.getSetting('ENABLE_MICROPHONE') === 'true';
    const useStreamingAudio = this.runtime.getSetting('USE_STREAMING_AUDIO') === 'true';

    if (!enableMicrophone) {
      logger.info('[VisionService] Microphone capture disabled');
      return;
    }

    try {
      if (useStreamingAudio) {
        // Use new streaming audio with VAD
        const streamingConfig: StreamingAudioConfig = {
          enabled: true,
          sampleRate: 16000,
          channels: 1,
          vadThreshold: Number(this.runtime.getSetting('VAD_THRESHOLD')) || 0.01,
          silenceTimeout: Number(this.runtime.getSetting('SILENCE_TIMEOUT')) || 1500,
          responseDelay: Number(this.runtime.getSetting('RESPONSE_DELAY')) || 3000,
        };

        this.streamingAudioCapture = new StreamingAudioCaptureService(
          this.runtime,
          streamingConfig
        );

        // Set up event listeners
        this.streamingAudioCapture.on('speechStart', () => {
          logger.info('[VisionService] User started speaking');
        });

        this.streamingAudioCapture.on('speechEnd', () => {
          logger.info('[VisionService] User stopped speaking');
        });

        this.streamingAudioCapture.on(
          'transcription',
          (data: { text: string; isFinal: boolean }) => {
            logger.info(
              `[VisionService] Transcription (${data.isFinal ? 'final' : 'partial'}): ${data.text}`
            );
          }
        );

        this.streamingAudioCapture.on('utteranceComplete', async (text: string) => {
          logger.info('[VisionService] Processing complete utterance:', text);
          // Store the transcription in memory for context
          await this.storeAudioTranscription(text);
        });

        await this.streamingAudioCapture.initialize();
        logger.info('[VisionService] Streaming audio capture initialized with VAD');
      } else {
        // Use original batch audio capture
        const audioConfig: AudioConfig = {
          enabled: true,
          transcriptionInterval: Number(this.runtime.getSetting('TRANSCRIPTION_INTERVAL')) || 30000,
        };

        this.audioCapture = new AudioCaptureService(this.runtime, audioConfig);
        await this.audioCapture.initialize();
        logger.info('[VisionService] Batch audio capture initialized');
      }
    } catch (error) {
      logger.error('[VisionService] Failed to initialize audio capture:', error);
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
      logger.debug('[VisionService] Stored audio transcription in scene context');
    } catch (error) {
      logger.error('[VisionService] Failed to store audio transcription:', error);
    }
  }

  private startProcessing(): void {
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
          logger.error('[VisionService] Frame processing error:', error);
        }
        this.isProcessing = false;
      }
    }, this.visionConfig.updateInterval || 100);

    logger.debug('[VisionService] Started frame processing loop');
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
        logger.debug('[VisionService] Camera returned empty frame, skipping');
        return;
      }

      // Convert to standardized format
      const frame = await this.processFrameData(frameData);

      // Validate frame before processing
      if (!frame || frame.width === 0 || frame.height === 0) {
        logger.warn('[VisionService] Invalid frame dimensions, skipping');
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
      logger.error('[VisionService] Error capturing frame:', error);
    }
  }

  private async processFrameData(data: Buffer): Promise<VisionFrame> {
    // Validate input data
    if (!data || data.length === 0) {
      throw new Error('Empty frame data received from camera');
    }

    // Use sharp to ensure consistent format
    const image = sharp(data);
    const metadata = await image.metadata();

    // Validate metadata
    if (!metadata.width || !metadata.height || metadata.width === 0 || metadata.height === 0) {
      throw new Error(`Invalid image dimensions: ${metadata.width}x${metadata.height}`);
    }

    const rgbaBuffer = await image.ensureAlpha().raw().toBuffer();

    return {
      timestamp: Date.now(),
      width: metadata.width,
      height: metadata.height,
      data: rgbaBuffer,
      format: 'rgba',
    };
  }

  private async calculatePixelChange(frame1: VisionFrame, frame2: VisionFrame): Promise<number> {
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
    changePercentage: number
  ): Promise<void> {
    try {
      const currentTime = Date.now();

      // Convert frame to base64 for VLM
      const jpegBuffer = await sharp(frame.data, {
        raw: {
          width: frame.width,
          height: frame.height,
          channels: 4,
        },
      })
        .jpeg()
        .toBuffer();

      const base64Image = jpegBuffer.toString('base64');
      const imageUrl = `data:image/jpeg;base64,${base64Image}`;

      // Determine if we should update VLM description
      const timeSinceVlmUpdate = currentTime - this.lastVlmUpdateTime;
      const shouldUpdateVlm =
        timeSinceVlmUpdate >= this.visionConfig.vlmUpdateInterval! || // Time threshold
        changePercentage >= this.visionConfig.vlmChangeThreshold!; // Change threshold

      let description = this.lastTfDescription;

      if (shouldUpdateVlm) {
        // Use VLM to describe the scene
        description = await this.describeSceneWithVLM(imageUrl);
        this.lastVlmUpdateTime = currentTime;
        this.lastTfDescription = description;
        logger.debug(
          `[VisionService] VLM updated: ${timeSinceVlmUpdate}ms since last update, ${changePercentage.toFixed(1)}% change`
        );
      }

      // Determine if we should update TensorFlow detections
      const timeSinceTfUpdate = currentTime - this.lastTfUpdateTime;
      const shouldUpdateTf =
        timeSinceTfUpdate >= this.visionConfig.tfUpdateInterval! || // Time threshold
        changePercentage >= this.visionConfig.tfChangeThreshold!; // Change threshold

      let detectedObjects: DetectedObject[] = [];
      let people: PersonInfo[] = [];

      if (
        shouldUpdateTf &&
        (this.visionConfig.enableObjectDetection || this.visionConfig.enablePoseDetection)
      ) {
        this.lastTfUpdateTime = currentTime;
        logger.debug(
          `[VisionService] TF updating: ${timeSinceTfUpdate}ms since last update, ${changePercentage.toFixed(1)}% change`
        );

        // Use advanced computer vision if enabled
        if (this.visionConfig.enableObjectDetection) {
          if (this.visionModels.hasObjectDetection()) {
            detectedObjects = await this.visionModels.detectObjects(
              frame.data,
              frame.width,
              frame.height
            );
            logger.debug(`[VisionService] VisionModels detected ${detectedObjects.length} objects`);
          }
        }

        if (this.visionConfig.enablePoseDetection) {
          if (this.visionModels.hasPoseDetection()) {
            const poses = await this.visionModels.detectPoses(
              frame.data,
              frame.width,
              frame.height
            );
            people = poses;
            logger.debug(
              `[VisionService] VisionModels detected ${people.length} people with poses`
            );
          }
        }

        // If no people detected via pose but objects detected, check for person objects
        if (people.length === 0 && detectedObjects.length > 0) {
          const personObjects = detectedObjects.filter((obj) => obj.type === 'person');
          people = personObjects.map((obj) => ({
            id: `person-${obj.id}`,
            pose: 'unknown' as const,
            facing: 'unknown' as const,
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
      const enableFaceRecognition = this.runtime.getSetting('ENABLE_FACE_RECOGNITION') === 'true';

      if (enableFaceRecognition && people.length > 0 && frame.width > 0 && frame.height > 0) {
        try {
          // Validate frame data
          if (!frame.data || frame.data.length === 0) {
            logger.warn('[VisionService] Invalid frame data for face recognition');
            return;
          }

          // Detect faces in the frame
          const faces = await this.faceRecognition.detectFaces(
            frame.data,
            frame.width,
            frame.height
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
                const match = await this.faceRecognition.recognizeFace(face.descriptor);
                let profileId: string;

                if (match) {
                  profileId = match.profileId;
                  logger.debug(
                    `[VisionService] Recognized face: ${profileId} (distance: ${match.distance})`
                  );
                } else {
                  // Register new face
                  profileId = await this.faceRecognition.addOrUpdateFace(face.descriptor, {
                    attributes: {
                      age: face.ageGender?.age.toString(),
                      gender: face.ageGender?.gender,
                      emotion: face.expressions
                        ? this.getDominantExpression(face.expressions)
                        : undefined,
                    },
                  });
                  logger.info(`[VisionService] New face registered: ${profileId}`);
                }

                faceProfiles.set(person.id, profileId);
                break;
              }
            }
          }
        } catch (faceError) {
          logger.error('[VisionService] Face recognition error:', faceError);
        }
      }

      // Update entity tracker
      const _trackedEntities = await this.entityTracker.updateEntities(
        detectedObjects,
        people,
        faceProfiles,
        this.runtime
      );

      // Create scene description
      this.lastSceneDescription = {
        timestamp: frame.timestamp,
        description,
        objects: detectedObjects,
        people,
        sceneChanged: shouldUpdateVlm || shouldUpdateTf,
        changePercentage,
      };

      // Enhanced logging
      if (shouldUpdateVlm || shouldUpdateTf) {
        logger.info('[VisionService] Scene Analysis Complete:');
        logger.info(`  VLM Description: ${description.substring(0, 100)}...`);
        logger.info(`  Change: ${changePercentage.toFixed(1)}%`);
        logger.info(
          `  Updates: ${shouldUpdateVlm ? 'VLM' : ''}${shouldUpdateVlm && shouldUpdateTf ? ' + ' : ''}${shouldUpdateTf ? 'TF' : ''}`
        );
        logger.info(
          `  Detection Mode: ${this.visionConfig.enableObjectDetection ? 'Advanced CV' : 'Motion-based'}`
        );

        if (detectedObjects.length > 0) {
          logger.info(`  Objects: ${detectedObjects.length} detected`);

          // Group objects by type for summary
          const objectSummary = detectedObjects.reduce(
            (acc, obj) => {
              acc[obj.type] = (acc[obj.type] || 0) + 1;
              return acc;
            },
            {} as Record<string, number>
          );

          for (const [type, count] of Object.entries(objectSummary)) {
            logger.info(`    - ${count} ${type}(s)`);
          }
        }

        if (people.length > 0) {
          logger.info(`  People: ${people.length} detected`);
          for (const person of people) {
            logger.info(
              `    - Person: ${person.pose} pose, facing ${person.facing}, confidence: ${person.confidence.toFixed(2)}`
            );
          }
        }
      }
    } catch (error) {
      logger.error('[VisionService] Failed to update scene description:', error);
    }
  }

  private async describeSceneWithVLM(imageUrl: string): Promise<string> {
    try {
      // Convert base64 image URL to buffer for Florence-2
      if (imageUrl.startsWith('data:image/')) {
        const base64Data = imageUrl.split(',')[1];
        const imageBuffer = Buffer.from(base64Data, 'base64');

        // Use Florence-2 for all image descriptions
        if (this.florence2.isInitialized()) {
          try {
            const result = await this.florence2.analyzeImage(imageBuffer);
            if (result.caption) {
              logger.debug('[VisionService] Florence-2 description:', result.caption);
              return result.caption;
            }
          } catch (florenceError) {
            logger.warn('[VisionService] Florence-2 analysis failed, falling back:', florenceError);
          }
        }
      }

      // Fallback to runtime model if Florence-2 is not available
      try {
        const result = await this.runtime.useModel(ModelType.IMAGE_DESCRIPTION, imageUrl);

        if (result && typeof result === 'object' && 'description' in result) {
          const description = (result as any).description as string;
          // Check if we got the unhelpful default response
          if (
            !description.includes("I'm unable to analyze images") &&
            !description.includes("I can't analyze images")
          ) {
            return description;
          }
        } else if (typeof result === 'string') {
          const stringResult = result as string;
          if (
            stringResult.length > 0 &&
            !stringResult.includes("I'm unable to analyze images") &&
            !stringResult.includes("I can't analyze images")
          ) {
            return stringResult;
          }
        }
      } catch (modelError) {
        logger.warn('[VisionService] Runtime IMAGE_DESCRIPTION model failed:', modelError);
      }

      // If we got the unhelpful response or an error, provide a basic description based on detected objects
      if (this.lastSceneDescription) {
        const { objects, people } = this.lastSceneDescription;
        let description = 'Scene contains';

        if (people.length > 0) {
          description += ` ${people.length} person${people.length > 1 ? 's' : ''}`;
          const poses = people.map((p) => p.pose).filter((p) => p !== 'unknown');
          if (poses.length > 0) {
            description += ` (${poses.join(', ')})`;
          }
        }

        if (objects.length > 0 && people.length > 0) {
          description += ' and';
        }

        if (objects.length > 0) {
          const objectTypes = [...new Set(objects.map((o) => o.type))];
          description += ` ${objectTypes.join(', ')}`;
        }

        if (people.length === 0 && objects.length === 0) {
          description = 'Scene appears to be empty or static';
        }

        return description;
      }

      // Final fallback
      return 'Visual scene captured';
    } catch (error) {
      logger.error('[VisionService] VLM description failed:', error);
      return 'Unable to describe scene';
    }
  }

  private async detectMotionObjects(frame: VisionFrame): Promise<DetectedObject[]> {
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

              const diff = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
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
            type: 'motion-object',
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
              Math.abs(clusterObj.boundingBox.x - other.boundingBox.x) <= mergeDistance &&
              Math.abs(clusterObj.boundingBox.y - other.boundingBox.y) <= mergeDistance;

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
        const maxX = Math.max(...cluster.map((o) => o.boundingBox.x + o.boundingBox.width));
        const maxY = Math.max(...cluster.map((o) => o.boundingBox.y + o.boundingBox.height));
        const avgConfidence = cluster.reduce((sum, o) => sum + o.confidence, 0) / cluster.length;

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
      return 'person-candidate';
    } else if (area > 20000) {
      return 'large-object';
    } else if (area > 8000) {
      return 'medium-object';
    } else {
      return 'small-object';
    }
  }

  private async detectPeopleFromMotion(
    frame: VisionFrame,
    objects: DetectedObject[]
  ): Promise<PersonInfo[]> {
    const people: PersonInfo[] = [];
    const personCandidates = objects.filter((o) => o.type === 'person-candidate');

    for (let i = 0; i < personCandidates.length; i++) {
      const candidate = personCandidates[i];
      const box = candidate.boundingBox;

      // Simple heuristic: if height > width * 1.5, likely standing
      // if width > height, likely sitting/lying
      const aspectRatio = box.width / box.height;
      let pose: 'standing' | 'sitting' | 'lying' | 'unknown' = 'unknown';

      if (aspectRatio < 0.6) {
        pose = 'standing';
      } else if (aspectRatio > 1.2) {
        pose = 'lying';
      } else {
        pose = 'sitting';
      }

      // Estimate facing based on motion direction (simplified)
      let facing: 'camera' | 'away' | 'left' | 'right' | 'unknown' = 'unknown';
      if (this.lastFrame) {
        // In Phase 1, we'll just use 'unknown' or random assignment
        // Phase 2 will implement proper pose detection
        facing = 'camera'; // Default assumption
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
          logger.error('[VisionService] Screen processing error:', error);
        }
        this.isProcessingScreen = false;
      }
    }, this.visionConfig.screenCaptureInterval || 2000);

    logger.debug('[VisionService] Started screen processing loop');
  }

  private async captureAndProcessScreen(): Promise<void> {
    try {
      // Capture screen
      const capture = await this.screenCapture.captureScreen();
      this.lastScreenCapture = capture;

      // Process active tile
      const activeTile = this.screenCapture.getActiveTile();
      if (activeTile && activeTile.data) {
        const tileAnalysis = await this.analyzeTile(activeTile);
        activeTile.analysis = tileAnalysis;
      }

      // Update enhanced scene description
      await this.updateEnhancedSceneDescription();
    } catch (error) {
      logger.error('[VisionService] Error capturing screen:', error);
    }
  }

  private async analyzeTile(tile: any): Promise<TileAnalysis> {
    const analysis: TileAnalysis = {
      timestamp: Date.now(),
    };

    try {
      // Run Florence-2 analysis if enabled
      if (this.visionConfig.florence2Enabled && tile.data) {
        analysis.florence2 = await this.florence2.analyzeTile(tile);
        analysis.summary = analysis.florence2.caption;
      }

      // Run OCR if enabled
      if (this.visionConfig.ocrEnabled && tile.data) {
        analysis.ocr = await this.ocrService.extractFromTile(tile);
        analysis.text = analysis.ocr.fullText;
      }

      // Extract objects from Florence-2 results
      if (analysis.florence2?.objects) {
        analysis.objects = analysis.florence2.objects.map((obj) => ({
          id: `screen-obj-${Date.now()}-${Math.random()}`,
          type: obj.label,
          confidence: obj.confidence,
          boundingBox: obj.bbox,
        }));
      }
    } catch (error) {
      logger.error('[VisionService] Error analyzing tile:', error);
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
        description: '',
        objects: [],
        people: [],
        sceneChanged: false,
        changePercentage: 0,
      }),
      screenCapture: this.lastScreenCapture,
      screenAnalysis: {
        fullScreenOCR: '',
        activeTile: this.screenCapture.getActiveTile()?.analysis,
        gridSummary: '',
        focusedApp: '',
        uiElements: [],
      },
    };

    // Aggregate OCR from all processed tiles
    const processedTiles = this.lastScreenCapture.tiles.filter((t) => t.analysis?.ocr);
    if (processedTiles.length > 0) {
      enhancedScene.screenAnalysis!.fullScreenOCR = processedTiles
        .map((t) => t.analysis!.ocr!.fullText)
        .join('\n');
    }

    // Generate grid summary
    if (this.lastScreenCapture.tiles.length > 0) {
      const tilesWithContent = this.lastScreenCapture.tiles.filter((t) => t.analysis);
      enhancedScene.screenAnalysis!.gridSummary = `Screen divided into ${this.lastScreenCapture.tiles.length} tiles, ${tilesWithContent.length} analyzed`;
    }

    // Detect focused application (heuristic based on UI elements)
    if (enhancedScene.screenAnalysis!.activeTile?.florence2?.objects) {
      const windows = enhancedScene.screenAnalysis!.activeTile.florence2.objects.filter(
        (obj) => obj.label === 'window'
      );
      if (windows.length > 0) {
        enhancedScene.screenAnalysis!.focusedApp = 'Desktop Application';
      }
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

  public async setVisionMode(mode: VisionMode): Promise<void> {
    logger.info(
      `[VisionService] Changing vision mode from ${this.visionConfig.visionMode} to ${mode}`
    );

    // Stop current processing
    this.stopProcessing();

    // Update configuration
    this.visionConfig.visionMode = mode;

    // Reinitialize based on new mode
    if (mode === VisionMode.OFF) {
      logger.info('[VisionService] Vision disabled');
      return;
    }

    // Initialize components for new mode
    if ((mode === VisionMode.CAMERA || mode === VisionMode.BOTH) && !this.camera) {
      await this.initializeCameraVision();
    }

    if (
      (mode === VisionMode.SCREEN || mode === VisionMode.BOTH) &&
      (!this.florence2.isInitialized() || !this.ocrService.isInitialized())
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

  private getDominantExpression(expressions: any): string {
    let maxValue = 0;
    let dominantExpression = 'neutral';

    for (const [expression, value] of Object.entries(expressions)) {
      if (typeof value === 'number' && value > maxValue) {
        maxValue = value;
        dominantExpression = expression;
      }
    }

    return dominantExpression;
  }

  // Public methods for entity tracking
  public getEntityTracker(): EntityTracker {
    return this.entityTracker;
  }

  public getFaceRecognition(): FaceRecognition {
    return this.faceRecognition;
  }

  async stop(): Promise<void> {
    logger.info('[VisionService] Stopping vision service...');

    this.stopProcessing();

    if (this.audioCapture) {
      await this.audioCapture.stop();
      this.audioCapture = null;
    }

    if (this.streamingAudioCapture) {
      await this.streamingAudioCapture.stop();
      this.streamingAudioCapture = null;
    }

    if (this.visionModels) {
      await this.visionModels.dispose();
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
    this.isProcessing = false;
    this.isProcessingScreen = false;

    // Dispose of models
    await this.florence2.dispose();
    await this.ocrService.dispose();

    logger.info('[VisionService] Stopped.');
  }

  private async findCamera(): Promise<CameraDevice | null> {
    try {
      // Get list of available cameras
      const cameras = await this.listCameras();

      if (cameras.length === 0) {
        logger.warn('[VisionService] No cameras detected');
        return null;
      }

      // If camera name is specified, try to find it
      if (this.visionConfig.cameraName) {
        const searchName = this.visionConfig.cameraName.toLowerCase();
        const matchedCamera = cameras.find((cam) => cam.name.toLowerCase().includes(searchName));

        if (matchedCamera) {
          return this.createCameraDevice(matchedCamera);
        }

        logger.warn(
          `[VisionService] Camera "${this.visionConfig.cameraName}" not found, using default`
        );
      }

      // Use first available camera
      return this.createCameraDevice(cameras[0]);
    } catch (error) {
      logger.error('[VisionService] Error finding camera:', error);
      return null;
    }
  }

  private async listCameras(): Promise<CameraInfo[]> {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        // macOS: Use system_profiler
        const { stdout } = await execAsync('system_profiler SPCameraDataType -json');
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
      } else if (platform === 'linux') {
        // Linux: Use v4l2
        const { stdout } = await execAsync('v4l2-ctl --list-devices');
        const cameras: CameraInfo[] = [];
        const lines = stdout.split('\n');

        let currentName = '';
        for (const line of lines) {
          if (line && !line.startsWith('\t')) {
            currentName = line.replace(':', '').trim();
          } else if (line.trim().startsWith('/dev/video')) {
            const devicePath = line.trim();
            const id = devicePath.replace('/dev/video', '');
            cameras.push({
              id,
              name: currentName,
              connected: true,
            });
          }
        }

        return cameras;
      } else if (platform === 'win32') {
        // Windows: Use PowerShell
        const { stdout } = await execAsync(
          'powershell -Command "Get-PnpDevice -Class Camera | Select-Object FriendlyName, InstanceId | ConvertTo-Json"'
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
      logger.error('[VisionService] Error listing cameras:', error);
      return [];
    }
  }

  private createCameraDevice(info: CameraInfo): CameraDevice {
    const platform = process.platform;

    return {
      id: info.id,
      name: info.name,
      capture: async () => {
        const tempFile = path.join(process.cwd(), `temp_capture_${Date.now()}.jpg`);

        try {
          if (platform === 'darwin') {
            // macOS: Use imagesnap
            try {
              await execAsync(`imagesnap -d "${info.name}" "${tempFile}"`);
            } catch (error: any) {
              if (error.message.includes('command not found')) {
                throw new Error('imagesnap not installed. Run: brew install imagesnap');
              }
              throw error;
            }
          } else if (platform === 'linux') {
            // Linux: Use fswebcam
            try {
              await execAsync(
                `fswebcam -d /dev/video${info.id} -r 1280x720 --jpeg 85 "${tempFile}"`
              );
            } catch (error: any) {
              if (error.message.includes('command not found')) {
                throw new Error('fswebcam not installed. Run: sudo apt-get install fswebcam');
              }
              throw error;
            }
          } else if (platform === 'win32') {
            // Windows: Use DirectShow via ffmpeg
            try {
              await execAsync(
                `ffmpeg -f dshow -i video="${info.name}" -frames:v 1 -q:v 2 "${tempFile}" -y`
              );
            } catch (error: any) {
              if (error.message.includes('not recognized') || error.message.includes('not found')) {
                throw new Error('ffmpeg not installed. Download from ffmpeg.org and add to PATH');
              }
              throw error;
            }
          } else {
            throw new Error(`Unsupported platform: ${platform}`);
          }

          // Read the captured image
          const imageBuffer = await fs.readFile(tempFile);

          // Clean up temp file
          await fs.unlink(tempFile).catch(() => {});

          return imageBuffer;
        } catch (error) {
          // Clean up temp file on error
          await fs.unlink(tempFile).catch(() => {});
          throw error;
        }
      },
    };
  }

  public async captureImage(): Promise<Buffer | null> {
    if (!this.camera) {
      logger.warn('[VisionService] No camera available for capture');
      return null;
    }

    try {
      return await this.camera.capture();
    } catch (error) {
      logger.error('[VisionService] Failed to capture image:', error);
      return null;
    }
  }
}
