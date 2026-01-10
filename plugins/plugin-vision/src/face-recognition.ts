import * as faceapi from 'face-api.js';
import { logger } from '@elizaos/core';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { FaceProfile, FaceLibrary } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamic imports for optional dependencies
let Canvas: any, Image: any, ImageData: any;

async function initializeCanvas() {
  try {
    const canvas = await import('canvas');
    Canvas = canvas.Canvas;
    Image = canvas.Image;
    ImageData = canvas.ImageData;

    // Polyfill for face-api.js
    faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
  } catch (error) {
    logger.error('[FaceRecognition] Canvas module not available:', error);
    throw new Error(
      'Canvas module is required for face recognition. Install with: npm install canvas'
    );
  }
}

export class FaceRecognition {
  private initialized = false;
  private faceLibrary: FaceLibrary = {
    faces: new Map(),
    embeddings: new Map(),
  };
  private modelPath = path.join(__dirname, '..', 'models', 'face-api');

  // Thresholds
  private readonly FACE_MATCH_THRESHOLD = 0.6; // Euclidean distance threshold
  private readonly MIN_FACE_SIZE = 50; // Minimum face size in pixels

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      logger.info('[FaceRecognition] Loading face detection models...');

      // Initialize canvas first
      await initializeCanvas();

      // Load face-api.js models
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(this.modelPath);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(this.modelPath);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(this.modelPath);
      await faceapi.nets.faceExpressionNet.loadFromDisk(this.modelPath);
      await faceapi.nets.ageGenderNet.loadFromDisk(this.modelPath);

      this.initialized = true;
      logger.info('[FaceRecognition] Models loaded successfully');
    } catch (error) {
      logger.error('[FaceRecognition] Failed to load models:', error);
      logger.info(
        '[FaceRecognition] Download models from: https://github.com/justadudewhohacks/face-api.js-models'
      );
      throw error;
    }
  }

  async detectFaces(
    imageData: Buffer,
    width: number,
    height: number
  ): Promise<
    Array<{
      detection: faceapi.FaceDetection;
      landmarks: faceapi.FaceLandmarks68;
      descriptor: Float32Array;
      expressions: faceapi.FaceExpressions;
      ageGender?: { age: number; gender: string; genderProbability: number };
    }>
  > {
    if (!this.initialized) {
      await this.initialize();
    }

    // Validate input parameters
    if (!imageData || imageData.length === 0 || width <= 0 || height <= 0) {
      logger.warn('[FaceRecognition] Invalid input parameters:', {
        dataLength: imageData?.length || 0,
        width,
        height,
      });
      return [];
    }

    // Validate that the buffer size matches expected dimensions
    const expectedSize = width * height * 4; // RGBA
    if (imageData.length !== expectedSize) {
      logger.warn('[FaceRecognition] Buffer size mismatch:', {
        expected: expectedSize,
        actual: imageData.length,
        width,
        height,
      });
      return [];
    }

    try {
      // Create canvas from image data
      const canvas = new Canvas(width, height);
      const ctx = canvas.getContext('2d');
      const imageDataObj = new ImageData(new Uint8ClampedArray(imageData), width, height);
      ctx.putImageData(imageDataObj, 0, 0);

      // Detect faces with full analysis
      const detections = await faceapi
        .detectAllFaces(
          canvas as any,
          new faceapi.SsdMobilenetv1Options({
            minConfidence: 0.5,
            maxResults: 10,
          })
        )
        .withFaceLandmarks()
        .withFaceDescriptors()
        .withFaceExpressions()
        .withAgeAndGender();

      return detections.filter(
        (d: {
          detection: {
            box: {
              width: number;
              height: number;
            };
          };
        }) => {
          const box = d.detection.box;
          return box.width >= this.MIN_FACE_SIZE && box.height >= this.MIN_FACE_SIZE;
        }
      );
    } catch (error) {
      logger.error('[FaceRecognition] Face detection failed:', error);
      return [];
    }
  }

  async recognizeFace(
    descriptor: Float32Array
  ): Promise<{ profileId: string; distance: number } | null> {
    let bestMatch: { profileId: string; distance: number } | null = null;
    let minDistance = Infinity;

    // Compare with all known faces
    for (const [profileId, embeddings] of this.faceLibrary.embeddings) {
      for (const knownEmbedding of embeddings) {
        const distance = this.euclideanDistance(descriptor, knownEmbedding);

        if (distance < this.FACE_MATCH_THRESHOLD && distance < minDistance) {
          minDistance = distance;
          bestMatch = { profileId, distance };
        }
      }
    }

    return bestMatch;
  }

  async addOrUpdateFace(
    descriptor: Float32Array,
    attributes?: Partial<FaceProfile>
  ): Promise<string> {
    // Check if this face already exists
    const match = await this.recognizeFace(descriptor);

    if (match) {
      // Update existing profile
      const profile = this.faceLibrary.faces.get(match.profileId)!;
      profile.lastSeen = Date.now();
      profile.seenCount++;

      // Add new embedding for better recognition
      const embeddings = this.faceLibrary.embeddings.get(match.profileId)!;
      if (embeddings.length < 10) {
        // Keep up to 10 embeddings per person
        embeddings.push(Array.from(descriptor));
      }

      // Update attributes if provided
      if (attributes) {
        Object.assign(profile, attributes);
      }

      return match.profileId;
    } else {
      // Create new profile
      const profileId = `face-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const profile: FaceProfile = {
        id: profileId,
        embeddings: [Array.from(descriptor)],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        seenCount: 1,
        ...attributes,
      };

      this.faceLibrary.faces.set(profileId, profile);
      this.faceLibrary.embeddings.set(profileId, [Array.from(descriptor)]);

      logger.info(`[FaceRecognition] New face registered: ${profileId}`);
      return profileId;
    }
  }

  getFaceProfile(profileId: string): FaceProfile | undefined {
    return this.faceLibrary.faces.get(profileId);
  }

  getAllProfiles(): FaceProfile[] {
    return Array.from(this.faceLibrary.faces.values());
  }

  private euclideanDistance(a: Float32Array | number[], b: number[]): number {
    let sum = 0;
    const aArray = Array.from(a);
    for (let i = 0; i < aArray.length; i++) {
      sum += Math.pow(aArray[i] - b[i], 2);
    }
    return Math.sqrt(sum);
  }

  // Persistence methods
  async saveFaceLibrary(path: string): Promise<void> {
    const data = {
      faces: Array.from(this.faceLibrary.faces.entries()),
      embeddings: Array.from(this.faceLibrary.embeddings.entries()),
    };

    const fs = await import('fs/promises');
    await fs.writeFile(path, JSON.stringify(data, null, 2));
    logger.info(`[FaceRecognition] Face library saved to ${path}`);
  }

  async loadFaceLibrary(path: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const data = JSON.parse(await fs.readFile(path, 'utf-8'));

      this.faceLibrary.faces = new Map(data.faces);
      this.faceLibrary.embeddings = new Map(data.embeddings);

      logger.info(`[FaceRecognition] Loaded ${this.faceLibrary.faces.size} face profiles`);
    } catch (error) {
      logger.warn('[FaceRecognition] Could not load face library:', error);
    }
  }
}
