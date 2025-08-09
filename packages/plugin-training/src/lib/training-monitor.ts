import { elizaLogger } from '@elizaos/core';
import { type TogetherAIClient } from './together-client.js';
import { bunExec } from '@elizaos/cli/src/utils/bun-exec.js';

export interface TrainingProgress {
  jobId: string;
  status: string;
  progress: number;
  epochs_completed: number;
  total_epochs: number;
  steps_completed: number;
  total_steps: number;
  current_loss?: number;
  estimated_time_remaining?: string;
  output_name?: string;
  created_at: string;
  updated_at: string;
}

export interface MonitoringOptions {
  pollInterval?: number; // seconds
  onProgress?: (progress: TrainingProgress) => void;
  onComplete?: (progress: TrainingProgress) => void;
  onError?: (error: Error) => void;
  verbose?: boolean;
}

/**
 * Live training monitor for Together.ai fine-tuning jobs
 */
export class TrainingMonitor {
  private client: TogetherAIClient;
  private isMonitoring = false;
  private monitoringInterval?: NodeJS.Timeout;

  constructor(apiKey: string) {
    this.client = new TogetherAIClient(apiKey);
  }

  /**
   * Start live monitoring of a training job
   */
  async startMonitoring(jobId: string, options: MonitoringOptions = {}): Promise<void> {
    const {
      pollInterval = 30, // 30 seconds default
      onProgress,
      onComplete,
      onError,
      verbose = true,
    } = options;

    if (this.isMonitoring) {
      throw new Error('Already monitoring a job. Stop current monitoring first.');
    }

    this.isMonitoring = true;
    let lastStatus = '';
    const startTime = Date.now();

    if (verbose) {
      elizaLogger.info(`🔍 Starting live monitoring for job ${jobId}`);
      elizaLogger.info(`📊 Polling every ${pollInterval} seconds...`);
      elizaLogger.info('─'.repeat(80));
    }

    const poll = async () => {
      try {
        const status = await this.getJobProgress(jobId);

        // Calculate elapsed time
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const elapsedFormatted = this.formatDuration(elapsed);

        // Show progress update if status changed or verbose mode
        if (status.status !== lastStatus || verbose) {
          this.displayProgress(status, elapsedFormatted);
          lastStatus = status.status;
        }

        // Call progress callback
        if (onProgress) {
          onProgress(status);
        }

        // Check if complete
        if (this.isJobComplete(status.status)) {
          this.stopMonitoring();

          if (verbose) {
            elizaLogger.info('\n🎉 Training completed!');
            this.displayFinalSummary(status, elapsedFormatted);
          }

          if (onComplete) {
            onComplete(status);
          }
          return;
        }

        // Check if failed
        if (this.isJobFailed(status.status)) {
          this.stopMonitoring();

          const error = new Error(`Training failed with status: ${status.status}`);

          if (verbose) {
            elizaLogger.info(`\n❌ Training failed: ${status.status}`);
          }

          if (onError) {
            onError(error);
          }
        }
      } catch (error) {
        if (verbose) {
          elizaLogger.error(
            `❌ Error checking status: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        if (onError) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };

    // Initial poll
    await poll();

    // Set up recurring polls
    this.monitoringInterval = setInterval(poll, pollInterval * 1000);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    this.isMonitoring = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
  }

  /**
   * Get current job progress from Together.ai CLI
   */
  private async getJobProgress(jobId: string): Promise<TrainingProgress> {
    // Validate jobId to prevent command injection
    if (!jobId || !/^[a-zA-Z0-9\-_]+$/.test(jobId)) {
      throw new Error('Invalid job ID format');
    }

    try {
      // Use bunExec to safely pass arguments
      const result = await bunExec(
        'together',
        ['fine-tuning', 'retrieve', jobId],
        {
          env: { TOGETHER_API_KEY: this.client['apiKey'] },
          timeout: 10000
        }
      );

      if (!result.success) {
        throw new Error(`Failed to retrieve job status: ${result.stderr}`);
      }

      let data;
      try {
        data = JSON.parse(result.stdout);
      } catch (parseError) {
        throw new Error(`Failed to parse job progress response: ${result.stdout}`);
      }

      // Calculate progress percentage with improved logic
      let progress = 0;
      if (data.total_steps > 0) {
        progress = Math.round((data.steps_completed / data.total_steps) * 100);
      } else if (data.status === 'completed') {
        progress = 100;
      } else if (data.status === 'running' && data.total_epochs > 0) {
        // Use epoch-based progress when total_steps is not available
        const epochProgress = Math.round((data.epochs_completed / data.total_epochs) * 100);
        progress = Math.min(95, epochProgress); // Cap at 95% to account for final processing
      } else if (data.status === 'running') {
        // Fallback for when neither total_steps nor total_epochs is available
        progress = 25; // Conservative estimate
      }

      return {
        jobId: data.id,
        status: data.status,
        progress,
        epochs_completed: data.epochs_completed || 0,
        total_epochs: data.n_epochs || 1,
        steps_completed: data.steps_completed || 0,
        total_steps: data.total_steps || 0,
        output_name: data.output_name,
        created_at: data.created_at,
        updated_at: data.updated_at,
      };
    } catch (error) {
      throw new Error(
        `Failed to get job progress: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Display progress in a nice format
   */
  private displayProgress(status: TrainingProgress, elapsed: string): void {
    const timestamp = new Date().toLocaleTimeString();
    const statusEmoji = this.getStatusEmoji(status.status);

    elizaLogger.info(`[${timestamp}] ${statusEmoji} Status: ${status.status.toUpperCase()}`);

    if (status.total_steps > 0) {
      const progressBar = this.createProgressBar(status.progress);
      elizaLogger.info(
        `📊 Progress: ${progressBar} ${status.progress}% (${status.steps_completed}/${status.total_steps} steps)`
      );
    }

    if (status.epochs_completed > 0) {
      elizaLogger.info(`📚 Epochs: ${status.epochs_completed}/${status.total_epochs}`);
    }

    elizaLogger.info(`⏱️  Elapsed: ${elapsed}`);

    if (status.output_name) {
      elizaLogger.info(`🎯 Output: ${status.output_name}`);
    }

    elizaLogger.info('─'.repeat(80));
  }

  /**
   * Display final summary
   */
  private displayFinalSummary(status: TrainingProgress, elapsed: string): void {
    elizaLogger.info('🎉 TRAINING COMPLETE!');
    elizaLogger.info('═'.repeat(80));
    elizaLogger.info(`📋 Job ID: ${status.jobId}`);
    elizaLogger.info(`🎯 Model: ${status.output_name || 'Unknown'}`);
    elizaLogger.info(`⏱️  Total Time: ${elapsed}`);
    elizaLogger.info(`📚 Epochs: ${status.epochs_completed}/${status.total_epochs}`);
    if (status.total_steps > 0) {
      elizaLogger.info(`📊 Steps: ${status.steps_completed}/${status.total_steps}`);
    }
    elizaLogger.info('═'.repeat(80));
    elizaLogger.info('💡 Next steps:');
    elizaLogger.info('  1. Test the fine-tuned model');
    elizaLogger.info('  2. Deploy for inference');
    elizaLogger.info('  3. Integrate with ElizaOS');
  }

  /**
   * Create a visual progress bar
   */
  private createProgressBar(progress: number, width = 20): string {
    const filled = Math.floor((progress / 100) * width);
    const empty = width - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }

  /**
   * Get emoji for status
   */
  private getStatusEmoji(status: string): string {
    switch (status.toLowerCase()) {
      case 'queued':
        return '⏳';
      case 'running':
        return '🚀';
      case 'completed':
        return '✅';
      case 'failed':
        return '❌';
      case 'cancelled':
        return '⚠️';
      default:
        return '📋';
    }
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * Check if job is complete
   */
  private isJobComplete(status: string): boolean {
    return status.toLowerCase() === 'completed';
  }

  /**
   * Check if job has failed
   */
  private isJobFailed(status: string): boolean {
    const failedStates = ['failed', 'cancelled', 'error'];
    return failedStates.includes(status.toLowerCase());
  }

  /**
   * Get monitoring status
   */
  isCurrentlyMonitoring(): boolean {
    return this.isMonitoring;
  }
}
