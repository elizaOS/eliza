import {
  type Action,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  elizaLogger,
} from '@elizaos/core';
import { type TrainingServiceInterface } from '../types.js';
import { type TrainingService } from '../services/training-service.js';

/**
 * Action to monitor RLAIF training progress
 */
export const monitorTrainingAction: Action = {
  name: 'MONITOR_TRAINING',
  similes: ['CHECK_TRAINING', 'TRAINING_STATUS', 'TRAINING_PROGRESS', 'GET_TRAINING_STATUS'],
  description:
    'Monitor the progress and status of RLAIF training jobs. Can be chained with START_TRAINING to initiate training or CHECK_TRAINING_STATUS for job status updates.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Check if training service is available
    const trainingService = runtime.getService<TrainingServiceInterface>('training');
    if (!trainingService) {
      elizaLogger.warn('Training service not available');
      return false;
    }

    // Check if message contains monitoring request
    const text = message.content.text?.toLowerCase();
    if (!text) {
      return false;
    }

    const monitoringKeywords = [
      'monitor training',
      'check training',
      'training status',
      'training progress',
      'how is training',
      'training update',
      'check progress',
      'training metrics',
      'training job status',
    ];

    return monitoringKeywords.some((keyword) => text.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    elizaLogger.info('Executing MONITOR_TRAINING action');

    try {
      const trainingService = runtime.getService<TrainingService>('training');
      if (!trainingService) {
        throw new Error('Training service not available');
      }

      // Extract job ID from message or state
      const jobId = extractJobId(message, state);

      if (!jobId) {
        await callback?.({
          text: 'Please specify which training job to monitor. You can say "monitor training [job-id]" or I can show you all active jobs.',
          thought: 'Need job ID to monitor specific training',
          actions: ['MONITOR_TRAINING'],
        });

        // Show all active jobs if no specific job ID
        const stats = await trainingService.getTrainingStats();

        await callback?.({
          text: `📊 **Training Overview**

**Dataset Statistics:**
- Total Conversations: ${stats.totalConversations}
- Total Messages: ${stats.totalMessages}
- Average Quality: ${stats.qualityMetrics.averageQuality.toFixed(2)}

To monitor a specific training job, use: \`monitor training [job-id]\``,
          thought: 'Showing general training statistics',
          actions: ['MONITOR_TRAINING'],
        });

        return {
          text: 'General training statistics provided',
          data: {
            actionName: 'MONITOR_TRAINING',
            stats,
            showedOverview: true,
          },
          values: {
            success: true,
            datasetStats: stats,
          },
        };
      }

      await callback?.({
        text: `Checking status of training job: ${jobId}...`,
        thought: 'Retrieving training job status and metrics',
        actions: ['MONITOR_TRAINING'],
      });

      // Get training job status
      const trainingJob = await trainingService.monitorTraining(jobId);

      if (!trainingJob) {
        await callback?.({
          text: `❌ Training job ${jobId} not found. Please check the job ID.`,
          thought: 'Training job not found',
          actions: ['MONITOR_TRAINING'],
        });

        return {
          text: `Training job ${jobId} not found`,
          data: {
            actionName: 'MONITOR_TRAINING',
            jobId,
            error: 'job_not_found',
          },
          values: {
            success: false,
            error: 'job_not_found',
            jobId,
          },
        };
      }

      // Format status display
      const statusEmoji = getStatusEmoji(trainingJob.status);
      const duration = getDuration(trainingJob.startTime, trainingJob.endTime);
      const progressText = formatProgress(trainingJob.progress);
      const metricsText = formatMetrics(trainingJob.metrics);

      const responseText = `${statusEmoji} **Training Job Status: ${jobId}**

**Status:** ${trainingJob.status.toUpperCase()}
**Duration:** ${duration}
${trainingJob.startTime ? `**Started:** ${trainingJob.startTime.toISOString()}` : ''}
${trainingJob.endTime ? `**Ended:** ${trainingJob.endTime.toISOString()}` : ''}

${progressText}

${metricsText}

${trainingJob.artifacts ? formatArtifacts(trainingJob.artifacts) : ''}

${trainingJob.error ? `**Error:** ${trainingJob.error}` : ''}

${getStatusAdvice(trainingJob.status)}`;

      await callback?.({
        text: responseText,
        thought: 'Successfully retrieved training job status and metrics',
        actions: ['MONITOR_TRAINING'],
      });

      return {
        text: `Training job ${jobId} status: ${trainingJob.status}`,
        data: {
          actionName: 'MONITOR_TRAINING',
          trainingJob,
          jobId,
          duration,
          progressText,
          metricsText,
        },
        values: {
          success: true,
          trainingJobId: jobId,
          trainingStatus: trainingJob.status,
          progress: trainingJob.progress,
          metrics: trainingJob.metrics,
          isCompleted: trainingJob.status === 'completed',
          isFailed: trainingJob.status === 'failed',
        },
      };
    } catch (error) {
      elizaLogger.error('Error in MONITOR_TRAINING action:', error);

      await callback?.({
        text: `❌ Error monitoring training: ${error instanceof Error ? error.message : String(error)}

This could happen if:
- The training job ID is incorrect
- The Atropos bridge is not running
- The training service is unavailable`,
        thought: 'Training monitoring failed',
        actions: ['MONITOR_TRAINING'],
      });

      return {
        text: `Failed to monitor training: ${error instanceof Error ? error.message : String(error)}`,
        data: {
          actionName: 'MONITOR_TRAINING',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        values: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },

  examples: [
    // Multi-action: Start training then monitor
    [
      {
        name: 'User',
        content: {
          text: 'Start training with my dataset and monitor the progress',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll start the training process and monitor its progress.",
          thought: 'User wants to start training and monitor it',
          actions: ['START_TRAINING', 'MONITOR_TRAINING'],
        },
      },
    ],
    // Multi-action: Check status then monitor if running
    [
      {
        name: 'User',
        content: {
          text: 'Check my training status and monitor if any jobs are running',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll check your training status and monitor any active jobs.",
          thought: 'User wants conditional monitoring based on status',
          actions: ['CHECK_TRAINING_STATUS', 'MONITOR_TRAINING'],
        },
      },
    ],
    // Multi-action: Monitor then configure if complete
    [
      {
        name: 'User',
        content: {
          text: 'Monitor my training and configure auto-coder when it completes',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll monitor your training progress and configure auto-coder once it's complete.",
          thought: 'User wants monitoring followed by configuration',
          actions: ['MONITOR_TRAINING', 'CONFIGURE_AUTOCODER'],
        },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'Monitor training job training-1234567890',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll check the status and progress of training job training-1234567890.",
          thought: 'User wants to monitor specific training job',
          actions: ['MONITOR_TRAINING'],
        },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'How is the training going?',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: 'Let me check the current training progress and show you the latest metrics.',
          thought: 'User wants general training progress update',
          actions: ['MONITOR_TRAINING'],
        },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'Check training status and show me the loss curves',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll retrieve the training status and display the current loss metrics and progress curves.",
          thought: 'User wants detailed training metrics including loss curves',
          actions: ['MONITOR_TRAINING'],
        },
      },
    ],
  ],
};

/**
 * Extract job ID from message text or state
 */
function extractJobId(message: Memory, state?: State): string | null {
  const text = message.content.text || '';

  // Check state first
  if (state?.values?.trainingJobId) {
    return state.values.trainingJobId;
  }

  // Look for job ID patterns in message
  const jobIdPatterns = [
    /training[\\-\\s]+(training-[\\w\\-]+)/i,
    /job[\\-\\s]+([\\w\\-]+)/i,
    /(training-\\d{10,}-[\\w]+)/i,
  ];

  for (const pattern of jobIdPatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Get status emoji
 */
function getStatusEmoji(status: string): string {
  switch (status.toLowerCase()) {
    case 'pending':
      return '⏳';
    case 'running':
      return '🏃';
    case 'completed':
      return '✅';
    case 'failed':
      return '❌';
    case 'cancelled':
      return '🛑';
    default:
      return '❓';
  }
}

/**
 * Calculate duration
 */
function getDuration(startTime?: Date, endTime?: Date): string {
  if (!startTime) {
    return 'Not started';
  }

  const end = endTime || new Date();
  const diffMs = end.getTime() - startTime.getTime();

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format progress information
 */
function formatProgress(progress?: any): string {
  if (!progress) {
    return '';
  }

  const { currentStep = 0, totalSteps = 0, currentLoss = 0, bestLoss = 0, eta = 0 } = progress;

  if (totalSteps === 0) {
    return '';
  }

  const percentage = ((currentStep / totalSteps) * 100).toFixed(1);
  const progressBar = generateProgressBar(currentStep, totalSteps);
  const etaText = eta > 0 ? formatETA(eta) : 'Unknown';

  return `**Progress:** ${progressBar} ${percentage}% (${currentStep}/${totalSteps} steps)
**Current Loss:** ${currentLoss.toFixed(4)}
**Best Loss:** ${bestLoss.toFixed(4)}
**ETA:** ${etaText}`;
}

/**
 * Generate visual progress bar
 */
function generateProgressBar(current: number, total: number, length: number = 20): string {
  if (total === 0) {
    return '░'.repeat(length);
  }

  const filled = Math.round((current / total) * length);
  const empty = length - filled;

  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Format ETA
 */
function formatETA(etaSeconds: number): string {
  const hours = Math.floor(etaSeconds / 3600);
  const minutes = Math.floor((etaSeconds % 3600) / 60);
  const seconds = Math.floor(etaSeconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format training metrics
 */
function formatMetrics(metrics?: any): string {
  if (!metrics) {
    return '';
  }

  const { trainingLoss = [], validationLoss = [], accuracy = [], rewardScore = [] } = metrics;

  let text = '**Metrics:**\\n';

  if (trainingLoss.length > 0) {
    const latest = trainingLoss[trainingLoss.length - 1];
    const trend = getTrend(trainingLoss.slice(-5));
    text += `- Training Loss: ${latest.toFixed(4)} ${trend}\\n`;
  }

  if (validationLoss.length > 0) {
    const latest = validationLoss[validationLoss.length - 1];
    const trend = getTrend(validationLoss.slice(-5));
    text += `- Validation Loss: ${latest.toFixed(4)} ${trend}\\n`;
  }

  if (accuracy.length > 0) {
    const latest = accuracy[accuracy.length - 1];
    const trend = getTrend(accuracy.slice(-5));
    text += `- Accuracy: ${(latest * 100).toFixed(2)}% ${trend}\\n`;
  }

  if (rewardScore.length > 0) {
    const latest = rewardScore[rewardScore.length - 1];
    const trend = getTrend(rewardScore.slice(-5));
    text += `- Reward Score: ${latest.toFixed(3)} ${trend}\\n`;
  }

  return text;
}

/**
 * Get trend indicator
 */
function getTrend(values: number[]): string {
  if (values.length < 2) {
    return '';
  }

  const recent = values.slice(-3);
  const older = values.slice(0, -2);

  if (recent.length === 0 || older.length === 0) {
    return '';
  }

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

  if (recentAvg > olderAvg) {
    return '📈';
  }
  if (recentAvg < olderAvg) {
    return '📉';
  }
  return '➡️';
}

/**
 * Format artifacts information
 */
function formatArtifacts(artifacts: any): string {
  let text = '**Artifacts:**\\n';

  if (artifacts.modelPath) {
    text += `- Model: \`${artifacts.modelPath}\`\\n`;
  }

  if (artifacts.datasetPath) {
    text += `- Dataset: \`${artifacts.datasetPath}\`\\n`;
  }

  if (artifacts.logsPath) {
    text += `- Logs: \`${artifacts.logsPath}\`\\n`;
  }

  if (artifacts.checkpointPaths && artifacts.checkpointPaths.length > 0) {
    text += `- Checkpoints: ${artifacts.checkpointPaths.length} saved\\n`;
  }

  return text;
}

/**
 * Get status-specific advice
 */
function getStatusAdvice(status: string): string {
  switch (status.toLowerCase()) {
    case 'pending':
      return '💡 **Tip:** Training is queued. Check Atropos server status if it takes too long.';
    case 'running':
      return '💡 **Tip:** Training is active. Monitor loss curves for convergence signs.';
    case 'completed':
      return '🎉 **Success!** Training completed. Check the model artifacts and evaluation metrics.';
    case 'failed':
      return '🔧 **Troubleshooting:** Check logs for errors. Common issues: OOM, invalid data, or connectivity problems.';
    case 'cancelled':
      return '⚠️ **Note:** Training was cancelled. You can restart with the same configuration if needed.';
    default:
      return '';
  }
}
