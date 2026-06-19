// face-detector-mediapipe.ts — DEPRECATED.
//
// The previous implementation used `onnxruntime-node` to run BlazeFace. That
// backend is no longer shipped. This compatibility class reports unavailable
// and the runtime uses the configured face-recognition backend instead.
//
// Kept as a migration shim so existing imports (test fixtures) continue to
// compile without touching the test layout. The class is internal and not
// wired into the production `VisionService`.

import { logger } from "@elizaos/core";
import type { BoundingBox } from "./types";

export interface MediaPipeFaceConfig {
  modelUrl?: string;
  modelSha256?: string | null;
  modelDir?: string;
  scoreThreshold?: number;
  trusted?: boolean;
}

export interface MediaPipeFaceDetection {
  bbox: BoundingBox;
  confidence: number;
  keypoints?: Array<{ x: number; y: number }>;
}

export class MediaPipeFaceDetector {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: MediaPipeFaceConfig = {}) {
    /* config retained for API stability */
  }

  static async isAvailable(): Promise<boolean> {
    return false;
  }

  isInitialized(): boolean {
    return false;
  }

  async initialize(): Promise<void> {
    throw new Error(
      "[MediaPipeFace] ONNX backend removed in ggml migration; use the configured face-recognition backend instead.",
    );
  }

  async detect(_imageBuffer: Buffer): Promise<MediaPipeFaceDetection[]> {
    throw new Error(
      "[MediaPipeFace] ONNX backend removed in ggml migration; use the configured face-recognition backend instead.",
    );
  }

  async dispose(): Promise<void> {
    logger.debug("[MediaPipeFace] dispose (unavailable migration shim)");
  }
}
