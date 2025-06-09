import { logger } from '@elizaos/core';
import type { 
  MigrationError, 
  MigrationContext, 
  StepResult,
  MigrationPhase 
} from './types.js';
import { ERROR_PATTERNS } from './config.js';

/**
 * Centralized error handling for the migration system
 */
export class MigrationErrorHandler {
  private context: MigrationContext;
  private errorHistory: MigrationError[] = [];

  constructor(context: MigrationContext) {
    this.context = context;
  }

  /**
   * Record an error during migration
   */
  recordError(error: Partial<MigrationError>): void {
    const migrationError: MigrationError = {
      type: error.type || 'unknown' as any,
      severity: error.severity || 'medium',
      message: error.message || 'Unknown error',
      file: error.file,
      line: error.line,
      phase: error.phase,
      step: error.step,
      timestamp: Date.now(),
      fixed: false,
    };

    this.errorHistory.push(migrationError);
    this.context.errors.push(migrationError);

    // Log based on severity
    switch (migrationError.severity) {
      case 'critical':
        logger.error(`🚨 Critical error: ${migrationError.message}`);
        break;
      case 'high':
        logger.warn(`⚠️  High priority error: ${migrationError.message}`);
        break;
      case 'medium':
        logger.warn(`⚠️  Warning: ${migrationError.message}`);
        break;
      case 'low':
        logger.info(`ℹ️  Notice: ${migrationError.message}`);
        break;
    }
  }

  /**
   * Mark an error as fixed
   */
  markErrorFixed(errorIndex: number): void {
    if (errorIndex >= 0 && errorIndex < this.errorHistory.length) {
      this.errorHistory[errorIndex].fixed = true;
      this.context.errors[errorIndex].fixed = true;
    }
  }

  /**
   * Analyze error output and categorize it
   */
  analyzeErrorOutput(output: string, phase?: MigrationPhase, step?: string): MigrationError[] {
    const errors: MigrationError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Check for build errors
      for (const pattern of ERROR_PATTERNS.BUILD) {
        if (pattern.test(line)) {
          const fileMatch = line.match(/(\S+\.ts)\((\d+),\d+\):/);
          errors.push({
            type: 'build',
            severity: 'critical',
            message: line.trim(),
            file: fileMatch?.[1],
            line: fileMatch?.[2] ? parseInt(fileMatch[2]) : undefined,
            phase,
            step,
            timestamp: Date.now(),
            fixed: false,
          });
          break;
        }
      }

      // Check for test errors
      for (const pattern of ERROR_PATTERNS.TEST) {
        if (pattern.test(line)) {
          errors.push({
            type: 'test',
            severity: 'high',
            message: line.trim(),
            phase,
            step,
            timestamp: Date.now(),
            fixed: false,
          });
          break;
        }
      }

      // Check for Zod validation errors
      for (const pattern of ERROR_PATTERNS.ZOD) {
        if (pattern.test(line)) {
          errors.push({
            type: 'validation',
            severity: 'high',
            message: line.trim(),
            phase,
            step,
            timestamp: Date.now(),
            fixed: false,
          });
          break;
        }
      }

      // Check for environment variable errors
      for (const pattern of ERROR_PATTERNS.ENV) {
        if (pattern.test(line)) {
          errors.push({
            type: 'validation',
            severity: 'medium',
            message: line.trim(),
            phase,
            step,
            timestamp: Date.now(),
            fixed: false,
          });
          break;
        }
      }
    }

    // Record all found errors
    for (const error of errors) {
      this.recordError(error);
    }

    return errors;
  }

  /**
   * Get unresolved errors by type
   */
  getUnresolvedErrors(type?: MigrationError['type']): MigrationError[] {
    const unresolved = this.errorHistory.filter(error => !error.fixed);
    return type ? unresolved.filter(error => error.type === type) : unresolved;
  }

  /**
   * Get critical errors that block migration
   */
  getCriticalErrors(): MigrationError[] {
    return this.getUnresolvedErrors().filter(error => error.severity === 'critical');
  }

  /**
   * Check if migration can continue based on error state
   */
  canContinue(): boolean {
    const criticalErrors = this.getCriticalErrors();
    return criticalErrors.length === 0;
  }

  /**
   * Generate error summary
   */
  getErrorSummary(): {
    total: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
    unresolved: number;
  } {
    const summary = {
      total: this.errorHistory.length,
      byType: {} as Record<string, number>,
      bySeverity: {} as Record<string, number>,
      unresolved: this.getUnresolvedErrors().length,
    };

    for (const error of this.errorHistory) {
      summary.byType[error.type] = (summary.byType[error.type] || 0) + 1;
      summary.bySeverity[error.severity] = (summary.bySeverity[error.severity] || 0) + 1;
    }

    return summary;
  }

  /**
   * Generate recovery suggestions based on error patterns
   */
  getRecoverySuggestions(): string[] {
    const suggestions: string[] = [];
    const unresolvedErrors = this.getUnresolvedErrors();

    const buildErrors = unresolvedErrors.filter(e => e.type === 'build');
    const testErrors = unresolvedErrors.filter(e => e.type === 'test');
    const validationErrors = unresolvedErrors.filter(e => e.type === 'validation');

    if (buildErrors.length > 0) {
      suggestions.push('Run: bun run build to see detailed build errors');
      suggestions.push('Check import statements and ensure all dependencies are installed');
      suggestions.push('Verify TypeScript configuration is correct');
    }

    if (testErrors.length > 0) {
      suggestions.push('Run: bun run test to see detailed test failures');
      suggestions.push('Check that test environment variables are set correctly');
      suggestions.push('Ensure test files follow V2 structure (src/test/ not __tests__/)');
    }

    if (validationErrors.length > 0) {
      suggestions.push('Check Zod schema validation - ensure all required fields have proper types');
      suggestions.push('Verify environment variables are properly configured');
      suggestions.push('Use z.coerce.number() for numeric environment variables');
    }

    if (suggestions.length === 0) {
      suggestions.push('Review migration logs for specific error details');
      suggestions.push('Check the repository structure matches V2 requirements');
    }

    return suggestions;
  }

  /**
   * Create a StepResult from current error state
   */
  createStepResult(
    success: boolean, 
    message: string, 
    changes?: string[]
  ): StepResult {
    const unresolvedErrors = this.getUnresolvedErrors();
    const warnings = unresolvedErrors.map(error => error.message);

    return {
      success: success && unresolvedErrors.length === 0,
      message,
      changes,
      warnings: warnings.length > 0 ? warnings : undefined,
      error: unresolvedErrors.length > 0 ? new Error(unresolvedErrors[0].message) : undefined,
      retryable: !this.getCriticalErrors().length,
    };
  }

  /**
   * Log error summary at the end of migration
   */
  logFinalSummary(): void {
    const summary = this.getErrorSummary();
    
    logger.info('\n📊 Error Summary:');
    logger.info(`- Total errors encountered: ${summary.total}`);
    logger.info(`- Unresolved errors: ${summary.unresolved}`);
    
    if (summary.total > 0) {
      logger.info('- By type:');
      for (const [type, count] of Object.entries(summary.byType)) {
        logger.info(`  - ${type}: ${count}`);
      }
      
      logger.info('- By severity:');
      for (const [severity, count] of Object.entries(summary.bySeverity)) {
        logger.info(`  - ${severity}: ${count}`);
      }
    }

    if (summary.unresolved > 0) {
      logger.warn('\n⚠️  Unresolved Issues:');
      const suggestions = this.getRecoverySuggestions();
      for (const suggestion of suggestions) {
        logger.warn(`  - ${suggestion}`);
      }
    }
  }
} 