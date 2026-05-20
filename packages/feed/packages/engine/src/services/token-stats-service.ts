/**
 * Token Statistics Service
 *
 * @description Collects and aggregates LLM token usage statistics during game ticks.
 * Provides per-tick statistics, historical summaries, and cost estimates.
 *
 * Usage:
 * 1. Call TokenStatsService.startTick() at the beginning of a game tick
 * 2. LLM calls will automatically report usage via the global callback
 * 3. Call TokenStatsService.endTick() to finalize and store statistics
 * 4. Use TokenStatsService.getStats() to query historical data
 */

import { logger } from '@babylon/shared';
import { setTokenUsageCallback } from '../llm/openai-client';
import {
  calculateEstimatedCost,
  type LLMCallTokenUsage,
  type LLMProviderName,
  type ModelStats,
  type PromptTypeStats,
  type TickTokenStats,
  type TokenStatsSummary,
  type TokenUsageCollector,
} from '../types/token-stats';

/**
 * Internal collector for a single tick
 */
class TickUsageCollector implements TokenUsageCollector {
  private calls: LLMCallTokenUsage[] = [];

  recordCall(usage: Omit<LLMCallTokenUsage, 'callId' | 'timestamp'>): void {
    const call: LLMCallTokenUsage = {
      ...usage,
      callId: `call-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date(),
    };
    this.calls.push(call);

    logger.debug(
      'Token usage recorded',
      {
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        promptType: usage.promptType,
        success: usage.success,
      },
      'TokenStatsService'
    );
  }

  getCalls(): LLMCallTokenUsage[] {
    return [...this.calls];
  }

  getStats(): Omit<
    TickTokenStats,
    'tickId' | 'tickStartedAt' | 'tickCompletedAt' | 'tickDurationMs'
  > {
    const calls = this.calls;

    // Calculate totals
    const totalCalls = calls.length;
    const totalInputTokens = calls.reduce((sum, c) => sum + c.inputTokens, 0);
    const totalOutputTokens = calls.reduce((sum, c) => sum + c.outputTokens, 0);
    const totalTokens = totalInputTokens + totalOutputTokens;

    // Aggregate by prompt type
    const promptTypeMap = new Map<
      string,
      {
        calls: LLMCallTokenUsage[];
        totalInput: number;
        totalOutput: number;
        totalDuration: number;
        successCount: number;
      }
    >();

    for (const call of calls) {
      const existing = promptTypeMap.get(call.promptType) ?? {
        calls: [],
        totalInput: 0,
        totalOutput: 0,
        totalDuration: 0,
        successCount: 0,
      };
      existing.calls.push(call);
      existing.totalInput += call.inputTokens;
      existing.totalOutput += call.outputTokens;
      existing.totalDuration += call.durationMs;
      if (call.success) existing.successCount++;
      promptTypeMap.set(call.promptType, existing);
    }

    const byPromptType: PromptTypeStats[] = Array.from(
      promptTypeMap.entries()
    ).map(([promptType, data]) => ({
      promptType,
      callCount: data.calls.length,
      totalInputTokens: data.totalInput,
      totalOutputTokens: data.totalOutput,
      totalTokens: data.totalInput + data.totalOutput,
      avgInputTokens:
        data.calls.length > 0
          ? Math.round(data.totalInput / data.calls.length)
          : 0,
      avgOutputTokens:
        data.calls.length > 0
          ? Math.round(data.totalOutput / data.calls.length)
          : 0,
      avgDurationMs:
        data.calls.length > 0
          ? Math.round(data.totalDuration / data.calls.length)
          : 0,
      successRate:
        data.calls.length > 0 ? data.successCount / data.calls.length : 0,
    }));

    // Aggregate by model
    const modelMap = new Map<
      string,
      {
        provider: LLMProviderName;
        calls: LLMCallTokenUsage[];
        totalInput: number;
        totalOutput: number;
        successCount: number;
      }
    >();

    for (const call of calls) {
      const key = `${call.provider}:${call.model}`;
      const existing = modelMap.get(key) ?? {
        provider: call.provider,
        calls: [],
        totalInput: 0,
        totalOutput: 0,
        successCount: 0,
      };
      existing.calls.push(call);
      existing.totalInput += call.inputTokens;
      existing.totalOutput += call.outputTokens;
      if (call.success) existing.successCount++;
      modelMap.set(key, existing);
    }

    const byModel: ModelStats[] = Array.from(modelMap.entries()).map(
      ([key, data]) => {
        const [, model] = key.split(':');
        return {
          provider: data.provider,
          model: model ?? 'unknown',
          callCount: data.calls.length,
          totalInputTokens: data.totalInput,
          totalOutputTokens: data.totalOutput,
          totalTokens: data.totalInput + data.totalOutput,
          avgTokensPerCall:
            data.calls.length > 0
              ? Math.round(
                  (data.totalInput + data.totalOutput) / data.calls.length
                )
              : 0,
          successRate:
            data.calls.length > 0 ? data.successCount / data.calls.length : 0,
        };
      }
    );

    return {
      totalCalls,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      byPromptType,
      byModel,
      calls,
    };
  }

  reset(): void {
    this.calls = [];
  }
}

/**
 * Token Statistics Service
 * Manages token usage collection and aggregation across game ticks
 */
class TokenStatsServiceImpl {
  private currentCollector: TickUsageCollector | null = null;
  private tickStartTime: Date | null = null;
  private currentTickId: string | null = null;
  private isCollecting = false;

  // In-memory storage for recent ticks (for quick access without DB)
  private recentTicks: TickTokenStats[] = [];
  private readonly MAX_RECENT_TICKS = 100;

  /**
   * Start collecting token usage for a new tick
   * @param tickId Optional tick identifier (auto-generated if not provided)
   */
  startTick(tickId?: string): string {
    if (this.isCollecting) {
      logger.warn(
        'TokenStatsService: startTick called while already collecting. Ending previous tick.',
        undefined,
        'TokenStatsService'
      );
      this.endTick();
    }

    const id = tickId ?? `tick-${Date.now()}`;
    this.currentCollector = new TickUsageCollector();
    this.tickStartTime = new Date();
    this.currentTickId = id;
    this.isCollecting = true;

    // Register the global callback to collect usage from all LLM calls
    setTokenUsageCallback((usage) => {
      if (this.currentCollector && this.isCollecting) {
        this.currentCollector.recordCall(usage);
      }
    });

    logger.info(
      'Token stats collection started',
      { tickId: id },
      'TokenStatsService'
    );

    return id;
  }

  /**
   * End collection for the current tick and return statistics
   * @returns Complete tick statistics or null if no tick was in progress
   */
  endTick(): TickTokenStats | null {
    if (
      !this.isCollecting ||
      !this.currentCollector ||
      !this.tickStartTime ||
      !this.currentTickId
    ) {
      logger.warn(
        'TokenStatsService: endTick called but no tick in progress',
        undefined,
        'TokenStatsService'
      );
      return null;
    }

    const tickCompletedAt = new Date();
    const tickDurationMs =
      tickCompletedAt.getTime() - this.tickStartTime.getTime();

    const stats = this.currentCollector.getStats();

    const tickStats: TickTokenStats = {
      tickId: this.currentTickId,
      tickStartedAt: this.tickStartTime,
      tickCompletedAt,
      tickDurationMs,
      ...stats,
    };

    // Store in recent ticks
    this.recentTicks.unshift(tickStats);
    if (this.recentTicks.length > this.MAX_RECENT_TICKS) {
      this.recentTicks.pop();
    }

    // Clear the global callback
    setTokenUsageCallback(null);

    // Reset state
    this.currentCollector = null;
    this.tickStartTime = null;
    this.currentTickId = null;
    this.isCollecting = false;

    logger.info(
      'Token stats collection ended',
      {
        tickId: tickStats.tickId,
        totalCalls: tickStats.totalCalls,
        totalTokens: tickStats.totalTokens,
        inputTokens: tickStats.totalInputTokens,
        outputTokens: tickStats.totalOutputTokens,
        durationMs: tickDurationMs,
      },
      'TokenStatsService'
    );

    return tickStats;
  }

  /**
   * Get the current tick's statistics (while tick is in progress)
   * @returns Current statistics or null if no tick in progress
   */
  getCurrentStats(): Omit<
    TickTokenStats,
    'tickId' | 'tickCompletedAt' | 'tickDurationMs'
  > | null {
    if (!this.isCollecting || !this.currentCollector || !this.tickStartTime) {
      return null;
    }

    const stats = this.currentCollector.getStats();
    return {
      tickStartedAt: this.tickStartTime,
      ...stats,
    };
  }

  /**
   * Get recent tick statistics from memory
   * @param limit Maximum number of ticks to return
   * @returns Array of recent tick statistics
   */
  getRecentTicks(limit = 10): TickTokenStats[] {
    return this.recentTicks.slice(0, limit);
  }

  /**
   * Get aggregated summary for recent ticks
   * @param limit Number of recent ticks to include in summary
   * @returns Aggregated summary statistics
   */
  getSummary(limit = 10): TokenStatsSummary | null {
    const ticks = this.recentTicks.slice(0, limit);

    if (ticks.length === 0) {
      return null;
    }

    const periodStart = ticks[ticks.length - 1]?.tickStartedAt ?? new Date();
    const periodEnd = ticks[0]?.tickCompletedAt ?? new Date();

    // Aggregate totals
    const totalCalls = ticks.reduce((sum, t) => sum + t.totalCalls, 0);
    const totalInputTokens = ticks.reduce(
      (sum, t) => sum + t.totalInputTokens,
      0
    );
    const totalOutputTokens = ticks.reduce(
      (sum, t) => sum + t.totalOutputTokens,
      0
    );
    const totalTokens = totalInputTokens + totalOutputTokens;

    // Calculate averages
    const tickCount = ticks.length;
    const avgCallsPerTick = Math.round(totalCalls / tickCount);
    const avgInputTokensPerTick = Math.round(totalInputTokens / tickCount);
    const avgOutputTokensPerTick = Math.round(totalOutputTokens / tickCount);
    const avgTotalTokensPerTick = Math.round(totalTokens / tickCount);

    // Aggregate by prompt type
    const promptTypeMap = new Map<string, PromptTypeStats>();
    for (const tick of ticks) {
      for (const pt of tick.byPromptType) {
        const existing = promptTypeMap.get(pt.promptType);
        if (existing) {
          existing.callCount += pt.callCount;
          existing.totalInputTokens += pt.totalInputTokens;
          existing.totalOutputTokens += pt.totalOutputTokens;
          existing.totalTokens += pt.totalTokens;
        } else {
          promptTypeMap.set(pt.promptType, { ...pt });
        }
      }
    }

    // Recalculate averages for prompt types
    const byPromptType = Array.from(promptTypeMap.values()).map((pt) => ({
      ...pt,
      avgInputTokens:
        pt.callCount > 0 ? Math.round(pt.totalInputTokens / pt.callCount) : 0,
      avgOutputTokens:
        pt.callCount > 0 ? Math.round(pt.totalOutputTokens / pt.callCount) : 0,
    }));

    // Aggregate by model
    const modelMap = new Map<string, ModelStats>();
    for (const tick of ticks) {
      for (const m of tick.byModel) {
        const key = `${m.provider}:${m.model}`;
        const existing = modelMap.get(key);
        if (existing) {
          existing.callCount += m.callCount;
          existing.totalInputTokens += m.totalInputTokens;
          existing.totalOutputTokens += m.totalOutputTokens;
          existing.totalTokens += m.totalTokens;
        } else {
          modelMap.set(key, { ...m });
        }
      }
    }

    // Recalculate averages for models
    const byModel = Array.from(modelMap.values()).map((m) => ({
      ...m,
      avgTokensPerCall:
        m.callCount > 0 ? Math.round(m.totalTokens / m.callCount) : 0,
    }));

    // Calculate estimated costs
    let estimatedInputCostUSD = 0;
    let estimatedOutputCostUSD = 0;

    for (const m of byModel) {
      const costs = calculateEstimatedCost(
        m.model,
        m.totalInputTokens,
        m.totalOutputTokens
      );
      estimatedInputCostUSD += costs.inputCostUSD;
      estimatedOutputCostUSD += costs.outputCostUSD;
    }

    return {
      periodStart,
      periodEnd,
      tickCount,
      totalCalls,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      avgCallsPerTick,
      avgInputTokensPerTick,
      avgOutputTokensPerTick,
      avgTotalTokensPerTick,
      byPromptType,
      byModel,
      estimatedInputCostUSD,
      estimatedOutputCostUSD,
      estimatedTotalCostUSD: estimatedInputCostUSD + estimatedOutputCostUSD,
    };
  }

  /**
   * Record a manual LLM call (when not using the automatic callback)
   * Useful for tracking calls made outside the normal game tick flow
   */
  recordManualCall(
    usage: Omit<LLMCallTokenUsage, 'callId' | 'timestamp'>
  ): void {
    if (this.currentCollector && this.isCollecting) {
      this.currentCollector.recordCall(usage);
    } else {
      logger.debug(
        'Manual token usage recorded (no tick in progress)',
        usage,
        'TokenStatsService'
      );
    }
  }

  /**
   * Check if currently collecting token usage
   */
  isTickInProgress(): boolean {
    return this.isCollecting;
  }

  /**
   * Clear all stored statistics (for testing)
   */
  clearAll(): void {
    this.recentTicks = [];
    if (this.isCollecting) {
      setTokenUsageCallback(null);
      this.currentCollector = null;
      this.tickStartTime = null;
      this.currentTickId = null;
      this.isCollecting = false;
    }
    logger.info('Token stats cleared', undefined, 'TokenStatsService');
  }
}

// Export singleton instance (camelCase for consistency with other services)
export const tokenStatsService = new TokenStatsServiceImpl();
