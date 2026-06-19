/**
 * A2A Rate Limiter
 * Token bucket algorithm for rate limiting agent messages
 */

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  private maxTokens: number;
  private refillRate: number; // tokens per minute
  private refillInterval = 60000; // 1 minute in ms

  constructor(messagesPerMinute: number) {
    this.maxTokens = messagesPerMinute;
    this.refillRate = messagesPerMinute;
  }

  /**
   * Check if agent can send a message (has tokens available)
   */
  checkLimit(agentId: string): boolean {
    const bucket = this.getBucket(agentId);
    this.refillBucket(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Get or create token bucket for agent
   */
  private getBucket(agentId: string): TokenBucket {
    let bucket = this.buckets.get(agentId);

    if (!bucket) {
      bucket = {
        tokens: this.maxTokens,
        lastRefill: Date.now(),
      };
      this.buckets.set(agentId, bucket);
    }

    return bucket;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillBucket(bucket: TokenBucket): void {
    const now = Date.now();
    const timePassed = now - bucket.lastRefill;

    if (timePassed >= this.refillInterval) {
      const intervalsElapsed = Math.floor(timePassed / this.refillInterval);
      const tokensToAdd = intervalsElapsed * this.refillRate;

      bucket.tokens = Math.min(this.maxTokens, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }
  }

  /**
   * Reset rate limit for an agent (useful for testing)
   */
  reset(agentId: string): void {
    this.buckets.delete(agentId);
  }

  /**
   * Get current token count for agent
   */
  getTokens(agentId: string): number {
    const bucket = this.getBucket(agentId);
    this.refillBucket(bucket);
    return Math.floor(bucket.tokens);
  }

  /**
   * Clear all rate limit data
   */
  clear(): void {
    this.buckets.clear();
  }
}
