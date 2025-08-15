/**
 * MVP Custom Reasoning Service - Actually Working Implementation
 *
 * This is a minimal viable product that:
 * 1. Actually integrates with ElizaOS
 * 2. Preserves backwards compatibility
 * 3. Enables/disables custom reasoning
 * 4. Stores basic training data
 * 5. Has real error handling
 */

import type { IAgentRuntime, Memory, State, Content } from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';
import crypto from 'crypto';

export interface TrainingDataRecord {
  id: string;
  timestamp: number;
  agentId: string;
  roomId?: string;
  modelType: 'should_respond' | 'planning' | 'coding';
  input: any;
  output: any;
  success: boolean;
}

export class SimpleReasoningService {
  private runtime: IAgentRuntime;
  private enabled: boolean = false;
  private originalUseModel: any;
  private trainingData: TrainingDataRecord[] = [];

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    // Validate that runtime.useModel exists before storing it
    if (!runtime.useModel || typeof runtime.useModel !== 'function') {
      throw new Error('Runtime does not have a valid useModel method');
    }
    this.originalUseModel = runtime.useModel.bind(runtime);
  }

  /**
   * Enable custom reasoning - overrides runtime.useModel
   */
  async enable(): Promise<void> {
    if (this.enabled) {
      throw new Error('Custom reasoning already enabled');
    }

    try {
      // Override runtime.useModel with custom logic
      const self = this;
      this.runtime.useModel = async function (modelType: any, params: any, provider?: string) {
        try {
          // For now, just log and store training data, then use original
          const record: TrainingDataRecord = {
            id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            timestamp: Date.now(),
            agentId: this.agentId,
            roomId: params.roomId,
            modelType: self.determineModelType(modelType, params),
            input: { modelType, params, provider },
            output: null,
            success: false,
          };

          // Call original useModel
          const result = await self.originalUseModel(modelType, params, provider);

          // Store successful result
          record.output = result;
          record.success = true;
          self.trainingData.push(record);

          // Save to database if available
          await self.saveTrainingData(record);

          return result;
        } catch (error) {
          // On any error, fall back to original behavior
          elizaLogger.warn('Custom reasoning failed, falling back:', error);
          return await self.originalUseModel(modelType, params, provider);
        }
      };

      this.enabled = true;
      elizaLogger.info('Custom reasoning service enabled');
    } catch (error) {
      elizaLogger.error('Failed to enable custom reasoning:', error);
      throw error;
    }
  }

  /**
   * Disable custom reasoning - restore original behavior
   */
  async disable(): Promise<void> {
    if (!this.enabled) {
      throw new Error('Custom reasoning not enabled');
    }

    try {
      // Validate originalUseModel exists before restoring it
      if (!this.originalUseModel || typeof this.originalUseModel !== 'function') {
        throw new Error('Original useModel method is not available');
      }
      // Restore original useModel method - IMPORTANT: bind to runtime for correct context
      this.runtime.useModel = this.originalUseModel;
      this.enabled = false;
      elizaLogger.info('Custom reasoning service disabled');
    } catch (error) {
      elizaLogger.error('Failed to disable custom reasoning:', error);
      throw error;
    }
  }

  /**
   * Get current status
   */
  getStatus(): { enabled: boolean; dataCount: number; lastActivity?: number } {
    return {
      enabled: this.enabled,
      dataCount: this.trainingData.length,
      lastActivity:
        this.trainingData.length > 0
          ? Math.max(...this.trainingData.map((d) => d.timestamp))
          : undefined,
    };
  }

  /**
   * Get collected training data
   */
  getTrainingData(): TrainingDataRecord[] {
    return [...this.trainingData];
  }

  /**
   * Clear collected training data
   */
  clearTrainingData(): void {
    this.trainingData = [];
  }

  private determineModelType(
    modelType: any,
    params: any
  ): 'should_respond' | 'planning' | 'coding' {
    // Simple heuristics to determine model type
    if (params.shouldRespond || params.text?.includes('should respond')) {
      return 'should_respond';
    }
    if (params.code || params.text?.includes('function') || params.text?.includes('import')) {
      return 'coding';
    }
    return 'planning';
  }

  private async saveTrainingData(record: TrainingDataRecord): Promise<void> {
    try {
      // Try to save to database if SQL plugin is available
      const sqlPlugin = this.runtime.getService?.('sql');
      if (sqlPlugin) {
        await (sqlPlugin as any).query(
          `INSERT INTO training_data (id, timestamp, agent_id, room_id, model_type, input_data, output_data, success) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.timestamp,
            record.agentId,
            record.roomId,
            record.modelType,
            JSON.stringify(record.input),
            JSON.stringify(record.output),
            record.success,
          ]
        );
      }
    } catch (error) {
      // Don't fail if database save fails
      elizaLogger.warn('Failed to save training data to database:', error);
    }
  }
}
