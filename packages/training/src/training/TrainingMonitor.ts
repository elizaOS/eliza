/**
 * Training Monitor Service
 *
 * Tracks training job progress and updates database with status.
 * Monitors Python training process and W&B runs.
 */

import { getTrainingDataAdapter } from "../adapter";
import { logger } from "../utils/logger";

export type TrainingStatus =
  | "pending"
  | "preparing"
  | "scoring"
  | "training"
  | "uploading"
  | "completed"
  | "failed";

export interface TrainingProgress {
  batchId: string;
  status: TrainingStatus;
  progress: number; // 0-1
  currentEpoch?: number;
  totalEpochs?: number;
  currentStep?: number;
  totalSteps?: number;
  loss?: number;
  eta?: number; // milliseconds
  error?: string;
}

export class TrainingMonitor {
  /**
   * Start monitoring a training job
   */
  async startMonitoring(batchId: string): Promise<void> {
    const adapter = getTrainingDataAdapter();
    await adapter.updateBatchStatus(batchId, "training");

    logger.info(
      "Started monitoring training job",
      { batchId },
      "TrainingMonitor",
    );
  }

  /**
   * Update training progress
   */
  async updateProgress(
    batchId: string,
    progress: Partial<TrainingProgress>,
  ): Promise<void> {
    if (progress.status) {
      const adapter = getTrainingDataAdapter();
      const errorMsg =
        progress.status === "failed" ? progress.error : undefined;
      await adapter.updateBatchStatus(batchId, progress.status, errorMsg);
    }

    logger.info(
      "Updated training progress",
      {
        batchId,
        status: progress.status,
        progress: progress.progress,
      },
      "TrainingMonitor",
    );
  }

  /**
   * Get current progress for a job
   */
  async getProgress(batchId: string): Promise<TrainingProgress | null> {
    const adapter = getTrainingDataAdapter();
    const batch = await adapter.getBatchById(batchId);

    if (!batch) {
      return null;
    }

    // Calculate progress based on status
    let progress = 0;
    switch (batch.status) {
      case "pending":
        progress = 0;
        break;
      case "preparing":
        progress = 0.1;
        break;
      case "scoring":
        progress = 0.3;
        break;
      case "training":
        progress = 0.6;
        break;
      case "uploading":
        progress = 0.9;
        break;
      case "completed":
        progress = 1.0;
        break;
      case "failed":
        progress = 0;
        break;
    }

    // Estimate ETA based on average training time
    let eta: number | undefined;
    if (batch.status === "training" && batch.startedAt) {
      const avgTrainingTime = 2 * 60 * 60 * 1000; // 2 hours average
      const elapsed = Date.now() - batch.startedAt.getTime();
      eta = Math.max(0, avgTrainingTime - elapsed);
    }

    return {
      batchId,
      status: batch.status as TrainingStatus,
      progress,
      loss: batch.trainingLoss ?? undefined,
      eta,
      error: batch.error ?? undefined,
    };
  }

  /**
   * Check if training is stuck
   */
  async checkForStuckJobs(): Promise<string[]> {
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const adapter = getTrainingDataAdapter();
    const stuckJobs = await adapter.getStuckTrainingBatches(fourHoursMs);

    if (stuckJobs.length > 0) {
      logger.warn(
        "Found stuck training jobs",
        {
          count: stuckJobs.length,
          jobs: stuckJobs,
        },
        "TrainingMonitor",
      );
    }

    return stuckJobs;
  }

  /**
   * Cancel training job
   */
  async cancelJob(batchId: string, reason: string): Promise<void> {
    const adapter = getTrainingDataAdapter();
    await adapter.updateBatchStatus(batchId, "failed", `Cancelled: ${reason}`);

    logger.warn(
      "Training job cancelled",
      { batchId, reason },
      "TrainingMonitor",
    );
  }
}

// Singleton
export const trainingMonitor = new TrainingMonitor();
