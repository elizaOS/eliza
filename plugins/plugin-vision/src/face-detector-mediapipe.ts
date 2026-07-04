/**
 * Compatibility face-detector surface for callers that still import the
 * MediaPipe-shaped BlazeFace types.
 *
 * The runtime uses the configured ggml face backend; this internal class reports
 * unavailable so stale imports keep compiling without becoming a production
 * detector path.
 */

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
