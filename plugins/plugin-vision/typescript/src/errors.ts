import { logger } from '@elizaos/core';

// Base error class for all vision-related errors
export class VisionError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, any>;
  public readonly recoverable: boolean;

  constructor(message: string, code: string, recoverable = false, context?: Record<string, any>) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.recoverable = recoverable;
    this.context = context;

    // Ensure proper prototype chain
    Object.setPrototypeOf(this, VisionError.prototype);
  }
}

// Specific error types
export class CameraError extends VisionError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'CAMERA_ERROR', true, context);
    this.name = 'CameraError';
  }
}

export class ScreenCaptureError extends VisionError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'SCREEN_CAPTURE_ERROR', true, context);
    this.name = 'ScreenCaptureError';
  }
}

export class ModelInitializationError extends VisionError {
  constructor(message: string, modelName: string, context?: Record<string, any>) {
    super(message, 'MODEL_INIT_ERROR', false, { ...context, modelName });
    this.name = 'ModelInitializationError';
  }
}

export class ProcessingError extends VisionError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'PROCESSING_ERROR', true, context);
    this.name = 'ProcessingError';
  }
}

export class ConfigurationError extends VisionError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'CONFIG_ERROR', false, context);
    this.name = 'ConfigurationError';
  }
}

export class APIError extends VisionError {
  public readonly statusCode?: number;
  public readonly endpoint?: string;

  constructor(
    message: string,
    statusCode?: number,
    endpoint?: string,
    context?: Record<string, any>
  ) {
    super(message, 'API_ERROR', true, { ...context, statusCode, endpoint });
    this.name = 'APIError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}

// Error recovery strategies
export interface RecoveryStrategy {
  canRecover(error: VisionError): boolean;
  recover(error: VisionError): Promise<void>;
}

export class ErrorRecoveryManager {
  private strategies: Map<string, RecoveryStrategy> = new Map();
  private errorCounts: Map<string, number> = new Map();
  private readonly maxRetries = 3;

  constructor() {
    this.registerDefaultStrategies();
  }

  private registerDefaultStrategies(): void {
    // Camera recovery strategy
    this.registerStrategy('CAMERA_ERROR', {
      canRecover: (error) => {
        const count = this.errorCounts.get(error.code) || 0;
        return count < this.maxRetries;
      },
      recover: async (error) => {
        logger.warn('[ErrorRecovery] Attempting camera recovery:', error.message);
        // Wait before retry
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (this.errorCounts.get(error.code) || 1))
        );
        logger.info('[ErrorRecovery] Camera recovery attempt complete');
      },
    });

    // API recovery strategy
    this.registerStrategy('API_ERROR', {
      canRecover: (error) => {
        const apiError = error as APIError;
        // Don't retry on client errors (4xx)
        if (apiError.statusCode && apiError.statusCode >= 400 && apiError.statusCode < 500) {
          return false;
        }
        const count = this.errorCounts.get(`${error.code}_${apiError.endpoint}`) || 0;
        return count < this.maxRetries;
      },
      recover: async (error) => {
        const apiError = error as APIError;
        logger.warn('[ErrorRecovery] API error recovery:', error.message);
        // Exponential backoff
        const delay = Math.min(
          1000 * Math.pow(2, this.errorCounts.get(`${error.code}_${apiError.endpoint}`) || 0),
          30000
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      },
    });

    // Screen capture recovery
    this.registerStrategy('SCREEN_CAPTURE_ERROR', {
      canRecover: () => true,
      recover: async (error) => {
        logger.warn('[ErrorRecovery] Screen capture recovery:', error.message);
        // Brief pause before retry
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
    });
  }

  registerStrategy(errorCode: string, strategy: RecoveryStrategy): void {
    this.strategies.set(errorCode, strategy);
  }

  async handleError(error: VisionError): Promise<boolean> {
    logger.error(`[ErrorRecovery] Handling ${error.name}:`, error.message, error.context);

    // Track error occurrences
    const errorKey = error.code + (error.context?.endpoint || '');
    const currentCount = this.errorCounts.get(errorKey) || 0;
    this.errorCounts.set(errorKey, currentCount + 1);

    // Check if we can recover
    if (!error.recoverable) {
      logger.error('[ErrorRecovery] Error is not recoverable');
      return false;
    }

    const strategy = this.strategies.get(error.code);
    if (!strategy) {
      logger.warn('[ErrorRecovery] No recovery strategy for error code:', error.code);
      return false;
    }

    if (!strategy.canRecover(error)) {
      logger.error('[ErrorRecovery] Recovery strategy cannot handle this error');
      return false;
    }

    try {
      await strategy.recover(error);
      logger.info('[ErrorRecovery] Recovery successful');
      return true;
    } catch (recoveryError) {
      logger.error('[ErrorRecovery] Recovery failed:', recoveryError);
      return false;
    }
  }

  resetErrorCount(errorCode: string): void {
    this.errorCounts.delete(errorCode);
  }

  resetAllCounts(): void {
    this.errorCounts.clear();
  }
}

// Circuit breaker for external services
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private readonly threshold = 5,
    private readonly timeout = 60000, // 1 minute
    private readonly name: string
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'half-open';
        logger.info(`[CircuitBreaker] ${this.name} entering half-open state`);
      } else {
        throw new VisionError(
          `Circuit breaker is open for ${this.name}`,
          'CIRCUIT_BREAKER_OPEN',
          true
        );
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      logger.info(`[CircuitBreaker] ${this.name} recovered, closing circuit`);
    }
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.threshold) {
      this.state = 'open';
      logger.error(`[CircuitBreaker] ${this.name} threshold exceeded, opening circuit`);
    }
  }

  getState(): string {
    return this.state;
  }

  reset(): void {
    this.failures = 0;
    this.state = 'closed';
    logger.info(`[CircuitBreaker] ${this.name} reset`);
  }
}

// Global error handler
export class VisionErrorHandler {
  private static instance: VisionErrorHandler;
  private recoveryManager: ErrorRecoveryManager;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();

  private constructor() {
    this.recoveryManager = new ErrorRecoveryManager();
  }

  static getInstance(): VisionErrorHandler {
    if (!VisionErrorHandler.instance) {
      VisionErrorHandler.instance = new VisionErrorHandler();
    }
    return VisionErrorHandler.instance;
  }

  getCircuitBreaker(name: string, threshold = 5, timeout = 60000): CircuitBreaker {
    if (!this.circuitBreakers.has(name)) {
      this.circuitBreakers.set(name, new CircuitBreaker(threshold, timeout, name));
    }
    return this.circuitBreakers.get(name)!;
  }

  async handle(error: any): Promise<boolean> {
    // Convert to VisionError if needed
    if (!(error instanceof VisionError)) {
      error = new ProcessingError(error.message || 'Unknown error', { originalError: error });
    }

    return this.recoveryManager.handleError(error);
  }

  resetCircuitBreaker(name: string): void {
    const breaker = this.circuitBreakers.get(name);
    if (breaker) {
      breaker.reset();
    }
  }

  resetAllCircuitBreakers(): void {
    this.circuitBreakers.forEach((breaker) => breaker.reset());
  }
}
