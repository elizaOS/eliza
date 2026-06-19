// PersonDetector — dedicated person-detection model.
//
// Strategy:
//   - Default to a class-filtered YOLOv8n run ("person"-only). This is fast,
//     accurate, and reuses a single model file for both general object
//     detection and person detection.
//   - When the upstream agent needs pose data (keypoints), the existing
//     MoveNet implementation in `vision-models.ts` takes over.
//
// Returning `PersonInfo` rather than a generic detection makes this a drop-in
// replacement for the heuristic person detection in `service.ts`.

import { logger } from "@elizaos/core";
import type { PersonInfo } from "./types";
import { type YOLOConfig, YOLODetector } from "./yolo-detector";

export interface PersonDetectorConfig extends Omit<YOLOConfig, "classFilter"> {
  /** Score threshold specifically for person detections (defaults to 0.4). */
  scoreThreshold?: number;
}

export class PersonDetector {
  private yolo: YOLODetector;
  private initialized = false;

  constructor(config: PersonDetectorConfig = {}) {
    this.yolo = new YOLODetector({
      ...config,
      classFilter: ["person"],
      scoreThreshold: config.scoreThreshold ?? 0.4,
    });
  }

  static isAvailable(): Promise<boolean> {
    return YOLODetector.isAvailable();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.yolo.initialize();
    this.initialized = true;
    logger.info("[PersonDetector] initialized");
  }

  async detect(imageBuffer: Buffer): Promise<PersonInfo[]> {
    if (!this.initialized) await this.initialize();
    const objects = await this.yolo.detect(imageBuffer);
    return objects.map((obj, idx) => ({
      id: `person-${Date.now()}-${idx}`,
      // No pose data from YOLO alone — leave as "unknown" so the runtime
      // either skips pose-dependent UI or augments via MoveNet.
      pose: "unknown",
      facing: "unknown",
      confidence: obj.confidence,
      boundingBox: obj.boundingBox,
    }));
  }

  async dispose(): Promise<void> {
    await this.yolo.dispose();
    this.initialized = false;
  }
}
