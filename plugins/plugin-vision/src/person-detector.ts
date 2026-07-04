/**
 * Person detector that adapts class-filtered YOLO detections into `PersonInfo`
 * records for the vision service.
 *
 * Pose keypoints are not produced here; callers combine this with heuristic or
 * future pose backends when they need orientation data.
 */

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
