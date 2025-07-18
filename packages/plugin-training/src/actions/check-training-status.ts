/**
 * Check Training Status Action - Monitor Together.ai Fine-tuning Progress
 *
 * Monitors the status of fine-tuning jobs on Together.ai and provides
 * detailed progress information and completion notifications.
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';

interface JobStatus {
  status: string;
  data?: {
    epochs: number;
    tokens_trained: number;
    cost: number;
    training_time: number;
  };
  [key: string]: any;
}

export const checkTrainingStatusAction: Action = {
  name: 'CHECK_TRAINING_STATUS',
  similes: ['TRAINING_STATUS', 'CHECK_PROGRESS', 'MONITOR_TRAINING'],
  description: 'Check the status and progress of Together.ai fine-tuning jobs',

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || '';

    return (
      (text.includes('check') || text.includes('status') || text.includes('progress')) &&
      (text.includes('training') || text.includes('fine-tune') || text.includes('job'))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      elizaLogger.info('📊 Checking training status...');

      // Check for Together.ai API key
      const apiKey = runtime.getSetting('TOGETHER_API_KEY');
      if (!apiKey) {
        await callback?.({
          text: '❌ Together.ai API key not found. Please set TOGETHER_API_KEY in your environment to check training status.',
          thought: 'Missing Together.ai API key required for status checking',
          actions: ['CHECK_TRAINING_STATUS'],
        });
        return {
          text: 'Missing Together.ai API key',
          data: {
            actionName: 'CHECK_TRAINING_STATUS',
            error: 'missing_api_key',
          },
          values: {
            success: false,
            error: 'missing_api_key',
          },
        };
      }

      // Extract job ID from message or get recent jobs
      const jobId = extractJobId(message);

      if (jobId) {
        await callback?.({
          text: `🔍 Checking status for training job: ${jobId}...`,
          thought: 'Checking specific training job status',
          actions: ['CHECK_TRAINING_STATUS'],
        });

        const jobStatus = await getJobStatus(apiKey, jobId);
        const statusReport = formatJobStatus(jobStatus);

        await callback?.({
          text: statusReport,
          thought: `Training job ${jobId} status: ${jobStatus.status}`,
          actions: ['CHECK_TRAINING_STATUS'],
        });

        return {
          text: `Job ${jobId} is ${jobStatus.status}`,
          data: {
            actionName: 'CHECK_TRAINING_STATUS',
            jobId,
            jobStatus,
            statusReport,
          },
          values: {
            success: true,
            status: jobStatus.status,
            jobId,
            isCompleted: jobStatus.status === 'completed',
            isFailed: jobStatus.status === 'failed',
          },
        };
      } else {
        await callback?.({
          text: '📋 Retrieving all training jobs...',
          thought: 'Getting list of all training jobs',
        });

        const allJobs = await getAllJobs(apiKey);
        const jobsReport = formatAllJobs(allJobs);

        await callback?.({
          text: jobsReport,
          thought: `Found ${allJobs.data.length} training jobs`,
          actions: ['CHECK_TRAINING_STATUS'],
        });

        return {
          text: `Found ${allJobs.data.length} training jobs`,
          data: {
            actionName: 'CHECK_TRAINING_STATUS',
            jobs: allJobs.data,
            jobsReport,
          },
          values: {
            success: true,
            jobCount: allJobs.data.length,
            hasActiveJobs: allJobs.data.some((job: any) => job.status === 'running'),
          },
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      elizaLogger.error('❌ Failed to check training status:', error);

      await callback?.({
        text: `❌ Failed to check training status: ${errorMessage}\n\nThis could be due to:\n- Invalid API key\n- Network connectivity issues\n- Invalid job ID\n- Together.ai service issues`,
        thought: `Training status check failed: ${errorMessage}`,
        actions: ['CHECK_TRAINING_STATUS'],
      });

      throw error;
    }
  },

  examples: [
    [
      {
        name: 'User',
        content: {
          text: 'Check training status for job ft-abc123',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: '🔍 Checking status for training job: ft-abc123...',
          thought: 'User wants to check specific training job status',
          actions: ['CHECK_TRAINING_STATUS'],
        },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'What is the progress of my model training?',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: '📋 Retrieving all training jobs...',
          thought: 'User wants to see all training job progress',
          actions: ['CHECK_TRAINING_STATUS'],
        },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'Show me the status of all fine-tuning jobs',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: '📋 Retrieving all training jobs...',
          thought: 'User wants to see all fine-tuning jobs status',
          actions: ['CHECK_TRAINING_STATUS'],
        },
      },
    ],
  ],
};

/**
 * Extract job ID from user message
 */
function extractJobId(message: Memory): string | null {
  const text = message.content.text || '';

  // Look for job ID patterns
  const jobIdMatch =
    text.match(/(?:job|id)[:\s]+(ft-[a-zA-Z0-9-]+)/i) || text.match(/(ft-[a-zA-Z0-9-]+)/);

  return jobIdMatch ? jobIdMatch[1] : null;
}

/**
 * Get specific job status from Together.ai
 */
async function getJobStatus(apiKey: string, jobId: string): Promise<JobStatus> {
  const response = await fetch(`https://api.together.xyz/v1/fine-tuning/jobs/${jobId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get job status: ${response.status} ${error}`);
  }

  return (await response.json()) as JobStatus;
}

/**
 * Get all fine-tuning jobs
 */
async function getAllJobs(apiKey: string): Promise<{ data: JobStatus[] }> {
  const response = await fetch('https://api.together.xyz/v1/fine-tuning/jobs', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get jobs list: ${response.status} ${error}`);
  }

  return (await response.json()) as { data: JobStatus[] };
}

/**
 * Format individual job status
 */
function formatJobStatus(job: any): string {
  const createdAt = new Date(job.created_at * 1000).toLocaleString();
  const updatedAt = job.updated_at ? new Date(job.updated_at * 1000).toLocaleString() : 'N/A';
  const finishedAt = job.finished_at
    ? new Date(job.finished_at * 1000).toLocaleString()
    : 'Not finished';

  const statusEmoji = getStatusEmoji(job.status);
  const statusColor = getStatusColor(job.status);

  let report = `${statusEmoji} **Training Job Status**\n\n`;
  report += `**Job ID:** ${job.id}\n`;
  report += `**Model:** ${job.model}\n`;
  report += `**Status:** ${statusColor}${job.status.toUpperCase()}${statusColor}\n`;
  report += `**Created:** ${createdAt}\n`;
  report += `**Updated:** ${updatedAt}\n`;

  if (job.status === 'completed') {
    report += `**Finished:** ${finishedAt}\n`;
    report += `**Fine-tuned Model:** ${job.fine_tuned_model}\n\n`;

    report += '🎉 **Training Complete!**\n';
    report += 'Your model is ready to use. You can now:\n';
    report += '1. Test the model with API calls\n';
    report += '2. Configure auto-coder to use this model\n';
    report += '3. Update your reasoning service configuration\n\n';
    report += `**Model ID:** \`${job.fine_tuned_model}\``;
  } else if (job.status === 'running') {
    report += '**Progress:** Training in progress...\n\n';

    if (job.training_steps && job.total_steps) {
      const progress = Math.round((job.training_steps / job.total_steps) * 100);
      report += `**Training Progress:** ${job.training_steps}/${job.total_steps} steps (${progress}%)\n`;
    }

    if (job.estimated_finish) {
      const estimatedFinish = new Date(job.estimated_finish * 1000).toLocaleString();
      report += `**Estimated Completion:** ${estimatedFinish}\n`;
    }

    report += '\n⏳ **Training in Progress**\n';
    report +=
      'Your model is being fine-tuned. This typically takes 2-6 hours depending on dataset size.';
  } else if (job.status === 'failed') {
    report += '\n❌ **Training Failed**\n';
    if (job.error) {
      report += `**Error:** ${job.error.message || job.error}\n`;
    }
    report += 'Please check your training data and configuration, then try again.';
  } else if (job.status === 'cancelled') {
    report += '\n🚫 **Training Cancelled**\n';
    report += 'The training job was cancelled before completion.';
  } else {
    report += `\n📝 **Status:** ${job.status}\n`;
    if (job.status === 'queued') {
      report += 'Your job is in the queue and will start soon.';
    } else if (job.status === 'validating_files') {
      report += 'Validating training data format and content.';
    }
  }

  // Add hyperparameters if available
  if (job.hyperparameters) {
    report += '\n\n**Training Configuration:**\n';
    if (job.hyperparameters.learning_rate) {
      report += `• Learning Rate: ${job.hyperparameters.learning_rate}\n`;
    }
    if (job.hyperparameters.n_epochs) {
      report += `• Epochs: ${job.hyperparameters.n_epochs}\n`;
    }
    if (job.hyperparameters.batch_size) {
      report += `• Batch Size: ${job.hyperparameters.batch_size}\n`;
    }
  }

  return report;
}

/**
 * Format all jobs list
 */
function formatAllJobs(jobsResponse: any): string {
  const jobs = jobsResponse.data || [];

  if (jobs.length === 0) {
    return "📭 **No Training Jobs Found**\n\nYou haven't started any fine-tuning jobs yet. Use the TRAIN_MODEL action to create your first training job.";
  }

  let report = `📋 **All Training Jobs (${jobs.length})**\n\n`;

  // Sort by creation date (newest first)
  const sortedJobs = jobs.sort((a: any, b: any) => b.created_at - a.created_at);

  for (const job of sortedJobs.slice(0, 10)) {
    // Show last 10 jobs
    const statusEmoji = getStatusEmoji(job.status);
    const createdAt = new Date(job.created_at * 1000).toLocaleDateString();
    const modelName = job.fine_tuned_model
      ? job.fine_tuned_model.split('/').pop()
      : job.model.split('/').pop();

    report += `${statusEmoji} **${job.id}**\n`;
    report += `   Model: ${modelName}\n`;
    report += `   Status: ${job.status.toUpperCase()}\n`;
    report += `   Created: ${createdAt}\n`;

    if (job.status === 'completed' && job.fine_tuned_model) {
      report += `   ✅ Ready: \`${job.fine_tuned_model}\`\n`;
    } else if (job.status === 'running') {
      report += '   ⏳ Training in progress...\n';
    } else if (job.status === 'failed') {
      report += '   ❌ Failed\n';
    }

    report += '\n';
  }

  if (jobs.length > 10) {
    report += `*Showing 10 most recent jobs out of ${jobs.length} total.*\n\n`;
  }

  report += '💡 **Quick Actions:**\n';
  report += '• Check specific job: "Check status for job [JOB_ID]"\n';
  report += '• Start new training: "Train a model with my dataset"\n';
  report += '• Configure auto-coder: "Setup auto-coder with model [MODEL_ID]"';

  return report;
}

/**
 * Get emoji for job status
 */
function getStatusEmoji(status: string): string {
  const emojiMap: Record<string, string> = {
    queued: '⏳',
    validating_files: '🔍',
    running: '🏃',
    completed: '✅',
    failed: '❌',
    cancelled: '🚫',
  };

  return emojiMap[status] || '📝';
}

/**
 * Get color markup for status (if supported)
 */
function getStatusColor(status: string): string {
  // This could be extended to support color formatting
  // For now, just return empty string
  return '';
}

elizaLogger.info('✅ Check training status action loaded');
