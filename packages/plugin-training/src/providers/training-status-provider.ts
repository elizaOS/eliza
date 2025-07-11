import {
  type Provider,
  type IAgentRuntime,
  type Memory,
  type State,
  elizaLogger,
} from '@elizaos/core';
import { type TrainingServiceInterface } from '../types.js';

/**
 * Provider that injects current training status into agent context
 */
export const trainingStatusProvider: Provider = {
  name: 'TRAINING_STATUS',
  description:
    'Provides current training job status including dataset quality metrics, active job progress, and completion statistics when agent needs to report on model training activities or guide training decisions',
  dynamic: true, // Only included when training-related conversation is happening

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      const trainingService = runtime.getService<TrainingServiceInterface>('training');
      if (!trainingService) {
        return {
          text: '',
          values: {},
        };
      }

      // Check if message is training-related
      const text = message.content.text?.toLowerCase() || '';
      const isTrainingRelated = [
        'training',
        'rlaif',
        'atropos',
        'dataset',
        'fine-tune',
        'model',
      ].some((keyword) => text.includes(keyword));

      if (!isTrainingRelated && !state.values.trainingJobId) {
        return {
          text: '',
          values: {},
        };
      }

      // Get training statistics
      const stats = await trainingService.getTrainingStats();

      let statusText = `[TRAINING STATUS]
Dataset: ${stats.totalConversations} conversations, ${stats.totalMessages} messages
Quality: ${stats.qualityMetrics.averageQuality.toFixed(2)} average
Actions: ${stats.actionStats.successfulActions}/${stats.actionStats.totalActions} successful
[/TRAINING STATUS]`;

      // If there's an active training job, get its status
      if (state.values.trainingJobId) {
        try {
          const trainingJob = await trainingService.monitorTraining(state.values.trainingJobId);

          if (trainingJob) {
            const progress = trainingJob.progress;
            const progressText = progress
              ? ` (${progress.currentStep}/${progress.totalSteps} steps, loss: ${progress.currentLoss?.toFixed(4)})`
              : '';

            statusText += `

[ACTIVE TRAINING]
Job: ${trainingJob.id}
Status: ${trainingJob.status}${progressText}
[/ACTIVE TRAINING]`;
          }
        } catch (error) {
          elizaLogger.warn('Error getting training job status in provider:', error);
        }
      }

      return {
        text: statusText,
        values: {
          hasTrainingData: stats.totalConversations > 0,
          datasetQuality: stats.qualityMetrics.averageQuality,
          totalConversations: stats.totalConversations,
          totalMessages: stats.totalMessages,
          activeTrainingJob: state.values.trainingJobId || null,
        },
        data: {
          datasetStats: stats,
        },
      };
    } catch (error) {
      elizaLogger.error('Error in training status provider:', error);
      return {
        text: '',
        values: {},
      };
    }
  },
};
