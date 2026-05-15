// face-detector-mediapipe.ts — DEPRECATED.
//
// The previous implementation used `onnxruntime-node` to run BlazeFace. As
// part of the ggml runtime migration (see `VISION_RUNTIME_MIGRATION.md`),
// this alternate detector is being replaced by the RetinaFace ggml port in
// Phase 3. Until that port lands, this class throws on initialize() and the
// runtime falls through to the legacy `face-api.js` face library (also
// scheduled for removal in Phase 3).
//
// Kept as a stub so existing imports (test fixtures) continue to compile
// without touching the test layout. The class is internal and not wired
// into the production `VisionService`.

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
    // Always unavailable until the RetinaFace ggml port lands.
    return false;
  }

  isInitialized(): boolean {
    return false;
  }

  async initialize(): Promise<void> {
    throw new Error(
      "[MediaPipeFace] ONNX backend removed in ggml migration; RetinaFace ggml port not yet built — see VISION_RUNTIME_MIGRATION.md Phase 3.",
    );
  }

  async detect(_imageBuffer: Buffer): Promise<MediaPipeFaceDetection[]> {
    throw new Error(
      "[MediaPipeFace] migration in progress; no replacement available yet.",
    );
  }

  async dispose(): Promise<void> {
    logger.debug("[MediaPipeFace] dispose (no-op stub)");
  }
}
