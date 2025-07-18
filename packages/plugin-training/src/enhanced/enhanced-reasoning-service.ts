/**
 * Enhanced Custom Reasoning Service
 *
 * This service provides comprehensive training data collection with:
 * - Database persistence using plugin-sql
 * - File system storage for visual debugging
 * - Session management and statistics tracking
 * - Complete ModelType support
 */

import { logger, type IAgentRuntime } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { TrainingDataRecord } from './schema';

export interface TrainingRecord {
  id: string;
  sessionId: string;
  modelType: string;
  provider?: string;
  inputParams: any;
  output?: any;
  success: boolean;
  errorMessage?: string;
  executionTimeMs?: number;
  roomId?: string;
  entityId?: string;
  messageId?: string;
  timestamp: number;
}

export class EnhancedReasoningService {
  private enabled: boolean = false;
  private originalUseModel: any = null;
  private currentSessionId: string | null = null;
  private trainingRecords: TrainingRecord[] = [];
  private sessionStats = {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    startTime: 0,
  };

  constructor(private runtime: IAgentRuntime) {}

  /**
   * Enable custom reasoning with database and file system storage
   */
  async enable(): Promise<void> {
    if (this.enabled) {
      throw new Error('Enhanced reasoning already enabled');
    }

    try {
      // Start new training session
      this.currentSessionId = `session_${Date.now()}_${uuidv4().slice(0, 8)}`;
      this.sessionStats = {
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        startTime: Date.now(),
      };

      // Create database session record
      await this.createDatabaseSession();

      // Ensure training_recording directory exists
      await this.ensureTrainingDirectory();

      // Store original useModel function
      this.originalUseModel = this.runtime.useModel.bind(this.runtime);

      // Override runtime.useModel with enhanced logic
      const self = this;
      this.runtime.useModel = async function (modelType: any, params: any, provider?: string) {
        return await self.interceptUseModel(modelType, params, provider);
      };

      this.enabled = true;
      logger.info(`🔬 Enhanced reasoning service enabled with session: ${this.currentSessionId}`);
    } catch (error) {
      this.enabled = false;
      throw new Error(
        `Failed to enable enhanced reasoning: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Disable custom reasoning and save session data
   */
  async disable(): Promise<void> {
    if (!this.enabled) {
      throw new Error('Enhanced reasoning is not enabled');
    }

    try {
      // Restore original useModel function
      if (this.originalUseModel) {
        this.runtime.useModel = this.originalUseModel;
        this.originalUseModel = null;
      }

      // Complete database session
      await this.completeDatabaseSession();

      // Save final session file
      await this.saveSessionFile();

      // Log final statistics
      const duration = Date.now() - this.sessionStats.startTime;
      logger.info('🔬 Enhanced reasoning session completed:', {
        sessionId: this.currentSessionId,
        totalCalls: this.sessionStats.totalCalls,
        successfulCalls: this.sessionStats.successfulCalls,
        failedCalls: this.sessionStats.failedCalls,
        durationMs: duration,
        recordsCollected: this.trainingRecords.length,
      });

      // Reset state
      this.enabled = false;
      this.currentSessionId = null;
      this.trainingRecords = [];
      this.sessionStats = { totalCalls: 0, successfulCalls: 0, failedCalls: 0, startTime: 0 };
    } catch (error) {
      logger.error('Error disabling enhanced reasoning:', error);
      throw new Error(
        `Failed to disable enhanced reasoning: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get current status and statistics
   */
  getStatus() {
    const duration = this.enabled ? Date.now() - this.sessionStats.startTime : 0;

    return {
      enabled: this.enabled,
      sessionId: this.currentSessionId,
      stats: {
        ...this.sessionStats,
        durationMs: duration,
        recordsCollected: this.trainingRecords.length,
      },
    };
  }

  /**
   * Intercept and process useModel calls
   */
  private async interceptUseModel(modelType: any, params: any, provider?: string): Promise<any> {
    const startTime = Date.now();
    const recordId = uuidv4();

    this.sessionStats.totalCalls++;

    // Create training record
    const record: TrainingRecord = {
      id: recordId,
      sessionId: this.currentSessionId!,
      modelType: String(modelType),
      provider,
      inputParams: this.sanitizeParams(params),
      success: false,
      timestamp: startTime,
    };

    try {
      // Call original useModel function
      const result = await this.originalUseModel(modelType, params, provider);

      // Record successful execution
      const executionTime = Date.now() - startTime;
      record.output = this.sanitizeOutput(result);
      record.success = true;
      record.executionTimeMs = executionTime;

      this.sessionStats.successfulCalls++;

      // Store record
      this.trainingRecords.push(record);
      await this.saveToDatabaseAndFile(record);

      logger.debug(`🔬 Training data collected for ${modelType}:`, {
        recordId,
        sessionId: this.currentSessionId,
        executionTimeMs: executionTime,
        success: true,
      });

      return result;
    } catch (error) {
      // Record failed execution
      const executionTime = Date.now() - startTime;
      record.errorMessage = error instanceof Error ? error.message : String(error);
      record.executionTimeMs = executionTime;
      record.success = false;

      this.sessionStats.failedCalls++;

      // Store failed record
      this.trainingRecords.push(record);
      await this.saveToDatabaseAndFile(record);

      logger.warn(`🔬 Training data collected for failed ${modelType}:`, {
        recordId,
        sessionId: this.currentSessionId,
        error: record.errorMessage,
        executionTimeMs: executionTime,
      });

      // Always fall back to original behavior on error
      return await this.originalUseModel(modelType, params, provider);
    }
  }

  /**
   * Create database session record
   */
  private async createDatabaseSession(): Promise<void> {
    try {
      const db = (this.runtime as any).databaseAdapter?.db;
      if (!db) {
        logger.warn('No database available for session tracking');
        return;
      }

      // First ensure our custom tables exist
      await this.ensureTrainingTables(db);

      // Create session record
      const sessionData = {
        agentId: this.runtime.agentId,
        sessionId: this.currentSessionId!,
        status: 'active' as const,
        description: `Enhanced reasoning session started at ${new Date().toISOString()}`,
        totalRecords: 0,
        successfulRecords: 0,
        failedRecords: 0,
      };

      // Use raw SQL for maximum compatibility
      await db.execute({
        sql: `INSERT INTO training_sessions (
          id, agent_id, session_id, status, description, 
          total_records, successful_records, failed_records,
          started_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          uuidv4(),
          sessionData.agentId,
          sessionData.sessionId,
          sessionData.status,
          sessionData.description,
          sessionData.totalRecords,
          sessionData.successfulRecords,
          sessionData.failedRecords,
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      });

      logger.info(`✅ Database session created: ${this.currentSessionId}`);
    } catch (error) {
      logger.error('Failed to create database session:', error);
      // Don't fail the enable operation
    }
  }

  /**
   * Complete database session with final statistics
   */
  private async completeDatabaseSession(): Promise<void> {
    try {
      const db = (this.runtime as any).databaseAdapter?.db;
      if (!db || !this.currentSessionId) {
        return;
      }

      // Update session with final statistics
      await db.execute({
        sql: `UPDATE training_sessions SET 
          status = ?, 
          total_records = ?, 
          successful_records = ?, 
          failed_records = ?,
          completed_at = ?,
          updated_at = ?
        WHERE session_id = ? AND agent_id = ?`,
        args: [
          'completed',
          this.sessionStats.totalCalls,
          this.sessionStats.successfulCalls,
          this.sessionStats.failedCalls,
          new Date().toISOString(),
          new Date().toISOString(),
          this.currentSessionId,
          this.runtime.agentId,
        ],
      });

      logger.info(`✅ Database session completed: ${this.currentSessionId}`);
    } catch (error) {
      logger.error('Failed to complete database session:', error);
    }
  }

  /**
   * Save training record to database and file system
   */
  private async saveToDatabaseAndFile(record: TrainingRecord): Promise<void> {
    // Save to database
    await this.saveToDatabase(record);

    // Save to file system for visual debugging
    await this.saveToFileSystem(record);
  }

  /**
   * Save record to database
   */
  private async saveToDatabase(record: TrainingRecord): Promise<void> {
    try {
      const db = (this.runtime as any).databaseAdapter?.db;
      if (!db) {
        logger.warn('No database available for training data storage');
        return;
      }

      // Insert training data record
      await db.execute({
        sql: `INSERT INTO training_data (
          id, agent_id, session_id, model_type, provider,
          input_params, output, success, error_message, execution_time_ms,
          room_id, entity_id, message_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          record.id,
          this.runtime.agentId,
          record.sessionId,
          record.modelType,
          record.provider || null,
          JSON.stringify(record.inputParams),
          record.output ? JSON.stringify(record.output) : null,
          record.success ? 1 : 0,
          record.errorMessage || null,
          record.executionTimeMs || null,
          record.roomId || null,
          record.entityId || null,
          record.messageId || null,
          new Date(record.timestamp).toISOString(),
          new Date().toISOString(),
        ],
      });

      logger.debug(`✅ Training record saved to database: ${record.id}`);
    } catch (error) {
      logger.error('Failed to save training data to database:', error);
      // Don't fail the operation
    }
  }

  /**
   * Save record to file system for visual debugging
   */
  private async saveToFileSystem(record: TrainingRecord): Promise<void> {
    try {
      // Use centralized path management for training recordings
      let trainingDir: string;
      try {
        const { getTrainingPath } = require('@elizaos/core/utils/path-manager');
        trainingDir = getTrainingPath(`recordings/${this.currentSessionId!}`);
      } catch {
        // Fallback to legacy path if path-manager is not available
        trainingDir = path.join(process.cwd(), 'training_recording', this.currentSessionId!);
      }
      await fs.mkdir(trainingDir, { recursive: true });

      const filename = `${record.timestamp}_${record.id}_${record.modelType}.json`;
      const filepath = path.join(trainingDir, filename);

      const fileData = {
        ...record,
        humanTimestamp: new Date(record.timestamp).toISOString(),
        sessionInfo: {
          sessionId: this.currentSessionId,
          agentId: this.runtime.agentId,
          totalCalls: this.sessionStats.totalCalls,
          successfulCalls: this.sessionStats.successfulCalls,
          failedCalls: this.sessionStats.failedCalls,
        },
      };

      await fs.writeFile(filepath, JSON.stringify(fileData, null, 2), 'utf-8');
      logger.debug(`✅ Training record saved to file: ${filename}`);
    } catch (error) {
      logger.error('Failed to save training data to file:', error);
      // Don't fail the operation
    }
  }

  /**
   * Save complete session file
   */
  private async saveSessionFile(): Promise<void> {
    try {
      // Use centralized path management for training recordings
      let trainingDir: string;
      try {
        const { getTrainingPath } = require('@elizaos/core/utils/path-manager');
        trainingDir = getTrainingPath(`recordings/${this.currentSessionId!}`);
      } catch {
        // Fallback to legacy path if path-manager is not available
        trainingDir = path.join(process.cwd(), 'training_recording', this.currentSessionId!);
      }
      const sessionFile = path.join(trainingDir, 'session_summary.json');

      const sessionData = {
        sessionId: this.currentSessionId,
        agentId: this.runtime.agentId,
        startTime: this.sessionStats.startTime,
        endTime: Date.now(),
        duration: Date.now() - this.sessionStats.startTime,
        statistics: this.sessionStats,
        totalRecords: this.trainingRecords.length,
        records: this.trainingRecords,
      };

      await fs.writeFile(sessionFile, JSON.stringify(sessionData, null, 2), 'utf-8');
      logger.info('✅ Session summary saved: session_summary.json');
    } catch (error) {
      logger.error('Failed to save session file:', error);
    }
  }

  /**
   * Ensure training directory exists
   */
  private async ensureTrainingDirectory(): Promise<void> {
    try {
      // Use centralized path management for training recordings
      let trainingDir: string;
      let sessionDir: string;
      try {
        const { getTrainingPath } = require('@elizaos/core/utils/path-manager');
        trainingDir = getTrainingPath('recordings');
        sessionDir = getTrainingPath(`recordings/${this.currentSessionId!}`);
      } catch {
        // Fallback to legacy path if path-manager is not available
        trainingDir = path.join(process.cwd(), 'training_recording');
        sessionDir = path.join(trainingDir, this.currentSessionId!);
      }
      await fs.mkdir(trainingDir, { recursive: true });
      await fs.mkdir(sessionDir, { recursive: true });

      logger.info(`✅ Training directory ready: ${sessionDir}`);
    } catch (error) {
      logger.error('Failed to create training directory:', error);
      throw error;
    }
  }

  /**
   * Ensure training tables exist in database
   */
  private async ensureTrainingTables(db: any): Promise<void> {
    try {
      // Create training_data table
      await db.execute({
        sql: `CREATE TABLE IF NOT EXISTS training_data (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          model_type TEXT NOT NULL,
          provider TEXT,
          input_params TEXT NOT NULL DEFAULT '{}',
          output TEXT,
          success INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          execution_time_ms INTEGER,
          room_id TEXT,
          entity_id TEXT,
          message_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        args: [],
      });

      // Create training_sessions table
      await db.execute({
        sql: `CREATE TABLE IF NOT EXISTS training_sessions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          description TEXT,
          total_records INTEGER NOT NULL DEFAULT 0,
          successful_records INTEGER NOT NULL DEFAULT 0,
          failed_records INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(agent_id, session_id)
        )`,
        args: [],
      });

      // Create indexes for better performance
      await db.execute({
        sql: `CREATE INDEX IF NOT EXISTS idx_training_data_agent_session 
              ON training_data(agent_id, session_id)`,
        args: [],
      });

      await db.execute({
        sql: `CREATE INDEX IF NOT EXISTS idx_training_data_model_type 
              ON training_data(model_type)`,
        args: [],
      });

      await db.execute({
        sql: `CREATE INDEX IF NOT EXISTS idx_training_sessions_agent 
              ON training_sessions(agent_id)`,
        args: [],
      });

      logger.info('✅ Training tables ensured in database');
    } catch (error) {
      logger.error('Failed to ensure training tables:', error);
      // Don't fail - tables might already exist
    }
  }

  /**
   * Sanitize input parameters for storage
   */
  private sanitizeParams(params: any): any {
    try {
      // Create a safe copy without circular references
      return JSON.parse(JSON.stringify(params));
    } catch (error) {
      return { error: 'Could not serialize params', type: typeof params };
    }
  }

  /**
   * Sanitize output for storage
   */
  private sanitizeOutput(output: any): any {
    try {
      // Create a safe copy without circular references
      return JSON.parse(JSON.stringify(output));
    } catch (error) {
      return { error: 'Could not serialize output', type: typeof output };
    }
  }
}
