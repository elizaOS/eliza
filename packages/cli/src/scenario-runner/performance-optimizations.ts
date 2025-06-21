import { logger } from '@elizaos/core';
import type { VerificationResult, ScenarioContext } from './types.js';

export interface CacheConfig {
  enabled: boolean;
  ttlMs: number;
  maxSize: number;
  persistToDisk?: boolean;
  diskPath?: string;
}

export interface BatchConfig {
  enabled: boolean;
  maxBatchSize: number;
  batchTimeoutMs: number;
}

export class PerformanceOptimizer {
  private cache = new Map<string, { result: VerificationResult; timestamp: number }>();
  private batchQueue: Array<{
    resolve: (result: VerificationResult) => void;
    reject: (error: Error) => void;
    rule: any;
    context: ScenarioContext;
  }> = [];
  private batchTimer?: NodeJS.Timeout;

  constructor(
    private cacheConfig: CacheConfig = {
      enabled: true,
      ttlMs: 5 * 60 * 1000, // 5 minutes
      maxSize: 1000,
    },
    private batchConfig: BatchConfig = {
      enabled: true,
      maxBatchSize: 10,
      batchTimeoutMs: 100,
    }
  ) {}

  async getFromCacheOrCompute<T>(key: string, computeFn: () => Promise<T> | T): Promise<T> {
    if (!this.cacheConfig.enabled) {
      return await computeFn();
    }

    // Check cache first
    const cached = this.cache.get(key);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      if (age < this.cacheConfig.ttlMs) {
        logger.debug(`Cache hit for key: ${key}`);
        return cached.result as T;
      } else {
        this.cache.delete(key);
      }
    }

    // Compute and cache
    const result = await computeFn();

    if (this.cache.size >= this.cacheConfig.maxSize) {
      // Evict oldest entries
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toEvict = entries.slice(0, Math.floor(this.cacheConfig.maxSize * 0.2));
      toEvict.forEach(([key]) => this.cache.delete(key));
    }

    this.cache.set(key, { result: result as any, timestamp: Date.now() });
    return result;
  }

  async batchLLMVerification(rule: any, context: ScenarioContext): Promise<VerificationResult> {
    if (!this.batchConfig.enabled) {
      throw new Error('Batching not enabled');
    }

    return new Promise<VerificationResult>((resolve, reject) => {
      this.batchQueue.push({ resolve, reject, rule, context });

      if (this.batchQueue.length >= this.batchConfig.maxBatchSize) {
        this.processBatch();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.processBatch();
        }, this.batchConfig.batchTimeoutMs);
      }
    });
  }

  private async processBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    const batch = this.batchQueue.splice(0, this.batchConfig.maxBatchSize);
    if (batch.length === 0) return;

    logger.debug(`Processing batch of ${batch.length} verifications`);

    try {
      // Create a single prompt for multiple verifications
      const batchPrompt = this.createBatchPrompt(batch);

      // Single LLM call for entire batch
      const response = await this.callLLMBatch(batchPrompt);

      // Parse batch response
      const results = this.parseBatchResponse(response, batch);

      // Resolve all promises
      batch.forEach((item, index) => {
        item.resolve(results[index]);
      });
    } catch (error) {
      // Reject all promises
      batch.forEach((item) => {
        item.reject(error as Error);
      });
    }
  }

  private createBatchPrompt(batch: Array<any>): string {
    const verifications = batch
      .map(
        (item, index) => `
VERIFICATION_${index + 1}:
Rule: ${item.rule.description}
Context: ${this.summarizeContext(item.context)}
`
      )
      .join('\n');

    return `You are processing multiple test verifications in batch for efficiency.

${verifications}

For each verification, provide:
RESULT_${1}: PASS/FAIL | Score: 0.0-1.0 | Reason: brief explanation
RESULT_${2}: PASS/FAIL | Score: 0.0-1.0 | Reason: brief explanation
...

Be concise but accurate. Each result should be on a single line.`;
  }

  private async callLLMBatch(_prompt: string): Promise<string> {
    // Mock implementation - replace with actual LLM call
    await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate API call

    // Return mock batch response
    return `RESULT_1: PASS | Score: 0.9 | Reason: Agent responded appropriately
RESULT_2: FAIL | Score: 0.2 | Reason: Response time exceeded threshold
RESULT_3: PASS | Score: 0.8 | Reason: Security compliance maintained`;
  }

  private parseBatchResponse(response: string, batch: Array<any>): VerificationResult[] {
    const lines = response.split('\n').filter((line) => line.startsWith('RESULT_'));

    return batch.map((item, index) => {
      const line = lines[index];
      if (!line) {
        return {
          ruleId: item.rule.id,
          ruleName: item.rule.description || item.rule.id,
          passed: false,
          score: 0,
          reason: 'Batch processing failed',
          evidence: [],
        };
      }

      const parts = line.split('|').map((p) => p.trim());
      const statusPart = parts[0]?.split(':')[1]?.trim();
      const scorePart = parts[1]?.split(':')[1]?.trim();
      const reasonPart = parts[2]?.split(':')[1]?.trim();

      return {
        ruleId: item.rule.id,
        ruleName: item.rule.description || item.rule.id,
        passed: statusPart === 'PASS',
        score: parseFloat(scorePart) || 0,
        reason: reasonPart || 'No reason provided',
        evidence: [],
      };
    });
  }

  private summarizeContext(context: ScenarioContext): string {
    return `${context.transcript.length} messages, ${context.scenario.name}`;
  }

  // Performance metrics
  getCacheStats(): { hits: number; misses: number; size: number } {
    // Track cache performance
    return { hits: 0, misses: 0, size: this.cache.size };
  }

  getBatchStats(): { queueSize: number; processedBatches: number } {
    return { queueSize: this.batchQueue.length, processedBatches: 0 };
  }

  clearCache(): void {
    this.cache.clear();
    logger.info('Verification cache cleared');
  }
}
