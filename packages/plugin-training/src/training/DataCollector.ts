import { promises as fs } from 'fs';
import path from 'path';
import type { IAgentRuntime, UUID } from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';
import type {
  TrainingDataPoint,
  TrainingDataset,
  TrainingSample,
  ExportOptions,
  CustomModelType,
} from '../interfaces/CustomReasoningService.js';

export class TrainingDataCollector {
  constructor(private runtime: IAgentRuntime) {}

  /**
   * Export training data from database logs
   */
  async exportTrainingData(options: ExportOptions = {}): Promise<TrainingDataset> {
    const { modelType, limit = 1000, offset = 0, startDate, endDate, format = 'jsonl' } = options;

    // Build type filter
    const typeFilter = modelType ? `training-data:${modelType}` : 'training-data%';

    try {
      // Get logs from database
      const logs = await (this.runtime as any).adapter.getLogs({
        entityId: this.runtime.agentId,
        type: typeFilter,
        limit,
        offset,
      });

      // Filter by date range if specified
      let filteredLogs = logs;
      if (startDate || endDate) {
        filteredLogs = logs.filter((log: any) => {
          const logTime = log.createdAt || Date.now();
          if (startDate && logTime < startDate.getTime()) {
            return false;
          }
          if (endDate && logTime > endDate.getTime()) {
            return false;
          }
          return true;
        });
      }

      // Convert to training samples
      const samples = filteredLogs
        .map((log: any) => {
          try {
            return this.formatTrainingSample(log.body as TrainingDataPoint);
          } catch (error) {
            elizaLogger.warn('Failed to format training sample:', error);
            return null;
          }
        })
        .filter(Boolean) as TrainingSample[];

      const dataset: TrainingDataset = {
        modelType,
        format,
        samples,
        metadata: {
          exportedAt: Date.now(),
          agentId: this.runtime.agentId,
          totalSamples: samples.length,
          dateRange:
            startDate || endDate
              ? {
                  start: startDate?.getTime() || 0,
                  end: endDate?.getTime() || Date.now(),
                }
              : undefined,
        },
      };

      elizaLogger.info(
        `Exported ${samples.length} training samples for ${modelType || 'all models'}`
      );

      return dataset;
    } catch (error) {
      elizaLogger.error('Failed to export training data:', error);
      throw error;
    }
  }

  /**
   * Format a training data point into a sample for fine-tuning
   */
  private formatTrainingSample(dataPoint: TrainingDataPoint): TrainingSample {
    switch (dataPoint.modelType) {
      case 'should_respond':
        return this.formatShouldRespondSample(dataPoint);
      case 'planning':
        return this.formatPlanningSample(dataPoint);
      case 'coding':
        return this.formatCodingSample(dataPoint);
      default:
        throw new Error(`Unknown model type: ${dataPoint.modelType}`);
    }
  }

  /**
   * Format shouldRespond training sample
   */
  private formatShouldRespondSample(dataPoint: TrainingDataPoint): TrainingSample {
    const input = dataPoint.input;
    const output = dataPoint.output;

    // Extract the core decision prompt
    const conversationContext =
      input.conversationContext
        ?.map(
          (msg: any) =>
            `${msg.entityId === this.runtime.agentId ? 'Agent' : 'User'}: ${msg.content.text}`
        )
        .join('\n') || '';

    const systemPrompt =
      'You are an AI agent deciding whether to respond to a message. Consider the conversation context and determine if the agent should RESPOND, IGNORE, or STOP.';

    const userPrompt = `Recent conversation:
${conversationContext}

Current message: ${input.messageText}

Should the agent respond to this message?`;

    const assistantResponse = `<response>
<reasoning>${output.reasoning}</reasoning>
<action>${output.decision}</action>
</response>`;

    return {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: assistantResponse },
      ],
      metadata: {
        modelType: dataPoint.modelType,
        timestamp: dataPoint.timestamp,
        confidence: output.confidence,
        agentId: dataPoint.metadata.agentId,
        roomId: dataPoint.metadata.roomId,
      },
    };
  }

  /**
   * Format planning training sample
   */
  private formatPlanningSample(dataPoint: TrainingDataPoint): TrainingSample {
    const input = dataPoint.input;
    const output = dataPoint.output;

    const systemPrompt =
      'You are an AI agent planning how to respond to a message. Generate a thought process, select appropriate actions, choose relevant providers for context, and create a response.';

    const userPrompt = `Message: ${input.messageText}

Available actions: ${input.availableActions?.join(', ') || 'None'}

Current state: ${JSON.stringify(input.state, null, 2)}

Plan your response:`;

    const assistantResponse = `<response>
<thought>${output.thought}</thought>
<actions>${output.actions.join(',')}</actions>
<providers>${output.providers.join(',')}</providers>
<text>${output.text}</text>
</response>`;

    return {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: assistantResponse },
      ],
      metadata: {
        modelType: dataPoint.modelType,
        timestamp: dataPoint.timestamp,
        agentId: dataPoint.metadata.agentId,
        roomId: dataPoint.metadata.roomId,
        actions: output.actions,
        providers: output.providers,
      },
    };
  }

  /**
   * Format coding training sample
   */
  private formatCodingSample(dataPoint: TrainingDataPoint): TrainingSample {
    const input = dataPoint.input;
    const output = dataPoint.output;

    const systemPrompt =
      'You are an expert programmer. Generate clean, efficient code based on the given requirements.';

    const userPrompt = input.prompt;

    const assistantResponse = output.explanation
      ? `${output.explanation}\n\n\`\`\`${input.language || 'javascript'}\n${output.code}\n\`\`\``
      : `\`\`\`${input.language || 'javascript'}\n${output.code}\n\`\`\``;

    return {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: assistantResponse },
      ],
      metadata: {
        modelType: dataPoint.modelType,
        timestamp: dataPoint.timestamp,
        language: input.language,
        codeLength: output.code.length,
        hasExplanation: !!output.explanation,
      },
    };
  }

  /**
   * Convert dataset to JSONL format
   */
  async exportToJSONL(dataset: TrainingDataset): Promise<string> {
    return dataset.samples.map((sample) => JSON.stringify(sample)).join('\n');
  }

  /**
   * Save dataset to file
   */
  async saveToFile(dataset: TrainingDataset, filePath: string): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      let content: string;

      if (dataset.format === 'jsonl') {
        content = await this.exportToJSONL(dataset);
      } else {
        content = JSON.stringify(dataset, null, 2);
      }

      await fs.writeFile(filePath, content, 'utf-8');

      elizaLogger.info(`Saved ${dataset.samples.length} training samples to ${filePath}`);
    } catch (error) {
      elizaLogger.error(`Failed to save training data to ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Get training data statistics
   */
  async getTrainingDataStats(): Promise<{
    total: number;
    byModelType: Record<string, number>;
    dateRange: { start: number; end: number };
    recentSamples: number;
  }> {
    try {
      // Get all training data logs
      const logs = await (this.runtime as any).adapter.getLogs({
        entityId: this.runtime.agentId,
        type: 'training-data%',
        limit: 10000, // Get a large sample
      });

      // Group by model type
      const byModelType: Record<string, number> = {};
      let minTime = Date.now();
      let maxTime = 0;

      for (const log of logs) {
        const dataPoint = log.body as TrainingDataPoint;
        const modelType = dataPoint.modelType;

        byModelType[modelType] = (byModelType[modelType] || 0) + 1;

        const timestamp = dataPoint.timestamp || log.createdAt || Date.now();
        minTime = Math.min(minTime, timestamp);
        maxTime = Math.max(maxTime, timestamp);
      }

      // Count recent samples (last 24 hours)
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const recentSamples = logs.filter((log: any) => {
        const timestamp = (log.body as TrainingDataPoint).timestamp || log.createdAt || Date.now();
        return timestamp > oneDayAgo;
      }).length;

      return {
        total: logs.length,
        byModelType,
        dateRange: { start: minTime, end: maxTime },
        recentSamples,
      };
    } catch (error) {
      elizaLogger.error('Failed to get training data stats:', error);
      throw error;
    }
  }

  /**
   * Clean up old training data based on retention policy
   */
  async cleanupOldData(retentionDays: number = 30): Promise<number> {
    try {
      const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

      // Get old training data logs
      const logs = await (this.runtime as any).adapter.getLogs({
        entityId: this.runtime.agentId,
        type: 'training-data%',
        limit: 10000,
      });

      const oldLogs = logs.filter((log: any) => {
        const timestamp = (log.body as TrainingDataPoint).timestamp || log.createdAt || Date.now();
        return timestamp < cutoffTime;
      });

      // Delete old logs
      // Note: This assumes the adapter has a method to delete logs by ID
      // Implementation may vary based on the actual adapter interface
      let deletedCount = 0;
      for (const log of oldLogs) {
        try {
          // Delete the log using the runtime's deleteLog method
          await this.runtime.deleteLog(log.id);
          deletedCount++;
        } catch (error) {
          elizaLogger.warn('Failed to delete old log:', error);
        }
      }

      elizaLogger.info(
        `Cleaned up ${deletedCount} old training data entries (older than ${retentionDays} days)`
      );

      return deletedCount;
    } catch (error) {
      elizaLogger.error('Failed to cleanup old training data:', error);
      throw error;
    }
  }

  /**
   * Generate training data summary report
   */
  async generateReport(): Promise<{
    summary: any;
    recommendations: string[];
  }> {
    const stats = await this.getTrainingDataStats();

    const recommendations: string[] = [];

    // Check if we have enough data for each model type
    Object.entries(stats.byModelType).forEach(([modelType, count]) => {
      if (count < 100) {
        recommendations.push(
          `Consider collecting more data for ${modelType} model (currently ${count} samples, recommended 100+)`
        );
      }
    });

    // Check data recency
    if (stats.recentSamples < 10) {
      recommendations.push(
        'Consider increasing agent activity to collect more recent training data'
      );
    }

    // Check data distribution
    const totalSamples = stats.total;
    const modelTypes = Object.keys(stats.byModelType);

    if (modelTypes.length === 1) {
      recommendations.push('Consider enabling more model types to collect diverse training data');
    }

    return {
      summary: {
        ...stats,
        dataQuality: this.assessDataQuality(stats),
      },
      recommendations,
    };
  }

  private assessDataQuality(stats: any): string {
    const { total, byModelType, recentSamples } = stats;

    if (total < 50) {
      return 'Insufficient';
    }
    if (total < 200) {
      return 'Limited';
    }
    if (Object.keys(byModelType).length < 2) {
      return 'Narrow';
    }
    if (recentSamples < 5) {
      return 'Stale';
    }
    if (total > 1000 && Object.keys(byModelType).length >= 2) {
      return 'Excellent';
    }

    return 'Good';
  }
}
