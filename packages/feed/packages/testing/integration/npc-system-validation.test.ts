/**
 * NPC System Validation Tests
 *
 * @module testing/integration/npc-system-validation.test
 *
 * @description
 * Comprehensive tests that validate NPC system behavior including:
 * - Investment manager portfolio allocation
 * - Portfolio strategy selection based on personality
 * - Persona generation and assignment
 * - Trading decision logic
 *
 * **Output Files:**
 * - .output/npc-portfolio-strategies-{timestamp}.json
 * - .output/npc-persona-assignments-{timestamp}.json
 * - .output/npc-trading-decisions-{timestamp}.json
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Import NPC system components
import {
  NPCPersonaGenerator,
  NPCPortfolioStrategy,
  StaticDataRegistry,
} from '@feed/engine';
import { logger } from '@feed/shared';

// Set timeout
setDefaultTimeout(60000);

// Output directory setup
const OUTPUT_DIR = join(process.cwd(), '.output');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');

function ensureOutputDir() {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function writeOutput(filename: string, data: unknown) {
  ensureOutputDir();
  const filepath = join(OUTPUT_DIR, `${filename}-${TIMESTAMP}.json`);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  logger.info(`Output written to ${filepath}`, undefined, 'NPCTest');
  return filepath;
}

describe('NPC System Validation Tests', () => {
  beforeAll(() => {
    ensureOutputDir();
    logger.info(
      `Starting NPC system tests. Output dir: ${OUTPUT_DIR}`,
      undefined,
      'NPCTest'
    );
  });

  describe('NPCPortfolioStrategy', () => {
    test('returns valid strategy for aggressive personality', () => {
      const strategy = NPCPortfolioStrategy.getStrategy(
        'erratic disaster profiteer'
      );

      expect(strategy).toBeDefined();
      expect(strategy.name).toBe('Aggressive Growth');
      expect(strategy.assetAllocation.perps).toBeGreaterThan(50);
      expect(strategy.riskParameters.maxLeverage).toBeGreaterThan(5);
      expect(strategy.holdingPeriod).toBe('short');
    });

    test('returns valid strategy for conservative personality', () => {
      const strategy = NPCPortfolioStrategy.getStrategy(
        'vampire yacht club member'
      );

      expect(strategy).toBeDefined();
      expect(strategy.name).toBe('Conservative Wealth Preservation');
      expect(strategy.assetAllocation.cash).toBeGreaterThan(10);
      expect(strategy.riskParameters.maxLeverage).toBeLessThanOrEqual(2);
      expect(strategy.holdingPeriod).toBe('long');
    });

    test('returns valid strategy for balanced personality', () => {
      const strategy = NPCPortfolioStrategy.getStrategy('tech entrepreneur');

      expect(strategy).toBeDefined();
      expect(strategy.name).toBe('Balanced Growth');
      expect(strategy.assetAllocation.perps).toBeGreaterThanOrEqual(40);
      expect(strategy.assetAllocation.predictions).toBeGreaterThanOrEqual(30);
    });

    test('returns valid strategy for high volatility personality', () => {
      const strategy = NPCPortfolioStrategy.getStrategy(
        'memecoin degen nft collector'
      );

      expect(strategy).toBeDefined();
      expect(strategy.name).toBe('High Volatility Trading');
      expect(strategy.assetAllocation.perps).toBeGreaterThan(70);
      expect(strategy.riskParameters.maxLeverage).toBeGreaterThan(10);
    });

    test('adjusts strategy for high volatility market conditions', () => {
      const baseStrategy =
        NPCPortfolioStrategy.getStrategy('tech entrepreneur');
      const adjustedStrategy = NPCPortfolioStrategy.getStrategy(
        'tech entrepreneur',
        {
          volatility: 0.9,
          sentiment: 0,
          trending: false,
          volume: 0.5,
        }
      );

      // High volatility should reduce leverage
      expect(adjustedStrategy.riskParameters.maxLeverage).toBeLessThan(
        baseStrategy.riskParameters.maxLeverage
      );
      // High volatility should increase cash allocation
      expect(adjustedStrategy.assetAllocation.cash).toBeGreaterThan(
        baseStrategy.assetAllocation.cash
      );
    });

    test('adjusts strategy for negative sentiment market conditions', () => {
      const baseStrategy =
        NPCPortfolioStrategy.getStrategy('tech entrepreneur');
      const adjustedStrategy = NPCPortfolioStrategy.getStrategy(
        'tech entrepreneur',
        {
          volatility: 0.5,
          sentiment: -0.7,
          trending: false,
          volume: 0.5,
        }
      );

      // Negative sentiment should shift to predictions
      expect(adjustedStrategy.assetAllocation.predictions).toBeGreaterThan(
        baseStrategy.assetAllocation.predictions
      );
    });

    test('calculates optimal position size using Kelly Criterion', () => {
      const strategy = NPCPortfolioStrategy.getStrategy('balanced');

      // High win probability, good payout
      const highConfidence = NPCPortfolioStrategy.calculateOptimalPositionSize(
        0.7, // 70% win probability
        2.0, // 2:1 payout
        strategy
      );

      // Low win probability
      const lowConfidence = NPCPortfolioStrategy.calculateOptimalPositionSize(
        0.4, // 40% win probability
        2.0, // 2:1 payout
        strategy
      );

      expect(highConfidence).toBeGreaterThan(lowConfidence);
      expect(highConfidence).toBeLessThanOrEqual(
        strategy.positionSizing.maxPositionSize
      );
      expect(lowConfidence).toBeGreaterThanOrEqual(
        strategy.positionSizing.minPositionSize
      );
    });

    test('determines when rebalancing is needed', () => {
      const current = { perps: 60, predictions: 30, cash: 10 };
      const target = { perps: 50, predictions: 40, cash: 10 };

      // Should need rebalancing with 5% threshold (10% deviation)
      expect(NPCPortfolioStrategy.shouldRebalance(current, target, 5)).toBe(
        true
      );

      // Should not need rebalancing with 15% threshold
      expect(NPCPortfolioStrategy.shouldRebalance(current, target, 15)).toBe(
        false
      );
    });

    test('generates rebalance plan correctly', () => {
      const current = { perps: 60, predictions: 30, cash: 10 };
      const target = { perps: 50, predictions: 40, cash: 10 };
      const portfolioValue = 10000;

      const plan = NPCPortfolioStrategy.generateRebalancePlan(
        current,
        target,
        portfolioValue
      );

      expect(plan.perpAdjustment).toBe(-1000); // 10% decrease of 10000
      expect(plan.predictionAdjustment).toBe(1000); // 10% increase of 10000
      expect(plan.cashAdjustment).toBe(0); // No change
    });

    test('outputs all strategy configurations', () => {
      const personalities = [
        'erratic disaster profiteer',
        'vampire yacht club',
        'balanced entrepreneur',
        'memecoin degen',
        'philosopher investor',
        null, // Default case
      ];

      const marketConditions = [
        {
          name: 'normal',
          volatility: 0.5,
          sentiment: 0,
          trending: true,
          volume: 0.5,
        },
        {
          name: 'high_volatility',
          volatility: 0.9,
          sentiment: 0,
          trending: false,
          volume: 0.3,
        },
        {
          name: 'bearish',
          volatility: 0.6,
          sentiment: -0.7,
          trending: false,
          volume: 0.4,
        },
        {
          name: 'bullish',
          volatility: 0.4,
          sentiment: 0.7,
          trending: true,
          volume: 0.8,
        },
      ];

      const strategyOutput: {
        personality: string | null;
        baseStrategy: ReturnType<typeof NPCPortfolioStrategy.getStrategy>;
        adjustedStrategies: {
          condition: string;
          strategy: ReturnType<typeof NPCPortfolioStrategy.getStrategy>;
        }[];
      }[] = [];

      for (const personality of personalities) {
        const baseStrategy = NPCPortfolioStrategy.getStrategy(personality);
        const adjustedStrategies = marketConditions.map((condition) => ({
          condition: condition.name,
          strategy: NPCPortfolioStrategy.getStrategy(personality, {
            volatility: condition.volatility,
            sentiment: condition.sentiment,
            trending: condition.trending,
            volume: condition.volume,
          }),
        }));

        strategyOutput.push({
          personality,
          baseStrategy,
          adjustedStrategies,
        });
      }

      writeOutput('npc-portfolio-strategies', strategyOutput);

      expect(strategyOutput.length).toBe(personalities.length);
    });
  });

  describe('NPCPersonaGenerator', () => {
    test('assigns personas to actors', () => {
      const generator = new NPCPersonaGenerator();

      // Get some actors from static registry
      const actors = StaticDataRegistry.getAllActors().slice(0, 10);
      const organizations = StaticDataRegistry.getAllOrganizations();

      const personas = generator.assignPersonas(
        actors.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          domain: a.domain,
          personality: a.personality,
          role: 'supporting' as const,
          affiliations: a.affiliations,
          tier: a.tier ?? undefined,
        })),
        organizations.map((o) => ({
          id: o.id,
          name: o.name,
          ticker: o.ticker,
          description: o.description,
          type: o.type,
          canBeInvolved: o.canBeInvolved,
        }))
      );

      expect(personas.size).toBeGreaterThan(0);

      // Validate persona structure
      for (const [actorId, persona] of personas) {
        expect(actorId).toBeDefined();
        expect(typeof persona.reliability).toBe('number');
        expect(persona.reliability).toBeGreaterThanOrEqual(0);
        expect(persona.reliability).toBeLessThanOrEqual(1);
        expect(Array.isArray(persona.insiderOrgs)).toBe(true);
        expect(typeof persona.willingToLie).toBe('boolean');
        expect(typeof persona.selfInterest).toBe('string');
      }
    });

    test('outputs persona assignments for all actors', () => {
      const generator = new NPCPersonaGenerator();

      const actors = StaticDataRegistry.getAllActors();
      const organizations = StaticDataRegistry.getAllOrganizations();

      const personas = generator.assignPersonas(
        actors.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          domain: a.domain,
          personality: a.personality,
          role: 'supporting' as const,
          affiliations: a.affiliations,
          tier: a.tier ?? undefined,
        })),
        organizations.map((o) => ({
          id: o.id,
          name: o.name,
          ticker: o.ticker,
          description: o.description,
          type: o.type,
          canBeInvolved: o.canBeInvolved,
        }))
      );

      const personaOutput = {
        totalActors: actors.length,
        totalPersonas: personas.size,
        stats: {
          avgReliability: 0,
          insiderCount: 0,
          liarCount: 0,
          reliabilityDistribution: {
            low: 0, // 0-0.3
            medium: 0, // 0.3-0.7
            high: 0, // 0.7-1.0
          },
        },
        personas: [] as {
          actorId: string;
          actorName: string;
          reliability: number;
          insiderOrgs: string[];
          willingToLie: boolean;
          selfInterest: string;
          expertise: string[];
          favorsActors: string[];
          opposesActors: string[];
        }[],
      };

      let totalReliability = 0;

      for (const [actorId, persona] of personas) {
        const actor = actors.find((a) => a.id === actorId);
        totalReliability += persona.reliability;

        if (persona.insiderOrgs.length > 0) {
          personaOutput.stats.insiderCount++;
        }
        if (persona.willingToLie) {
          personaOutput.stats.liarCount++;
        }

        if (persona.reliability < 0.3) {
          personaOutput.stats.reliabilityDistribution.low++;
        } else if (persona.reliability < 0.7) {
          personaOutput.stats.reliabilityDistribution.medium++;
        } else {
          personaOutput.stats.reliabilityDistribution.high++;
        }

        personaOutput.personas.push({
          actorId,
          actorName: actor?.name || 'Unknown',
          reliability: persona.reliability,
          insiderOrgs: persona.insiderOrgs,
          willingToLie: persona.willingToLie,
          selfInterest: persona.selfInterest,
          expertise: persona.expertise,
          favorsActors: persona.favorsActors,
          opposesActors: persona.opposesActors,
        });
      }

      personaOutput.stats.avgReliability = totalReliability / personas.size;

      writeOutput('npc-persona-assignments', personaOutput);

      expect(personaOutput.totalPersonas).toBeGreaterThan(0);
      expect(personaOutput.stats.avgReliability).toBeGreaterThan(0);
    });

    test('insiders have appropriate org affiliations', () => {
      const generator = new NPCPersonaGenerator();

      const actors = StaticDataRegistry.getAllActors().slice(0, 20);
      const organizations = StaticDataRegistry.getAllOrganizations();

      const personas = generator.assignPersonas(
        actors.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          domain: a.domain,
          personality: a.personality,
          role: 'supporting' as const,
          affiliations: a.affiliations,
          tier: a.tier ?? undefined,
        })),
        organizations.map((o) => ({
          id: o.id,
          name: o.name,
          ticker: o.ticker,
          description: o.description,
          type: o.type,
          canBeInvolved: o.canBeInvolved,
        }))
      );

      const orgIds = new Set(organizations.map((o) => o.id));

      // Validate insider orgs are real organizations
      for (const [_actorId, persona] of personas) {
        for (const insiderOrg of persona.insiderOrgs) {
          expect(orgIds.has(insiderOrg)).toBe(true);
        }
      }
    });
  });

  describe('StaticDataRegistry', () => {
    test('returns all actors', () => {
      const actors = StaticDataRegistry.getAllActors();

      expect(actors).toBeDefined();
      expect(Array.isArray(actors)).toBe(true);
      expect(actors.length).toBeGreaterThan(0);

      // Validate actor structure
      for (const actor of actors.slice(0, 10)) {
        expect(actor.id).toBeDefined();
        expect(actor.name).toBeDefined();
        expect(actor.description).toBeDefined();
      }
    });

    test('returns all organizations', () => {
      const organizations = StaticDataRegistry.getAllOrganizations();

      expect(organizations).toBeDefined();
      expect(Array.isArray(organizations)).toBe(true);
      expect(organizations.length).toBeGreaterThan(0);

      // Validate organization structure
      for (const org of organizations) {
        expect(org.id).toBeDefined();
        expect(org.name).toBeDefined();
        expect(org.type).toBeDefined();
      }
    });

    test('returns organizations by type', () => {
      const companies = StaticDataRegistry.getOrganizationsByType('company');
      const media = StaticDataRegistry.getOrganizationsByType('media');
      const government =
        StaticDataRegistry.getOrganizationsByType('government');

      expect(companies.length).toBeGreaterThanOrEqual(0);
      expect(media.length).toBeGreaterThanOrEqual(0);
      expect(government.length).toBeGreaterThanOrEqual(0);

      // All should be of correct type
      for (const company of companies) {
        expect(company.type).toBe('company');
      }
      for (const m of media) {
        expect(m.type).toBe('media');
      }
      for (const g of government) {
        expect(g.type).toBe('government');
      }
    });

    test('gets actor by id', () => {
      const allActors = StaticDataRegistry.getAllActors();
      expect(allActors.length).toBeGreaterThan(0);

      const firstActor = allActors[0]!;
      const retrieved = StaticDataRegistry.getActor(firstActor.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(firstActor.id);
      expect(retrieved?.name).toBe(firstActor.name);
    });

    test('outputs static data registry summary', () => {
      const actors = StaticDataRegistry.getAllActors();
      const organizations = StaticDataRegistry.getAllOrganizations();

      const registryOutput = {
        actorCount: actors.length,
        organizationCount: organizations.length,
        actorsByTier: {} as Record<string, number>,
        organizationsByType: {} as Record<string, number>,
        sampleActors: actors.slice(0, 10).map((a) => ({
          id: a.id,
          name: a.name,
          tier: a.tier,
          domain: a.domain,
          affiliationCount: a.affiliations?.length || 0,
        })),
        sampleOrganizations: organizations.slice(0, 10).map((o) => ({
          id: o.id,
          name: o.name,
          type: o.type,
          ticker: o.ticker,
        })),
      };

      // Count by tier
      for (const actor of actors) {
        const tier = actor.tier || 'UNKNOWN';
        registryOutput.actorsByTier[tier] =
          (registryOutput.actorsByTier[tier] || 0) + 1;
      }

      // Count by type
      for (const org of organizations) {
        registryOutput.organizationsByType[org.type] =
          (registryOutput.organizationsByType[org.type] || 0) + 1;
      }

      writeOutput('static-data-registry', registryOutput);

      expect(registryOutput.actorCount).toBeGreaterThan(0);
      expect(registryOutput.organizationCount).toBeGreaterThan(0);
    });
  });

  describe('Strategy Evaluation', () => {
    test('evaluates strategy performance metrics', () => {
      // Simulated returns
      const actualReturns = [
        0.05, -0.02, 0.08, 0.03, -0.01, 0.06, 0.02, -0.03, 0.04, 0.01,
      ];
      const benchmarkReturns = [
        0.03, -0.01, 0.04, 0.02, 0.01, 0.03, 0.02, -0.02, 0.03, 0.01,
      ];

      const metrics = NPCPortfolioStrategy.evaluateStrategy(
        actualReturns,
        benchmarkReturns,
        0.02
      );

      expect(metrics.sharpeRatio).toBeDefined();
      expect(metrics.maxDrawdown).toBeDefined();
      expect(metrics.winRate).toBeDefined();
      expect(metrics.alpha).toBeDefined();
      expect(metrics.beta).toBeDefined();

      // Win rate should be positive wins / total
      expect(metrics.winRate).toBeGreaterThan(0);
      expect(metrics.winRate).toBeLessThanOrEqual(100);

      writeOutput('strategy-evaluation', {
        actualReturns,
        benchmarkReturns,
        metrics,
      });
    });

    test('holding period hours are correct', () => {
      expect(NPCPortfolioStrategy.getHoldingPeriodHours('short')).toBe(24);
      expect(NPCPortfolioStrategy.getHoldingPeriodHours('medium')).toBe(168);
      expect(NPCPortfolioStrategy.getHoldingPeriodHours('long')).toBe(720);
    });
  });
});
