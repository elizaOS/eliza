/**
 * Training Monitor Service
 *
 * Tracks training job progress and updates database with status.
 * Monitors Python training process and W&B runs.
 */

import { and, db, eq, lt, trainingBatches } from '@babylon/db';
import { logger } from '../utils/logger';

export type TrainingStatus =
  | 'pending'
  | 'preparing'
  | 'scoring'
  | 'training'
  | 'uploading'
  | 'completed'
  | 'failed';

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
    await db
      .update(trainingBatches)
      .set({
        status: 'training',
        startedAt: new Date(),
      })
      .where(eq(trainingBatches.batchId, batchId));

    logger.info(
      'Started monitoring training job',
      { batchId },
      'TrainingMonitor'
    );
  }

  /**
   * Update training progress
   */
  async updateProgress(
    batchId: string,
    progress: Partial<TrainingProgress>
  ): Promise<void> {
    interface UpdateData {
      status?: string;
      completedAt?: Date;
      trainingLoss?: number;
      error?: string;
    }

    const updates: UpdateData = {};

    if (progress.status) {
      updates.status = progress.status;
    }

    if (progress.status === 'completed') {
      updates.completedAt = new Date();
      updates.trainingLoss = progress.loss;
    }

    if (progress.status === 'failed') {
      updates.error = progress.error;
    }

    await db
      .update(trainingBatches)
      .set(updates)
      .where(eq(trainingBatches.batchId, batchId));

    logger.info(
      'Updated training progress',
      {
        batchId,
        status: progress.status,
        progress: progress.progress,
      },
      'TrainingMonitor'
    );
  }

  /**
   * Get current progress for a job
   */
  async getProgress(batchId: string): Promise<TrainingProgress | null> {
    const batchResult = await db
      .select()
      .from(trainingBatches)
      .where(eq(trainingBatches.batchId, batchId))
      .limit(1);

    const batch = batchResult[0];

    if (!batch) {
      return null;
    }

    // Calculate progress based on status
    let progress = 0;
    switch (batch.status) {
      case 'pending':
        progress = 0;
        break;
      case 'preparing':
        progress = 0.1;
        break;
      case 'scoring':
        progress = 0.3;
        break;
      case 'training':
        progress = 0.6;
        break;
      case 'uploading':
        progress = 0.9;
        break;
      case 'completed':
        progress = 1.0;
        break;
      case 'failed':
        progress = 0;
        break;
    }

    // Estimate ETA based on average training time
    let eta: number | undefined;
    if (batch.status === 'training' && batch.startedAt) {
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
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);

    const stuckJobs = await db
      .select({ batchId: trainingBatches.batchId })
      .from(trainingBatches)
      .where(
        and(
          eq(trainingBatches.status, 'training'),
          lt(trainingBatches.startedAt, fourHoursAgo)
        )
      );

    if (stuckJobs.length > 0) {
      logger.warn(
        'Found stuck training jobs',
        {
          count: stuckJobs.length,
          jobs: stuckJobs.map((j: (typeof stuckJobs)[number]) => j.batchId),
        },
        'TrainingMonitor'
      );
    }

    return stuckJobs.map((j: (typeof stuckJobs)[number]) => j.batchId);
  }

  /**
   * Cancel training job
   */
  async cancelJob(batchId: string, reason: string): Promise<void> {
    await db
      .update(trainingBatches)
      .set({
        status: 'failed',
        error: `Cancelled: ${reason}`,
        completedAt: new Date(),
      })
      .where(eq(trainingBatches.batchId, batchId));

    logger.warn(
      'Training job cancelled',
      { batchId, reason },
      'TrainingMonitor'
    );
  }
}

// Singleton
export const trainingMonitor = new TrainingMonitor();
