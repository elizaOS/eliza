/**
 * Resource Limiter - Prevents OOM and System Crashes
 *
 * Monitors system resources during load tests and automatically
 * backs off or stops if memory/CPU gets too high
 */

import { logger } from '@babylon/shared';

export interface ResourceLimits {
  maxMemoryMB: number;
  maxMemoryPercent: number;
  maxConcurrentRequests: number;
  checkIntervalMs: number;
}

export const DEFAULT_LIMITS: ResourceLimits = {
  maxMemoryMB: 2048, // 2GB max
  maxMemoryPercent: 80, // 80% of heap
  maxConcurrentRequests: 5000, // Safety limit
  checkIntervalMs: 1000, // Check every second
};

export class ResourceLimiter {
  private limits: ResourceLimits;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private activeRequests = 0;
  private stopped = false;
  private onStopCallback?: () => void;

  constructor(limits: Partial<ResourceLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Start monitoring resources
   */
  start(onStop?: () => void): void {
    this.stopped = false;
    this.onStopCallback = onStop;

    this.checkInterval = setInterval(() => {
      this.checkResources();
    }, this.limits.checkIntervalMs);

    logger.info(
      'Resource limiter started',
      {
        maxMemoryMB: this.limits.maxMemoryMB,
        maxMemoryPercent: this.limits.maxMemoryPercent,
        maxConcurrentRequests: this.limits.maxConcurrentRequests,
      },
      'ResourceLimiter'
    );
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.stopped = false;

    logger.info('Resource limiter stopped', undefined, 'ResourceLimiter');
  }

  /**
   * Check if we can make another request
   */
  canMakeRequest(): boolean {
    if (this.stopped) {
      return false;
    }

    if (this.activeRequests >= this.limits.maxConcurrentRequests) {
      logger.warn(
        'Max concurrent requests reached',
        {
          active: this.activeRequests,
          max: this.limits.maxConcurrentRequests,
        },
        'ResourceLimiter'
      );
      return false;
    }

    return true;
  }

  /**
   * Track request start
   */
  requestStarted(): void {
    this.activeRequests++;
  }

  /**
   * Track request end
   */
  requestEnded(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  /**
   * Get current resource usage
   */
  getUsage(): {
    memoryMB: number;
    memoryPercent: number;
    activeRequests: number;
    stopped: boolean;
  } {
    const memUsage = process.memoryUsage();
    // Use RSS (total memory) for more accurate percentage
    const totalMemoryMB = memUsage.rss / 1024 / 1024;
    const systemMemoryGB = 8; // Assume 8GB system (adjust if needed)
    const systemMemoryMB = systemMemoryGB * 1024;

    return {
      memoryMB: totalMemoryMB,
      memoryPercent: (totalMemoryMB / systemMemoryMB) * 100,
      activeRequests: this.activeRequests,
      stopped: this.stopped,
    };
  }

  /**
   * Check resources and stop if limits exceeded
   */
  private checkResources(): void {
    const usage = this.getUsage();

    // Check memory usage
    if (usage.memoryMB > this.limits.maxMemoryMB) {
      logger.error(
        'Memory limit exceeded - stopping test',
        {
          currentMB: usage.memoryMB,
          limitMB: this.limits.maxMemoryMB,
        },
        'ResourceLimiter'
      );
      this.emergencyStop('Memory limit exceeded');
      return;
    }

    if (usage.memoryPercent > this.limits.maxMemoryPercent) {
      logger.error(
        'Memory percentage limit exceeded - stopping test',
        {
          currentPercent: usage.memoryPercent,
          limitPercent: this.limits.maxMemoryPercent,
        },
        'ResourceLimiter'
      );
      this.emergencyStop('Memory percentage limit exceeded');
      return;
    }

    // Warn if approaching limits
    if (usage.memoryPercent > this.limits.maxMemoryPercent * 0.9) {
      logger.warn(
        'Approaching memory limit',
        {
          currentPercent: usage.memoryPercent,
          limitPercent: this.limits.maxMemoryPercent,
        },
        'ResourceLimiter'
      );
    }
  }

  /**
   * Emergency stop
   */
  private emergencyStop(reason: string): void {
    if (this.stopped) return;

    this.stopped = true;

    logger.error(
      'EMERGENCY STOP - Test halted to prevent system crash',
      {
        reason,
        usage: this.getUsage(),
      },
      'ResourceLimiter'
    );

    if (this.onStopCallback) {
      this.onStopCallback();
    }

    this.stop();
  }

  /**
   * Check if stopped
   */
  isStopped(): boolean {
    return this.stopped;
  }
}
