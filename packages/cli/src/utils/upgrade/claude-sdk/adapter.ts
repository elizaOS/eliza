import { logger } from '@elizaos/core';
import type {
  MigrationContext,
  MigrationPhase,
  SDKPhaseResult,
  SDKMigrationOptions,
  ClaudeSDKAdapter,
  PhaseMetrics,
  MigrationMetricsCollector,
  SessionManager
} from '../types.js';
import {
  importClaudeSDK,
  validateClaudeSDKEnvironment,
  getSDKErrorContext,
  type SDKMessage,
  type ClaudeSDKModule
} from './utils.js';

/**
 * Claude SDK Adapter for Migration System
 * 
 * Pure SDK implementation for reliable ElizaOS plugin migration.
 * No CLI dependencies - uses official Claude Code SDK exclusively.
 */
export class EnhancedClaudeSDKAdapter implements ClaudeSDKAdapter {
  private maxRetries = 3;
  private rateLimitDelay = 60000; // 1 minute

  constructor(options?: { maxRetries?: number }) {
    this.maxRetries = options?.maxRetries ?? 3;
  }

  /**
   * Execute a prompt using the Claude Code SDK
   */
  async executePrompt(
    prompt: string, 
    options: SDKMigrationOptions, 
    context: MigrationContext
  ): Promise<SDKPhaseResult> {
    logger.info('🤖 Executing prompt with Claude SDK...');
    
    let retryCount = 0;
    let lastError: unknown = null;
    let maxTurnsCount = 0; // Track consecutive max_turns errors

    while (retryCount < this.maxRetries) {
      try {
        const result = await this.executePromptWithSDK(prompt, options, context);
        
        // Handle max_turns error with automatic retry and backoff
        if (result.message?.includes('error_max_turns') && maxTurnsCount < 3) {
          maxTurnsCount++;
          const waitTime = this.calculateBackoffTime(maxTurnsCount, 'max_turns');
          
          logger.warn(`⏸️  Hit conversation limit (attempt ${maxTurnsCount}/3). Waiting ${waitTime / 1000} seconds for reset...`);
          await this.showCountdown(waitTime);
          
          // Continue the conversation with the same session if available
          if (result.sessionId && options.resumeSessionId !== result.sessionId) {
            options.resumeSessionId = result.sessionId;
            logger.info(`🔄 Continuing with session: ${result.sessionId}`);
          }
          
          continue; // Retry without incrementing main retry count
        }
        
        // If we got a successful result or recoverable error, return it
        if (result.success || this.isRecoverableResult(result)) {
          return result;
        }
        
        // If this is a rate limit error, wait and retry
        if (this.isRateLimitResult(result)) {
          const waitTime = this.calculateBackoffTime(retryCount, 'rate_limit');
          logger.warn(`⏸️  Rate limit detected. Waiting ${waitTime / 1000} seconds before retry ${retryCount + 1}/${this.maxRetries}...`);
          await this.showCountdown(waitTime);
          retryCount++;
          continue;
        }
        
        // Other errors - increment retry count
        retryCount++;
        lastError = new Error(result.message || 'Unknown error');
        
        if (retryCount < this.maxRetries) {
          const waitTime = 2000 * retryCount; // Linear backoff for other errors
          logger.warn(`🔄 Retrying SDK execution (${retryCount}/${this.maxRetries}) in ${waitTime / 1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
      } catch (error: unknown) {
        lastError = error;
        const err = error as { message?: string; code?: string };
        
        // Check for rate limiting in exception
        if (this.isRateLimitError(err) && retryCount < this.maxRetries - 1) {
          const waitTime = this.calculateBackoffTime(retryCount, 'rate_limit');
          logger.warn(`⏸️  Rate limit exception. Waiting ${waitTime / 1000} seconds before retry ${retryCount + 1}/${this.maxRetries}...`);
          await this.showCountdown(waitTime);
          retryCount++;
          continue;
        }

        retryCount++;
        if (retryCount < this.maxRetries) {
          const waitTime = 2000 * retryCount;
          logger.warn(`🔄 Retrying SDK execution after exception (${retryCount}/${this.maxRetries}) in ${waitTime / 1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`SDK execution failed after ${this.maxRetries + maxTurnsCount} attempts. Last error: ${errorMessage}`);
  }

  /**
   * Execute a specific migration phase with enhanced context
   */
  async executePhase(phase: MigrationPhase, context: MigrationContext): Promise<SDKPhaseResult> {
    logger.info(`🔄 Executing migration phase: ${phase}`);
    
    // Start phase metrics tracking
    context.metricsCollector?.startPhase(phase);
    
    const phasePrompt = this.buildPhasePrompt(phase, context);
    const options = this.getPhaseOptions(phase, context);
    
    try {
      const result = await this.executePrompt(phasePrompt, options, context);
      
      // End phase metrics tracking
      context.metricsCollector?.endPhase(phase, result);
      
      // Update session manager
      if (result.sessionId) {
        context.sessionManager?.setSessionForPhase(phase, result.sessionId);
      }
      
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      context.metricsCollector?.addError(phase, errorMsg);
      
      return {
        success: false,
        message: `Phase ${phase} failed: ${errorMsg}`,
        error: error as Error
      };
    }
  }

  /**
   * Continue an existing session
   */
  async continueSession(
    sessionId: string, 
    prompt: string, 
    context: MigrationContext
  ): Promise<SDKPhaseResult> {
    logger.info(`🔄 Continuing session: ${sessionId}`);
    
    const options: SDKMigrationOptions = {
      maxTurns: 10,
      resumeSessionId: sessionId,
      outputFormat: 'json'
    };
    
    return await this.executePrompt(prompt, options, context);
  }

  /**
   * Get metrics for a specific session
   */
  async getSessionMetrics(sessionId: string): Promise<PhaseMetrics> {
    // Note: This would need to be implemented based on SDK capabilities
    // For now, return default metrics
    return {
      cost: 0,
      duration: 0,
      turns: 0,
      attempts: 1,
      success: true,
      sessionId,
      errors: []
    };
  }

  /**
   * Execute prompt using the Claude Code SDK with improved error handling
   */
  private async executePromptWithSDK(
    prompt: string,
    options: SDKMigrationOptions,
    context: MigrationContext
  ): Promise<SDKPhaseResult> {
    const messages: SDKMessage[] = [];
    let result: SDKPhaseResult = {
      success: false,
      message: 'No result received'
    };

    try {
      // Validate environment before attempting SDK operations
      validateClaudeSDKEnvironment();
      
      // Safely import Claude SDK
      const claudeModule = await importClaudeSDK();
      const { query } = claudeModule;
      
      logger.info('🔄 Starting Claude SDK query...');
      
      for await (const message of query({
        prompt,
        abortController: context.abortController || new AbortController(),
        options: {
          maxTurns: options.maxTurns,
          model: options.model || 'claude-sonnet-4-20250514', // Default to sonnet-4
          systemPrompt: options.systemPrompt,
          outputFormat: options.outputFormat || 'json',
          permissionMode: options.permissionMode || 'acceptEdits',
          ...(options.allowedTools && { allowedTools: options.allowedTools }),
          ...(options.resumeSessionId && { resumeSessionId: options.resumeSessionId })
        },
        cwd: context.repoPath
      })) {
        messages.push(message);
        
        // Process different message types
        if (message.type === 'result') {
          const isSuccess = message.subtype === 'success';
          const isPartialSuccess = this.isRecoverableError(message.subtype);
          
          result = {
            success: isSuccess || isPartialSuccess,
            message: this.getResultMessage(message, isSuccess, isPartialSuccess),
            sessionId: message.session_id,
            cost: message.total_cost_usd,
            duration: message.duration_ms,
            turns: message.num_turns,
            shouldContinue: message.subtype === 'error_max_turns' || isPartialSuccess
          };
          
          // Extract result content if available
          if ('result' in message && message.result) {
            result.message = message.result;
          }
          
          // Log specific error types for debugging
          if (!isSuccess) {
            logger.warn(`⚠️  Claude SDK returned: ${message.subtype}`);
            if (isPartialSuccess) {
              logger.info('ℹ️  Treating as partial success - migration will continue');
            }
          }
        }
        
        // Handle streaming progress updates
        if (message.type === 'assistant' || message.type === 'user') {
          logger.debug(`📝 ${message.type} message in session ${message.session_id || 'unknown'}`);
        }
        
        // Handle error messages during execution
        if (message.type === 'error') {
          logger.warn(`⚠️  SDK error message: ${JSON.stringify(message)}`);
        }
      }
      
      logger.info(`✅ SDK execution completed. Cost: $${result.cost?.toFixed(4) || '0'}, Duration: ${result.duration || 0}ms, Success: ${result.success}`);
      return result;
      
    } catch (error) {
      const err = error as Error;
      const contextualError = getSDKErrorContext(error);
      
      logger.error('❌ SDK execution failed:', contextualError);
      
      // Check if this is a recoverable error
      if (this.isRecoverableSDKError(error)) {
        logger.warn('⚠️  Treating SDK error as recoverable, migration will continue');
        return {
          success: true,
          message: `SDK execution completed with recoverable error: ${contextualError}`,
          shouldContinue: true,
          warnings: [contextualError]
        };
      }
      
      return {
        success: false,
        message: `SDK execution failed: ${contextualError}`,
        error: err
      };
    }
  }

  /**
   * Check if an error subtype is recoverable (partial success)
   */
  private isRecoverableError(subtype?: string): boolean {
    if (!subtype) return false;
    
    const recoverableErrors = [
      'error_during_execution',  // Some work was done, but hit an issue
      'error_max_turns',         // Hit turn limit but made progress
      'partial_success',         // Explicitly partial success
      'timeout_with_progress'    // Timeout but some work completed
    ];
    
    return recoverableErrors.includes(subtype);
  }

  /**
   * Check if an SDK error is recoverable
   */
  private isRecoverableSDKError(error: unknown): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    const recoverablePatterns = [
      'partial completion',
      'some changes applied',
      'timeout with progress',
      'interrupted but functional'
    ];
    
    return recoverablePatterns.some(pattern => 
      errorMessage.toLowerCase().includes(pattern)
    );
  }

  /**
   * Get appropriate result message based on success type
   */
  private getResultMessage(message: SDKMessage, isSuccess: boolean, isPartialSuccess: boolean): string {
    if (isSuccess) {
      return 'Operation completed successfully';
    }
    
    if (isPartialSuccess) {
      return `Operation partially completed: ${message.subtype} - continuing migration`;
    }
    
    return `Operation failed: ${message.subtype}`;
  }

  /**
   * Build phase-specific prompts
   */
  private buildPhasePrompt(phase: MigrationPhase, context: MigrationContext): string {
    const basePrompt = context.claudePrompts.get(phase) || this.getDefaultPhasePrompt(phase, context);
    
    return `# ElizaOS V1→V2 Migration: ${phase}

Plugin: ${context.pluginName}
Phase: ${phase}

${basePrompt}

Please execute this migration phase following the ElizaOS V2 patterns exactly.

IMPORTANT: If you encounter any errors during execution, continue with as much work as possible and document what was completed.`;
  }

  /**
   * Get phase-specific options
   */
  private getPhaseOptions(phase: MigrationPhase, context: MigrationContext): SDKMigrationOptions {
    const baseOptions: SDKMigrationOptions = {
      maxTurns: 15,
      model: 'claude-sonnet-4-20250514', // Default to Sonnet
      outputFormat: 'json',
      permissionMode: 'acceptEdits'
    };

    // Customize options based on phase complexity
    switch (phase) {
      case 'file-structure-migration':
        return { ...baseOptions, maxTurns: 10, model: 'claude-sonnet-4-20250514' };
      case 'actions-migration':
        return { ...baseOptions, maxTurns: 20, model: 'claude-opus-4-20250514' }; // Complex migrations use Opus
      case 'testing-infrastructure':
        return { ...baseOptions, maxTurns: 25, model: 'claude-opus-4-20250514' }; // Test generation uses Opus
      case 'core-structure-migration':
        return { ...baseOptions, maxTurns: 15, model: 'claude-opus-4-20250514' }; // Architecture changes use Opus
      default:
        return baseOptions;
    }
  }

  /**
   * Get default prompt for phases that don't have custom prompts
   */
  private getDefaultPhasePrompt(phase: MigrationPhase, context: MigrationContext): string {
    return `Execute the ${phase} phase for the ${context.pluginName} plugin migration from V1 to V2.`;
  }

  /**
   * Check if error is rate limit related
   */
  private isRateLimitError(error: { message?: string; code?: string }): boolean {
    const errorMessage = error.message || '';
    return errorMessage.includes('rate limit') ||
           errorMessage.includes('429') ||
           errorMessage.includes('too many requests') ||
           errorMessage.includes('quota exceeded') ||
           error.code === '429';
  }

  /**
   * Show countdown timer
   */
  private async showCountdown(waitTime: number): Promise<void> {
    const seconds = Math.ceil(waitTime / 1000);
    for (let i = seconds; i > 0; i--) {
      process.stdout.write(`\r⏱️  Resuming in ${i} seconds...  `);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    process.stdout.write('\r\n');
  }

  /**
   * Calculate exponential backoff time based on attempt and error type
   */
  private calculateBackoffTime(attempt: number, errorType: string): number {
    const baseDelays = {
      rate_limit: 60000, // 1 minute base for rate limits
      max_turns: 120000, // 2 minutes base for max turns (conversation limits)
      general: 2000      // 2 seconds base for general errors
    };
    
    const baseDelay = baseDelays[errorType as keyof typeof baseDelays] || baseDelays.general;
    
    // Exponential backoff with jitter
    const exponentialDelay = baseDelay * (2 ** (attempt - 1));
    const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
    const totalDelay = exponentialDelay + jitter;
    
    // Cap maximum wait time
    const maxDelays = {
      rate_limit: 900000,  // 15 minutes max for rate limits
      max_turns: 600000,   // 10 minutes max for conversation limits  
      general: 30000       // 30 seconds max for general errors
    };
    
    const maxDelay = maxDelays[errorType as keyof typeof maxDelays] || maxDelays.general;
    return Math.min(totalDelay, maxDelay);
  }

  /**
   * Check if a result indicates a recoverable error that should continue migration
   */
  private isRecoverableResult(result: SDKPhaseResult): boolean {
    if (!result.message) return false;
    
    const recoverablePatterns = [
      'partial completion',
      'some changes applied', 
      'timeout with progress',
      'interrupted but functional',
      'error_during_execution', // Some work was done
      'partial_success'
    ];
    
    return recoverablePatterns.some(pattern => 
      result.message.toLowerCase().includes(pattern)
    ) || result.shouldContinue === true;
  }

  /**
   * Check if a result indicates a rate limit error
   */
  private isRateLimitResult(result: SDKPhaseResult): boolean {
    if (!result.message) return false;
    
    const rateLimitPatterns = [
      'rate limit',
      'too many requests', 
      'quota exceeded',
      'request limit',
      'usage limit',
      'throttled',
      '429',
      'rate_limit_exceeded'
    ];
    
    return rateLimitPatterns.some(pattern => 
      result.message.toLowerCase().includes(pattern)
    );
  }
}

/**
 * Create metrics collector
 */
export function createMigrationMetricsCollector(): MigrationMetricsCollector {
  const metrics = {
    totalCost: 0,
    totalDuration: 0,
    totalTurns: 0,
    phaseMetrics: new Map(),
    errorCount: 0,
    sessionsUsed: [],
    startTime: new Date()
  };

  return {
    metrics,
    
    startPhase(phase: MigrationPhase) {
      if (!this.metrics.phaseMetrics.has(phase)) {
        this.metrics.phaseMetrics.set(phase, {
          cost: 0,
          duration: 0,
          turns: 0,
          attempts: 0,
          success: false,
          errors: []
        });
      }
    },
    
    endPhase(phase: MigrationPhase, result: SDKPhaseResult) {
      const phaseMetric = this.metrics.phaseMetrics.get(phase);
      if (!phaseMetric) {
        logger.warn(`Phase metrics not found for ${phase}, creating new entry`);
        this.startPhase(phase);
        return this.endPhase(phase, result);
      }
      
      phaseMetric.cost += result.cost || 0;
      phaseMetric.duration += result.duration || 0;
      phaseMetric.turns += result.turns || 0;
      phaseMetric.attempts++;
      phaseMetric.success = result.success;
      
      if (result.sessionId) {
        phaseMetric.sessionId = result.sessionId;
        if (!this.metrics.sessionsUsed.includes(result.sessionId)) {
          this.metrics.sessionsUsed.push(result.sessionId);
        }
      }
      
      this.metrics.totalCost += result.cost || 0;
      this.metrics.totalDuration += result.duration || 0;
      this.metrics.totalTurns += result.turns || 0;
    },
    
    addError(phase: MigrationPhase, error: string) {
      const phaseMetric = this.metrics.phaseMetrics.get(phase);
      if (phaseMetric) {
        phaseMetric.errors.push(error);
      }
      this.metrics.errorCount++;
    },
    
    getTotalCost() {
      return this.metrics.totalCost;
    },
    
    getTotalDuration() {
      return this.metrics.totalDuration;
    },
    
    getPhaseReport(phase: MigrationPhase) {
      return this.metrics.phaseMetrics.get(phase);
    },
    
    getFullReport() {
      this.metrics.endTime = new Date();
      return this.metrics;
    }
  };
}

/**
 * Create session manager
 */
export function createSessionManager(): SessionManager {
  const activeSessions = new Map<MigrationPhase, string>();
  
  return {
    activeSessions,
    
    getSessionForPhase(phase: MigrationPhase) {
      return activeSessions.get(phase);
    },
    
    setSessionForPhase(phase: MigrationPhase, sessionId: string) {
      activeSessions.set(phase, sessionId);
    },
    
    clearSession(phase: MigrationPhase) {
      activeSessions.delete(phase);
    },
    
    getAllSessions() {
      const sessions: Record<string, string> = {};
      for (const [phase, sessionId] of activeSessions.entries()) {
        sessions[phase] = sessionId;
      }
      return sessions;
    }
  };
} 