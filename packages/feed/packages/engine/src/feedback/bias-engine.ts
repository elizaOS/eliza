/**
 * Bias Engine
 *
 * Manages configurable sentiment and price biases for entities.
 * Supports commands like "bias up TeslAI" or "bias down Musk" to create
 * artificial price pressure in perpetual markets and sentiment shifts
 * in prediction markets.
 */

import { logger } from '@feed/shared';
import { clamp01 } from '../utils/math-utils';

export interface BiasConfig {
  entityId: string; // Organization ID or keyword
  entityName: string; // Human-readable name
  direction: 'up' | 'down'; // Bias direction
  strength: number; // 0.0 to 1.0 (multiplier for price impact)
  createdAt: Date;
  expiresAt: Date | null; // null = permanent, Date = temporary
  decayRate: number; // How fast bias decays (0 = no decay, 1 = fast decay)
}

export interface BiasAdjustment {
  priceImpact: number; // Percentage adjustment (-0.5 to 0.5)
  sentimentShift: number; // Sentiment modifier (-1.0 to 1.0)
  confidence: number; // How confident the bias is (0-1)
}

export class BiasEngine {
  private static instance: BiasEngine | null = null;
  private biases: Map<string, BiasConfig> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.startCleanupInterval();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): BiasEngine {
    if (!BiasEngine.instance) {
      BiasEngine.instance = new BiasEngine();
    }
    return BiasEngine.instance;
  }

  /**
   * Add or update a bias configuration
   *
   * @example
   * biasEngine.setBias('teslai', 'TeslAI', 'up', 0.8, { durationHours: 24 })
   * biasEngine.setBias('ailon-musk', 'AIlon Musk', 'down', 0.6)
   */
  setBias(
    entityId: string,
    entityName: string,
    direction: 'up' | 'down',
    strength = 0.5,
    options?: {
      durationHours?: number; // null = permanent
      decayRate?: number; // 0-1, default 0.1
    }
  ): void {
    // Normalize strength to 0-1
    const normalizedStrength = clamp01(strength);

    // Calculate expiration
    const expiresAt = options?.durationHours
      ? new Date(Date.now() + options.durationHours * 60 * 60 * 1000)
      : null;

    const bias: BiasConfig = {
      entityId,
      entityName,
      direction,
      strength: normalizedStrength,
      createdAt: new Date(),
      expiresAt,
      decayRate: options?.decayRate ?? 0.1,
    };

    this.biases.set(entityId, bias);

    logger.info(
      `Bias set: ${direction} ${entityName} (strength: ${normalizedStrength.toFixed(2)}, ${expiresAt ? `expires: ${expiresAt.toISOString()}` : 'permanent'})`,
      undefined,
      'BiasEngine'
    );
  }

  /**
   * Remove a bias
   */
  removeBias(entityId: string): boolean {
    const removed = this.biases.delete(entityId);
    if (removed) {
      logger.info(
        `Bias removed for entity: ${entityId}`,
        undefined,
        'BiasEngine'
      );
    }
    return removed;
  }

  /**
   * Tune the strength of an existing bias
   *
   * @param entityId - Entity ID to tune
   * @param strength - New strength (0-1)
   * @param decayRate - Optional new decay rate (0-1)
   * @returns true if bias was found and tuned, false otherwise
   */
  tuneBiasStrength(
    entityId: string,
    strength: number,
    decayRate?: number
  ): boolean {
    const bias = this.biases.get(entityId);

    if (!bias) {
      return false;
    }

    // Normalize strength to 0-1
    const normalizedStrength = clamp01(strength);

    // Update bias with new strength
    const updatedBias: BiasConfig = {
      ...bias,
      strength: normalizedStrength,
      decayRate: decayRate !== undefined ? decayRate : bias.decayRate,
    };

    this.biases.set(entityId, updatedBias);

    logger.info(
      `Bias tuned for ${bias.entityName}: strength ${normalizedStrength.toFixed(2)}, decay ${updatedBias.decayRate.toFixed(2)}`,
      undefined,
      'BiasEngine'
    );

    return true;
  }

  /**
   * Get all active biases
   */
  getActiveBiases(): BiasConfig[] {
    return Array.from(this.biases.values());
  }

  /**
   * Get bias adjustment for an entity
   *
   * Returns price impact and sentiment shift based on active biases.
   * Handles bias decay over time and expiration.
   *
   * @param entityId - Entity ID or ticker to check
   * @returns BiasAdjustment with price and sentiment modifiers
   */
  getBiasAdjustment(entityId: string): BiasAdjustment {
    const bias = this.biases.get(entityId);

    if (!bias) {
      return {
        priceImpact: 0,
        sentimentShift: 0,
        confidence: 0,
      };
    }

    // Check if bias has expired
    if (bias.expiresAt && new Date() > bias.expiresAt) {
      this.biases.delete(entityId);
      logger.debug(
        `Bias expired for ${bias.entityName}`,
        undefined,
        'BiasEngine'
      );
      return {
        priceImpact: 0,
        sentimentShift: 0,
        confidence: 0,
      };
    }

    // Calculate decay factor based on time elapsed
    const ageInHours =
      (Date.now() - bias.createdAt.getTime()) / (1000 * 60 * 60);
    const decayFactor = Math.exp(-bias.decayRate * ageInHours);

    // Calculate effective strength after decay
    const effectiveStrength = bias.strength * decayFactor;

    // Determine direction multiplier
    const directionMultiplier = bias.direction === 'up' ? 1 : -1;

    // Calculate price impact (percentage)
    // Max impact: ±50% (0.5), scaled by strength
    const priceImpact = directionMultiplier * effectiveStrength * 0.5;

    // Calculate sentiment shift
    // Range: -1.0 to 1.0, scaled by strength
    const sentimentShift = directionMultiplier * effectiveStrength;

    // Confidence decreases with decay
    const confidence = decayFactor;

    return {
      priceImpact,
      sentimentShift,
      confidence,
    };
  }

  /**
   * Get combined bias adjustment for multiple potential matches
   *
   * Useful when entity might be referenced by different IDs/keywords
   *
   * @param entityIds - Array of potential entity IDs to check
   * @returns Combined bias adjustment
   */
  getCombinedBiasAdjustment(entityIds: string[]): BiasAdjustment {
    let totalPriceImpact = 0;
    let totalSentimentShift = 0;
    let maxConfidence = 0;

    for (const entityId of entityIds) {
      const adjustment = this.getBiasAdjustment(entityId);

      if (adjustment.confidence > 0) {
        totalPriceImpact += adjustment.priceImpact;
        totalSentimentShift += adjustment.sentimentShift;
        maxConfidence = Math.max(maxConfidence, adjustment.confidence);
      }
    }

    // Clamp price impact to ±50%
    const clampedPriceImpact = Math.max(-0.5, Math.min(0.5, totalPriceImpact));

    // Clamp sentiment shift to ±1.0
    const clampedSentimentShift = Math.max(
      -1.0,
      Math.min(1.0, totalSentimentShift)
    );

    return {
      priceImpact: clampedPriceImpact,
      sentimentShift: clampedSentimentShift,
      confidence: maxConfidence,
    };
  }

  /**
   * Find entity matches for text analysis
   *
   * Searches for entity mentions in text and returns relevant bias adjustments
   *
   * @param text - Text to analyze for entity mentions
   * @returns Map of entity IDs to bias adjustments
   */
  findBiasesInText(text: string): Map<string, BiasAdjustment> {
    const matches = new Map<string, BiasAdjustment>();
    const textLower = text.toLowerCase();

    for (const [entityId, bias] of this.biases) {
      // Check if entity ID or name is mentioned in text
      const entityIdLower = entityId.toLowerCase();
      const entityNameLower = bias.entityName.toLowerCase();

      if (
        textLower.includes(entityIdLower) ||
        textLower.includes(entityNameLower)
      ) {
        matches.set(entityId, this.getBiasAdjustment(entityId));
      }
    }

    return matches;
  }

  /**
   * Bulk set biases from configuration
   *
   * @example
   * biasEngine.setBulkBiases([
   *   { entityId: 'teslai', entityName: 'TeslAI', direction: 'up', strength: 0.8 },
   *   { entityId: 'ailon-musk', entityName: 'AIlon Musk', direction: 'down', strength: 0.6 }
   * ])
   */
  setBulkBiases(
    biases: Array<{
      entityId: string;
      entityName: string;
      direction: 'up' | 'down';
      strength?: number;
      durationHours?: number;
      decayRate?: number;
    }>
  ): void {
    for (const bias of biases) {
      this.setBias(
        bias.entityId,
        bias.entityName,
        bias.direction,
        bias.strength,
        {
          durationHours: bias.durationHours,
          decayRate: bias.decayRate,
        }
      );
    }
  }

  /**
   * Start periodic cleanup of expired biases
   */
  private startCleanupInterval(): void {
    // Clean up every 10 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.cleanupExpiredBiases();
      },
      10 * 60 * 1000
    );
  }

  /**
   * Clean up expired biases
   */
  private cleanupExpiredBiases(): void {
    const now = new Date();
    let removedCount = 0;

    for (const [entityId, bias] of this.biases) {
      if (bias.expiresAt && now > bias.expiresAt) {
        this.biases.delete(entityId);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.debug(
        `Cleaned up ${removedCount} expired biases`,
        undefined,
        'BiasEngine'
      );
    }
  }

  /**
   * Stop cleanup interval (for shutdown)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('BiasEngine stopped', undefined, 'BiasEngine');
    }
  }

  /**
   * Export current biases for persistence
   */
  exportBiases(): BiasConfig[] {
    return Array.from(this.biases.values());
  }

  /**
   * Import biases from persistence
   */
  importBiases(biases: BiasConfig[]): void {
    this.biases.clear();

    for (const bias of biases) {
      // Reconstruct dates
      const config: BiasConfig = {
        ...bias,
        createdAt: new Date(bias.createdAt),
        expiresAt: bias.expiresAt ? new Date(bias.expiresAt) : null,
      };

      this.biases.set(config.entityId, config);
    }

    logger.info(`Imported ${biases.length} biases`, undefined, 'BiasEngine');
  }
}

/**
 * Export singleton instance
 */
export const biasEngine = BiasEngine.getInstance();
