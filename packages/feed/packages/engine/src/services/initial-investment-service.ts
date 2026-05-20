/**
 * Initial Investment Service
 *
 * @description Generates character-appropriate initial investments for NPCs
 * during seed. NPCs start with existing positions in companies that make sense
 * for their character (AIlon Musk → SpAIceX/TeslAI, Sam AIltman → OpnAI, etc.).
 * Uses LLM to determine appropriate investments based on NPC characteristics.
 */

import { actorState, and, db, eq, getDbInstance, gte, sql } from '@babylon/db';
import { generateSnowflakeId, logger } from '@babylon/shared';
import { loadActorById } from '../actors-loader';
import { BabylonLLMClient } from '../llm/openai-client';
import { StaticDataRegistry } from './static-data-registry';

/**
 * Initial investment specification
 *
 * @description Contains NPC investment details including company, amount,
 * and reasoning for the investment decision.
 */
interface InitialInvestment {
  npcId: string;
  npcName: string;
  ticker: string;
  orgName: string;
  amount: number;
  reasoning: string;
}

/**
 * Initial Investment Service Class
 *
 * @description Static service class for generating and executing initial
 * investments for NPCs. Uses LLM to determine character-appropriate investments.
 */
export class InitialInvestmentService {
  /**
   * Generate and execute initial investments for all NPCs
   *
   * @description Uses LLM to determine character-appropriate investments based on:
   * - NPC affiliations (e.g., AIlon → TeslAI, SpAIceX)
   * - NPC relationships and connections
   * - NPC personality and domain expertise
   * - Available balance (invests 50-75% of total balance)
   *
   * Processes NPCs in batches to optimize LLM calls and executes all investments
   * atomically.
   *
   * @returns {Promise<object>} Summary with total NPCs, investments, and volume
   */
  static async generateAndExecuteInitialInvestments(): Promise<{
    totalNPCs: number;
    totalInvestments: number;
    totalVolume: number;
  }> {
    const startTime = Date.now();
    logger.info(
      'Generating initial NPC investments...',
      undefined,
      'InitialInvestment'
    );

    // Get all NPCs with their affiliations from static registry + dynamic state
    const actorStates = await getDbInstance().getAllActorStates();
    const actorStateMap = new Map(actorStates.map((s) => [s.id, s]));
    const npcs = StaticDataRegistry.getAllActors()
      .map((actor) => {
        const state = actorStateMap.get(actor.id);
        const tradingBalance = state?.tradingBalance ?? '10000';
        return {
          id: actor.id,
          name: actor.name,
          affiliations: actor.affiliations ?? [],
          domain: actor.domain ?? [],
          personality: actor.personality ?? null,
          tier: actor.tier ?? null,
          tradingBalance,
        };
      })
      .filter((npc) => Number.parseFloat(npc.tradingBalance) > 0);

    // Get all companies from static registry with dynamic prices
    const orgStates = await getDbInstance().getAllOrganizationStates();
    const priceMap = new Map(
      orgStates.map((s): [string, number | null] => [s.id, s.currentPrice])
    );
    const companies = StaticDataRegistry.getAllOrganizations()
      .filter((o) => o.type === 'company' && o.ticker)
      .map((o) => {
        const currentPriceFromDb = priceMap.get(o.id);
        return {
          id: o.id,
          name: o.name,
          ticker: o.ticker ?? null,
          initialPrice: o.initialPrice,
          currentPrice:
            currentPriceFromDb !== undefined
              ? currentPriceFromDb
              : o.initialPrice,
        };
      });

    if (companies.length === 0) {
      logger.warn(
        'No companies found for initial investments',
        undefined,
        'InitialInvestment'
      );
      return { totalNPCs: 0, totalInvestments: 0, totalVolume: 0 };
    }

    logger.info(
      `Processing ${npcs.length} NPCs for initial investments`,
      {
        npcCount: npcs.length,
        companyCount: companies.length,
      },
      'InitialInvestment'
    );

    const llm = BabylonLLMClient.forGameTick();

    // Process NPCs in batches to optimize LLM calls
    const batchSize = 10;
    const allInvestments: InitialInvestment[] = [];

    for (let i = 0; i < npcs.length; i += batchSize) {
      const batch = npcs.slice(i, i + batchSize);
      const batchInvestments =
        await InitialInvestmentService.generateInvestmentsForBatch(
          batch,
          companies,
          llm
        );
      allInvestments.push(...batchInvestments);

      logger.info(
        `Generated investments for batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(npcs.length / batchSize)}`,
        {
          investmentsGenerated: batchInvestments.length,
        },
        'InitialInvestment'
      );
    }

    // Execute all investments
    logger.info(
      `Executing ${allInvestments.length} initial investments...`,
      undefined,
      'InitialInvestment'
    );
    let successfulInvestments = 0;
    let totalVolume = 0;
    const failureReasons: Record<string, number> = {};

    for (const investment of allInvestments) {
      try {
        await InitialInvestmentService.executeInvestment(investment);
        successfulInvestments++;
        totalVolume += investment.amount;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error';
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
        logger.warn(
          `Failed to execute investment: ${investment.npcName} → ${investment.ticker}`,
          { error: reason, amount: investment.amount },
          'InitialInvestment'
        );
      }
    }

    if (Object.keys(failureReasons).length > 0) {
      logger.warn(
        'Investment execution failures summary',
        failureReasons,
        'InitialInvestment'
      );
    }

    const duration = Date.now() - startTime;
    logger.info(
      'Initial investments complete',
      {
        totalNPCs: npcs.length,
        investmentsGenerated: allInvestments.length,
        investmentsExecuted: successfulInvestments,
        totalVolume,
        durationMs: duration,
      },
      'InitialInvestment'
    );

    return {
      totalNPCs: npcs.length,
      totalInvestments: successfulInvestments,
      totalVolume,
    };
  }

  /**
   * Generate investments for a batch of NPCs using LLM
   */
  private static async generateInvestmentsForBatch(
    npcs: Array<{
      id: string;
      name: string;
      affiliations: string[];
      domain: string[];
      personality: string | null;
      tier: string | null;
      tradingBalance: string;
    }>,
    companies: Array<{
      id: string;
      name: string;
      ticker: string | null;
      initialPrice: number | null;
      currentPrice: number | null;
    }>,
    llm: BabylonLLMClient
  ): Promise<InitialInvestment[]> {
    // Build NPC profiles for prompt
    const npcProfiles = await Promise.all(
      npcs.map(async (npc) => {
        // Load actor JSON for more context (handles missing files gracefully)
        const actorData = loadActorById(npc.id);

        const availableBalance = Number(npc.tradingBalance);
        const targetInvestment = Math.floor(
          availableBalance * (0.5 + Math.random() * 0.25)
        ); // 50-75% of balance

        return `## ${npc.name}
- ID: ${npc.id}
- Balance: $${availableBalance.toLocaleString()}
- Target Investment: $${targetInvestment.toLocaleString()} (distribute across 2-5 companies)
- Affiliations: ${npc.affiliations.join(', ') || 'None'}
- Domain: ${npc.domain.join(', ')}
- Personality: ${npc.personality || 'Unknown'}
- Tier: ${npc.tier || 'Unknown'}
${actorData?.description ? `- Background: ${actorData.description.substring(0, 200)}...` : ''}`;
      })
    );

    // Build companies list
    const companiesList = companies
      .filter((c) => c.ticker)
      .map(
        (c) =>
          `- ${c.ticker}: ${c.name} @ $${c.currentPrice || c.initialPrice || 100}`
      )
      .join('\n');

    const prompt = `You are generating initial portfolio positions for ${npcs.length} NPCs/traders in a prediction market simulation.

Each NPC should have realistic initial positions in companies they would naturally invest in based on their character, affiliations, and expertise.

AVAILABLE COMPANIES:
${companiesList}

NPCS TO INVEST:
${npcProfiles.join('\n\n')}

RULES:
1. Each NPC should invest in 2-5 companies that make sense for their character
2. Use their FULL target investment amount (distribute it across companies)
3. Larger positions in companies they're affiliated with or expert in
4. Consider their personality (aggressive vs conservative position sizing)
5. S_TIER NPCs: Larger, more concentrated positions
6. Lower tier NPCs: More diversified, smaller positions
7. Use exact ticker symbols from available companies list

EXAMPLES:
- AIlon Musk should be heavily invested in TESLAI, SPAICEX, NEURAILINK
- Sam AIltman should be deep in OPNAI
- Jeff BAIzos should have positions in AIMAZON
- Tech domain NPCs → tech company stocks
- Space domain NPCs → space company stocks

Return ONLY valid JSON array (no explanations):
[
  {
    "npcId": "exact-npc-id-from-above",
    "npcName": "NPC Name",
    "ticker": "TICKER",
    "orgName": "Company Name",
    "amount": 50000,
    "reasoning": "Why this makes sense for this character"
  }
]

Generate investments for ALL ${npcs.length} NPCs. Each NPC must have 2-5 investments totaling their target amount.`;

    // Note: The prompt requests a raw JSON array, so the response is already an array
    // if the LLM follows the prompt correctly. Schema validation is minimal here.
    const response = await llm.generateJSON<InitialInvestment[]>(
      prompt,
      {
        // Schema for array items validation (wrapped in investments property for compatibility)
        properties: {
          npcId: { type: 'string' },
          npcName: { type: 'string' },
          ticker: { type: 'string' },
          orgName: { type: 'string' },
          amount: { type: 'number' },
          reasoning: { type: 'string' },
        },
        required: [
          'npcId',
          'npcName',
          'ticker',
          'orgName',
          'amount',
          'reasoning',
        ],
      },
      {
        temperature: 0.7,
        maxTokens: 16000,
        format: 'json',
        promptType: 'generate_investments_batch',
      }
    );

    logger.debug(
      `LLM response type: ${typeof response}, is array: ${Array.isArray(response)}`,
      {
        responseKeys: response ? Object.keys(response) : [],
      },
      'InitialInvestment'
    );

    // Validate response is array
    const investments = Array.isArray(response) ? response : [];

    if (investments.length === 0) {
      logger.warn(
        'LLM returned empty array, using fallback',
        { npcCount: npcs.length },
        'InitialInvestment'
      );
      return InitialInvestmentService.generateFallbackInvestments(
        npcs,
        companies
      );
    }

    logger.info(
      `Generated ${investments.length} initial investments for batch`,
      {
        npcCount: npcs.length,
        investmentsCount: investments.length,
      },
      'InitialInvestment'
    );

    return investments;
  }

  /**
   * Fallback: Generate investments based on affiliations and character logic
   */
  private static generateFallbackInvestments(
    npcs: Array<{
      id: string;
      name: string;
      affiliations: string[];
      tradingBalance: string;
      tier?: string | null;
      domain?: string[];
    }>,
    companies: Array<{
      id: string;
      name: string;
      ticker: string | null;
    }>
  ): InitialInvestment[] {
    const investments: InitialInvestment[] = [];

    for (const npc of npcs) {
      const availableBalance = Number(npc.tradingBalance);
      // Invest 50-75% of balance (tier affects diversification)
      const investmentPercent =
        npc.tier === 'S_TIER' ? 0.6 : 0.5 + Math.random() * 0.25;
      const targetInvestment = Math.floor(availableBalance * investmentPercent);

      // Find companies matching affiliations (primary investments)
      const affiliatedCompanies = companies.filter(
        (c) =>
          c.ticker &&
          npc.affiliations.some(
            (aff) =>
              c.id.toLowerCase().includes(aff.toLowerCase()) ||
              c.name
                .toLowerCase()
                .replace(/\s/g, '')
                .includes(aff.toLowerCase().replace(/\s/g, ''))
          )
      );

      // Find companies matching domain expertise (secondary investments)
      const domainCompanies = companies.filter(
        (c) =>
          c.ticker &&
          npc.domain &&
          npc.domain.some((d) => c.id.toLowerCase().includes(d.toLowerCase()))
      );

      // Combine and deduplicate
      const priorityCompanies = [
        ...new Set([...affiliatedCompanies, ...domainCompanies]),
      ];

      // S_TIER: Concentrated positions (2-3 companies, 80% in top pick)
      // A_TIER: Moderate diversification (3-4 companies, 60% in top picks)
      // B/C_TIER: More diversified (4-5 companies, evenly split)
      let numCompanies = 3;
      let weightDistribution = [0.5, 0.3, 0.2]; // Default: 50%, 30%, 20%

      if (npc.tier === 'S_TIER') {
        numCompanies = 2;
        weightDistribution = [0.8, 0.2];
      } else if (npc.tier === 'A_TIER') {
        numCompanies = 3;
        weightDistribution = [0.6, 0.25, 0.15];
      } else {
        numCompanies = 4;
        weightDistribution = [0.4, 0.3, 0.2, 0.1];
      }

      // Select companies to invest in
      const selectedCompanies =
        priorityCompanies.length >= numCompanies
          ? priorityCompanies.slice(0, numCompanies)
          : [
              ...priorityCompanies,
              ...companies
                .filter((c) => c.ticker && !priorityCompanies.includes(c))
                .slice(0, numCompanies - priorityCompanies.length),
            ];

      // Distribute investment according to weights
      for (
        let i = 0;
        i < selectedCompanies.length && i < weightDistribution.length;
        i++
      ) {
        const company = selectedCompanies[i];
        if (!company || !company.ticker) continue;

        const weight = weightDistribution[i] || 1 / selectedCompanies.length;
        const amount = Math.floor(targetInvestment * weight);

        if (amount > 0) {
          const isAffiliated = affiliatedCompanies.includes(company);
          const isDomain = domainCompanies.includes(company);

          let reasoning = 'Diversified portfolio investment';
          if (isAffiliated) {
            reasoning = `Direct affiliation with ${company.name}`;
          } else if (isDomain) {
            reasoning = `Domain expertise in ${npc.domain?.join('/')}`;
          }

          investments.push({
            npcId: npc.id,
            npcName: npc.name,
            ticker: company.ticker,
            orgName: company.name,
            amount,
            reasoning,
          });
        }
      }
    }

    logger.info(
      `Fallback generated ${investments.length} investments for ${npcs.length} NPCs`,
      undefined,
      'InitialInvestment'
    );

    return investments;
  }

  /**
   * Execute a single investment by creating a Pool and PoolPosition
   */
  private static async executeInvestment(
    investment: InitialInvestment
  ): Promise<void> {
    // Get organization details from static registry with dynamic price
    const staticOrg = StaticDataRegistry.getAllOrganizations().find(
      (o) => o.ticker === investment.ticker
    );

    if (!staticOrg || !staticOrg.ticker) {
      throw new Error(`Organization not found for ticker ${investment.ticker}`);
    }

    const orgState = await getDbInstance().getOrganizationState(staticOrg.id);
    const org = {
      ...staticOrg,
      currentPrice: orgState?.currentPrice ?? staticOrg.initialPrice,
    };

    const entryPrice = org.currentPrice || org.initialPrice || 100;
    const shares = investment.amount / entryPrice;

    // Ensure Pool exists for this NPC (poolId = npcId for backward compatibility)
    const existingPool = await db.pool.findUnique({
      where: { id: investment.npcId },
    });

    if (!existingPool) {
      // Create Pool for NPC
      const now = new Date();
      await db.pool
        .create({
          data: {
            id: investment.npcId,
            npcActorId: investment.npcId,
            name: `${investment.npcName} Portfolio`,
            description: `Initial investment portfolio for ${investment.npcName}`,
            isActive: true,
            totalValue: '0',
            totalDeposits: '0',
            availableBalance: '0',
            lifetimePnL: '0',
            performanceFeeRate: 0.05,
            totalFeesCollected: '0',
            openedAt: now,
            updatedAt: now,
            status: 'ACTIVE',
          },
        })
        .catch((error) => {
          // Pool might already exist from race condition, that's fine
          const errorCode =
            error && typeof error === 'object' && 'code' in error
              ? error.code
              : null;
          if (errorCode !== 'P2002') {
            // P2002 = unique constraint (already exists)
            throw error;
          }
        });
    }

    // Create position
    const positionId = await generateSnowflakeId();
    const now = new Date();

    await db.poolPosition.create({
      data: {
        id: positionId,
        poolId: investment.npcId, // Use npcId as poolId
        marketType: 'perp',
        ticker: org.ticker,
        marketId: null,
        side: 'long', // Initial positions are all long
        entryPrice: entryPrice,
        currentPrice: entryPrice,
        size: Number(shares),
        shares: Number(shares),
        leverage: null,
        liquidationPrice: null,
        unrealizedPnL: 0,
        realizedPnL: null,
        openedAt: now,
        closedAt: null,
        updatedAt: now,
      },
    });

    // Deduct from NPC trading balance (atomic check to prevent negative balance)
    const debitResult = await db
      .update(actorState)
      .set({
        tradingBalance: sql`${actorState.tradingBalance} - ${investment.amount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(actorState.id, investment.npcId),
          gte(
            sql<number>`${actorState.tradingBalance}::numeric`,
            investment.amount
          )
        )
      )
      .returning({ id: actorState.id });

    if (debitResult.length === 0) {
      throw new Error(
        `Insufficient NPC balance for initial investment: ${investment.npcName} → ${investment.ticker} $${investment.amount}`
      );
    }

    // Record the trade
    await db.npcTrade.create({
      data: {
        id: await generateSnowflakeId(),
        npcActorId: investment.npcId,
        poolId: null,
        marketType: 'perp',
        ticker: org.ticker,
        action: 'open_long',
        side: 'long',
        amount: investment.amount,
        price: entryPrice,
        sentiment: null,
        reason: `Initial investment: ${investment.reasoning}`,
        executedAt: new Date(),
      },
    });

    logger.debug(
      `Executed initial investment: ${investment.npcName} → ${investment.ticker} $${investment.amount}`,
      undefined,
      'InitialInvestment'
    );
  }
}
