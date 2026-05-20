/**
 * Capital Allocation Service
 *
 * Assigns realistic starting capital to NPCs based on:
 * - Tier (S/A/B/C)
 * - Role (CEO, VC, influencer, etc.)
 * - Domain (finance, tech, media, etc.)
 *
 * This creates a natural market hierarchy where whales have more influence.
 */

import type { Actor } from '@feed/shared';

interface CapitalAllocation {
  tradingBalance: number;
  initialPoolBalance: number;
  reputationPoints: number;
  reasoning: string;
}

export class CapitalAllocationService {
  /**
   * Calculate starting capital for an NPC based on their profile
   */
  static calculateCapital(actor: Actor): CapitalAllocation {
    // Base capital by tier
    const tierCapital = CapitalAllocationService.getTierCapital(
      actor.tier || 'C_TIER'
    );

    // Role multiplier
    const roleMultiplier = CapitalAllocationService.getRoleMultiplier(
      actor.description || ''
    );

    // Domain multiplier
    const domainMultiplier = CapitalAllocationService.getDomainMultiplier(
      actor.domain || []
    );

    // Calculate final amount
    const tradingBalance = Math.round(
      tierCapital * roleMultiplier * domainMultiplier
    );

    // Pool starts with same amount as personal balance
    const initialPoolBalance = tradingBalance;

    // Reputation points scale with capital (but not 1:1)
    // Formula: sqrt(capital) * 10 gives reasonable scaling
    // $10k → 1,000 points
    // $100k → 3,162 points
    // $500k → 7,071 points
    const reputationPoints = Math.round(Math.sqrt(tradingBalance) * 10);

    const reasoning = CapitalAllocationService.generateReasoning(
      actor,
      tierCapital,
      roleMultiplier,
      domainMultiplier
    );

    return {
      tradingBalance,
      initialPoolBalance,
      reputationPoints,
      reasoning,
    };
  }

  /**
   * Base capital by tier
   */
  private static getTierCapital(tier: string): number {
    const tierCapital: Record<string, number> = {
      S_TIER: 250000, // Billionaire CEOs, top VCs ($250k)
      A_TIER: 75000, // Successful VCs, executives ($75k)
      B_TIER: 25000, // Successful individuals ($25k)
      C_TIER: 10000, // Influencers, reporters ($10k)
    };

    const capital = tierCapital[tier] || tierCapital['C_TIER'];
    if (!capital) {
      throw new Error(`Invalid tier: ${tier}`);
    }
    return capital;
  }

  /**
   * Role multiplier based on description keywords
   */
  private static getRoleMultiplier(description: string): number {
    const descLower = description.toLowerCase();

    // High capital roles (2x)
    if (
      descLower.includes('ceo') ||
      descLower.includes('founder') ||
      descLower.includes('chairman') ||
      descLower.includes('billionaire')
    ) {
      return 2.0;
    }

    // VC/investor roles (1.8x)
    if (
      descLower.includes('vc') ||
      descLower.includes('venture capital') ||
      descLower.includes('investor') ||
      descLower.includes('fund')
    ) {
      return 1.8;
    }

    // Executive roles (1.5x)
    if (
      descLower.includes('executive') ||
      descLower.includes('president') ||
      descLower.includes('director')
    ) {
      return 1.5;
    }

    // Politician (moderate, 1.2x - they have money but claim not to)
    if (
      descLower.includes('senator') ||
      descLower.includes('congress') ||
      descLower.includes('representative')
    ) {
      return 1.2;
    }

    // Media/influencer (0.8x)
    if (
      descLower.includes('host') ||
      descLower.includes('influencer') ||
      descLower.includes('podcaster') ||
      descLower.includes('journalist')
    ) {
      return 0.8;
    }

    // Default (1.0x)
    return 1.0;
  }

  /**
   * Domain multiplier based on industry
   */
  private static getDomainMultiplier(domains: string[]): number {
    const domainScores: Record<string, number> = {
      finance: 1.5, // Finance people have the most capital
      crypto: 1.4, // Crypto traders loaded
      vc: 1.4, // VCs have capital
      tech: 1.2, // Tech execs well-funded
      business: 1.1, // Business people have capital
      politics: 1.0, // Politicians have hidden wealth
      media: 0.8, // Media people less capital
      entertainment: 0.7, // Entertainers less capital
      social_media: 0.7, // Social media influencers less
    };

    // Take highest domain score
    let maxScore = 1.0;
    for (const domain of domains) {
      const score = domainScores[domain.toLowerCase()];
      if (score && score > maxScore) {
        maxScore = score;
      }
    }

    return maxScore;
  }

  /**
   * Generate reasoning for capital allocation
   */
  private static generateReasoning(
    actor: Actor,
    tierCapital: number,
    roleMultiplier: number,
    domainMultiplier: number
  ): string {
    const tier = actor.tier || 'C_TIER';
    const role = CapitalAllocationService.extractRole(actor.description || '');
    const primaryDomain = actor.domain?.[0] || 'general';

    return `${tier.replace('_TIER', '-tier')} ${role} in ${primaryDomain}: $${tierCapital.toLocaleString()} base × ${roleMultiplier}aix role × ${domainMultiplier}aix domain`;
  }

  /**
   * Extract primary role from description
   */
  private static extractRole(description: string): string {
    const descLower = description.toLowerCase();

    if (descLower.includes('ceo')) return 'CEO';
    if (descLower.includes('founder')) return 'founder';
    if (descLower.includes('chairman')) return 'chairman';
    if (descLower.includes('vc') || descLower.includes('venture capital'))
      return 'VC';
    if (descLower.includes('investor')) return 'investor';
    if (descLower.includes('senator')) return 'senator';
    if (descLower.includes('congress')) return 'representative';
    if (descLower.includes('host')) return 'host';
    if (descLower.includes('influencer')) return 'influencer';
    if (descLower.includes('journalist')) return 'journalist';

    return 'trader';
  }

  /**
   * Get example allocations for common actor types
   */
  static getExampleAllocations(): Array<{
    description: string;
    capital: number;
    reputation: number;
  }> {
    return [
      {
        description: 'S-tier Tech CEO (AIlon)',
        capital: 500000,
        reputation: 7071,
      },
      {
        description: 'S-tier VC Founder (Peter ThAIl)',
        capital: 450000,
        reputation: 6708,
      },
      {
        description: 'A-tier VC (Marc AIndreessen)',
        capital: 135000,
        reputation: 3674,
      },
      {
        description: 'A-tier CEO (Jeff BAIzos)',
        capital: 150000,
        reputation: 3873,
      },
      {
        description: 'B-tier Investor (CathAI Wood)',
        capital: 27500,
        reputation: 1658,
      },
      {
        description: 'B-tier Media Host (Tucker)',
        capital: 20000,
        reputation: 1414,
      },
      { description: 'C-tier Influencer', capital: 8000, reputation: 894 },
      { description: 'C-tier Journalist', capital: 8000, reputation: 894 },
      { description: 'User (starting)', capital: 1000, reputation: 1000 },
    ];
  }

  /**
   * Validate capital allocation makes sense
   */
  static validateAllocation(
    actor: Actor,
    allocation: CapitalAllocation
  ): boolean {
    // Minimum: $5,000
    if (allocation.tradingBalance < 5000) return false;

    // Maximum: $1,000,000
    if (allocation.tradingBalance > 1000000) return false;

    // S-tier should have at least $100k
    if (actor.tier === 'S_TIER' && allocation.tradingBalance < 100000)
      return false;

    // C-tier should have less than $50k
    if (actor.tier === 'C_TIER' && allocation.tradingBalance > 50000)
      return false;

    return true;
  }
}
