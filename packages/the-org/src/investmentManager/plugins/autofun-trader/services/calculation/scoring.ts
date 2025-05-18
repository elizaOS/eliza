import { TokenSignal } from '../../types/trading';
import { BaseTradeService } from '../base/BaseTradeService';
import { logger } from '@elizaos/core';

export class ScoringService extends BaseTradeService {
  async scoreTokenSignals(signals: TokenSignal[]): Promise<TokenSignal[]> {
    // Group signals by token address
    const tokenMap = new Map<string, TokenSignal>();

    for (const signal of signals) {
      if (tokenMap.has(signal.address)) {
        const existing = tokenMap.get(signal.address)!;
        existing.reasons.push(...signal.reasons);
        existing.score += signal.score;
      } else {
        tokenMap.set(signal.address, signal);
      }
    }

    // Score each token
    const scoredTokens = await Promise.all(
      Array.from(tokenMap.values()).map(async (token) => {
        let score = 0;

        // Technical Analysis Score (0-40)
        if (token.technicalSignals) {
          score += await this.analyticsService.scoreTechnicalSignals(token.technicalSignals);
        }

        // Social Signal Score (0-30)
        if (token.socialMetrics) {
          score += await this.analyticsService.scoreSocialMetrics(token.socialMetrics);
        }

        // Market Metrics Score (0-30)
        score += await this.analyticsService.scoreMarketMetrics({
          marketCap: token.marketCap,
          volume24h: token.volume24h,
          liquidity: token.liquidity,
        });

        token.score = score;
        return token;
      })
    );

    // Sort by score and filter minimum requirements
    return scoredTokens
      .filter(
        (token) =>
          token.score >= 60 && // Minimum score requirement
          token.liquidity >= 50000 && // Minimum liquidity $50k
          token.volume24h >= 100000 // Minimum 24h volume $100k
      )
      .sort((a, b) => b.score - a.score);
  }
}
