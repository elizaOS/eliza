/**
 * Archetype Matchup Benchmark
 *
 * Simulates multiple archetypes competing against each other to understand:
 * - Which archetypes perform best in different market conditions
 * - How archetypes interact (trader vs scammer, social-butterfly vs contrarian, etc.)
 * - Relative strengths and weaknesses
 *
 * Uses the multi-model orchestrator to efficiently run multiple archetype models.
 */

import {
  type ArchetypeConfig,
  ArchetypeConfigService,
} from "../archetypes/ArchetypeConfigService";
import {
  createMultiModelOrchestrator,
  type MultiModelOrchestrator,
} from "../training/MultiModelOrchestrator";
import { logger } from "../utils/logger";
import {
  type BenchmarkConfig,
  BenchmarkDataGenerator,
  type BenchmarkGameSnapshot,
  type Tick,
} from "./BenchmarkDataGenerator";

/**
 * Individual agent in the matchup simulation
 */
export interface MatchupAgent {
  id: string;
  archetype: string;
  config: ArchetypeConfig;
}

/**
 * Result for a single agent in the matchup
 */
export interface MatchupAgentResult {
  agentId: string;
  archetype: string;
  pnl: number;
  tradingMetrics: {
    totalTrades: number;
    winRate: number;
    avgPnlPerTrade: number;
  };
  socialMetrics: {
    postsCreated: number;
    engagementReceived: number;
    reputationGained: number;
  };
  actions: number;
  rank: number; // 1-based rank in this matchup
}

/**
 * Head-to-head comparison between two archetypes
 */
export interface ArchetypeVsResult {
  archetype1: string;
  archetype2: string;
  archetype1Wins: number;
  archetype2Wins: number;
  ties: number;
  archetype1AvgMargin: number;
  archetype2AvgMargin: number;
  winRate1: number;
  winRate2: number;
}

/**
 * Complete matchup benchmark result
 */
export interface MatchupBenchmarkResult {
  benchmarkId: string;
  timestamp: number;
  duration: number;

  /** All agents that participated */
  agents: MatchupAgentResult[];

  /** Overall archetype rankings across all matchups */
  archetypeRankings: Array<{
    archetype: string;
    avgRank: number;
    avgPnl: number;
    totalWins: number;
    totalLosses: number;
    winRate: number;
  }>;

  /** Head-to-head matchup results */
  headToHead: ArchetypeVsResult[];

  /** Market condition during benchmark */
  marketCondition: "bull" | "bear" | "volatile" | "stable";

  /** Insights derived from the matchup */
  insights: string[];
}

/**
 * Configuration for matchup benchmark
 */
export interface MatchupBenchmarkConfig {
  /** Archetypes to include in matchup (or 'all' for all archetypes) */
  archetypes: string[] | "all";

  /** Number of agents per archetype */
  agentsPerArchetype: number;

  /** Number of simulation rounds */
  rounds: number;

  /** Number of ticks per round */
  ticksPerRound: number;

  /** Market conditions to test */
  marketConditions: Array<"bull" | "bear" | "volatile" | "stable">;

  /** Available VRAM for model loading */
  availableVramGb: number;
}

/**
 * Runs multi-archetype benchmark simulations
 */
export class ArchetypeMatchupBenchmark {
  private config: MatchupBenchmarkConfig;
  private orchestrator: MultiModelOrchestrator;

  constructor(config: MatchupBenchmarkConfig) {
    this.config = config;
    this.orchestrator = createMultiModelOrchestrator(config.availableVramGb);
  }

  /**
   * Get all archetypes to benchmark
   */
  private getArchetypes(): string[] {
    if (this.config.archetypes === "all") {
      return ArchetypeConfigService.getAvailableArchetypes();
    }
    return this.config.archetypes;
  }

  /**
   * Create agents for the matchup
   */
  private createAgents(): MatchupAgent[] {
    const agents: MatchupAgent[] = [];
    const archetypes = this.getArchetypes();

    for (const archetype of archetypes) {
      const archetypeConfig = ArchetypeConfigService.getConfig(archetype);

      for (let i = 0; i < this.config.agentsPerArchetype; i++) {
        agents.push({
          id: `${archetype}-${i + 1}`,
          archetype,
          config: archetypeConfig,
        });
      }
    }

    return agents;
  }

  /**
   * Generate benchmark data for a market condition
   * Market condition affects seed to create different scenarios
   */
  private async generateBenchmarkData(
    condition: "bull" | "bear" | "volatile" | "stable",
  ): Promise<BenchmarkGameSnapshot> {
    // Convert ticks to duration minutes (assuming 1 tick per second)
    const durationMinutes = Math.ceil(this.config.ticksPerRound / 60);

    // Use condition to create different but reproducible seeds
    const conditionSeeds: Record<string, number> = {
      bull: 1001,
      bear: 2002,
      volatile: 3003,
      stable: 4004,
    };
    const baseSeed = conditionSeeds[condition] || 1000;

    const benchmarkConfig: BenchmarkConfig = {
      durationMinutes,
      tickInterval: 1,
      numPredictionMarkets: condition === "volatile" ? 8 : 5,
      numPerpetualMarkets: condition === "volatile" ? 5 : 3,
      numAgents: 10,
      seed: baseSeed + (Date.now() % 1000), // Semi-reproducible
    };

    const generator = new BenchmarkDataGenerator(benchmarkConfig);
    return generator.generate();
  }

  /**
   * Simulate a single round of the matchup
   */
  private async simulateRound(
    agents: MatchupAgent[],
    snapshot: BenchmarkGameSnapshot,
    roundNumber: number,
  ): Promise<MatchupAgentResult[]> {
    const results: MatchupAgentResult[] = [];

    logger.info(
      `Simulating round ${roundNumber} with ${agents.length} agents`,
      { archetypes: [...new Set(agents.map((a) => a.archetype))] },
      "ArchetypeMatchupBenchmark",
    );

    // Check if we should use real inference or simulation
    const useRealInference = process.env.USE_REAL_INFERENCE === "true";

    if (useRealInference) {
      // Use real model inference via the orchestrator
      for (const agent of agents) {
        const result = await this.runAgentWithRealModel(agent, snapshot);
        results.push(result);
      }
    } else {
      // Use simulated performance based on archetype characteristics
      for (const agent of agents) {
        const result = this.simulateAgentPerformance(agent, snapshot);
        results.push(result);
      }
    }

    // Assign ranks
    results.sort((a, b) => b.pnl - a.pnl);
    results.forEach((r, i) => {
      r.rank = i + 1;
    });

    return results;
  }

  /**
   * Run an agent with real model inference
   */
  private async runAgentWithRealModel(
    agent: MatchupAgent,
    snapshot: BenchmarkGameSnapshot,
  ): Promise<MatchupAgentResult> {
    let totalPnl = 0;
    let totalTrades = 0;
    let wins = 0;
    let postsCreated = 0;

    // Process a subset of ticks (every 10th tick to speed up)
    const ticksToProcess = snapshot.ticks
      .filter((_, i) => i % 10 === 0)
      .slice(0, 10);

    for (const tick of ticksToProcess) {
      // Build a prompt with the current game state
      const prompt = this.buildDecisionPrompt(agent, tick);

      // Get decision from model
      const response = await this.orchestrator.inference({
        archetype: agent.archetype,
        prompt,
        systemPrompt: agent.config.system,
        maxTokens: 256,
        temperature: 0.7,
      });

      // Parse the decision and simulate outcome
      const decision = this.parseAgentDecision(response.response);

      if (decision.action === "trade") {
        totalTrades++;
        // Simulate trade outcome based on market conditions
        const marketTrend = this.getMarketTrend(tick);
        const isCorrectDirection =
          (decision.direction === "long" && marketTrend > 0) ||
          (decision.direction === "short" && marketTrend < 0);
        if (isCorrectDirection) {
          wins++;
          totalPnl += Math.abs(marketTrend) * 100 * (decision.confidence || 1);
        } else {
          totalPnl -= Math.abs(marketTrend) * 50 * (decision.confidence || 1);
        }
      } else if (decision.action === "post") {
        postsCreated++;
      }
    }

    const winRate = totalTrades > 0 ? wins / totalTrades : 0;

    return {
      agentId: agent.id,
      archetype: agent.archetype,
      pnl: totalPnl,
      tradingMetrics: {
        totalTrades,
        winRate,
        avgPnlPerTrade: totalTrades > 0 ? totalPnl / totalTrades : 0,
      },
      socialMetrics: {
        postsCreated,
        engagementReceived: postsCreated * 5,
        reputationGained: postsCreated * 10 + wins * 5,
      },
      actions: totalTrades + postsCreated,
      rank: 0,
    };
  }

  /**
   * Build a decision prompt for the agent
   */
  private buildDecisionPrompt(agent: MatchupAgent, tick: Tick): string {
    const state = tick.state;
    // Find agent's balance from agents array
    const agentState = state.agents.find((a) => a.id === agent.id);
    const agentBalance =
      agentState?.totalPnl !== undefined ? 1000 + agentState.totalPnl : 1000;

    // Extract market prices from perpetual markets
    const marketPrices = Object.fromEntries(
      state.perpetualMarkets.map((m) => [m.ticker, m.price]),
    );

    // Recent posts can serve as "news"
    const recentNews = state.posts?.slice(-5).map((p) => p.content) || [];

    return `
Current game state:
- Timestamp: ${tick.timestamp}
- Your balance: ${agentBalance}
- Market prices: ${JSON.stringify(marketPrices)}
- Recent news: ${JSON.stringify(recentNews)}

As a ${agent.archetype} agent, what action would you take?
Respond with a JSON object containing:
- action: "trade" | "post" | "observe"
- direction: "long" | "short" (if trading)
- confidence: 0.0 to 1.0
- reasoning: brief explanation
`;
  }

  /**
   * Parse agent decision from model response
   */
  private parseAgentDecision(response: string): {
    action: "trade" | "post" | "observe";
    direction?: "long" | "short";
    confidence?: number;
  } {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          action: parsed.action || "observe",
          direction: parsed.direction,
          confidence: parsed.confidence || 0.5,
        };
      }
    } catch {
      // Failed to parse, default to observe
    }

    // Default behavior based on response content
    if (
      response.toLowerCase().includes("trade") ||
      response.toLowerCase().includes("buy") ||
      response.toLowerCase().includes("sell")
    ) {
      return {
        action: "trade",
        direction: response.toLowerCase().includes("short") ? "short" : "long",
        confidence: 0.5,
      };
    }

    if (
      response.toLowerCase().includes("post") ||
      response.toLowerCase().includes("share")
    ) {
      return { action: "post" };
    }

    return { action: "observe" };
  }

  /**
   * Get market trend from tick data
   */
  private getMarketTrend(tick: Tick): number {
    const state = tick.state;
    // Extract prices from perpetual markets
    if (state.perpetualMarkets.length === 0) return 0;

    const prices = Object.fromEntries(
      state.perpetualMarkets.map((m) => [m.ticker, m.price]),
    );

    // Calculate average price change
    const priceValues = Object.values(prices);
    if (priceValues.length === 0) return 0;

    const avgPrice =
      priceValues.reduce((a, b) => a + b, 0) / priceValues.length;
    // Normalize to -1 to 1 range
    return (avgPrice - 100) / 100;
  }

  /**
   * Simulate agent performance based on archetype characteristics
   * Used when real model inference is not available
   */
  private simulateAgentPerformance(
    agent: MatchupAgent,
    snapshot: BenchmarkGameSnapshot,
  ): MatchupAgentResult {
    const config = agent.config;
    const tickCount = snapshot.ticks.length;

    // Calculate expected performance based on archetype traits
    // Higher risk tolerance = higher variance in PnL
    const riskFactor = config.riskTolerance;
    const basePnl = (Math.random() - 0.5) * 1000 * riskFactor;

    // Trading-focused archetypes trade more
    const tradeWeight = config.actionWeights.trade;
    const totalTrades = Math.floor(tickCount * tradeWeight * 0.1);
    const winRate =
      0.45 + (config.riskTolerance < 0.5 ? 0.15 : -0.05) + Math.random() * 0.1;

    // Social-focused archetypes post more
    const postWeight = config.actionWeights.post;
    const postsCreated = Math.floor(tickCount * postWeight * 0.05);

    return {
      agentId: agent.id,
      archetype: agent.archetype,
      pnl: basePnl + (winRate > 0.5 ? 100 : -100) * Math.random(),
      tradingMetrics: {
        totalTrades,
        winRate,
        avgPnlPerTrade: basePnl / Math.max(totalTrades, 1),
      },
      socialMetrics: {
        postsCreated,
        engagementReceived: postsCreated * (2 + Math.random() * 5),
        reputationGained: postsCreated * 10,
      },
      actions: totalTrades + postsCreated,
      rank: 0, // Set after sorting
    };
  }

  /**
   * Calculate head-to-head results between archetypes
   */
  private calculateHeadToHead(
    allResults: MatchupAgentResult[][],
  ): ArchetypeVsResult[] {
    const archetypes = this.getArchetypes();
    const headToHead: ArchetypeVsResult[] = [];

    for (let i = 0; i < archetypes.length; i++) {
      for (let j = i + 1; j < archetypes.length; j++) {
        const arch1 = archetypes[i] as string;
        const arch2 = archetypes[j] as string;

        let wins1 = 0;
        let wins2 = 0;
        let ties = 0;
        let margin1Total = 0;
        let margin2Total = 0;

        // Compare performance in each round
        for (const roundResults of allResults) {
          const arch1Results = roundResults.filter(
            (r) => r.archetype === arch1,
          );
          const arch2Results = roundResults.filter(
            (r) => r.archetype === arch2,
          );

          if (arch1Results.length === 0 || arch2Results.length === 0) continue;

          const avgPnl1 =
            arch1Results.reduce((sum, r) => sum + r.pnl, 0) /
            arch1Results.length;
          const avgPnl2 =
            arch2Results.reduce((sum, r) => sum + r.pnl, 0) /
            arch2Results.length;

          if (avgPnl1 > avgPnl2) {
            wins1++;
            margin1Total += avgPnl1 - avgPnl2;
          } else if (avgPnl2 > avgPnl1) {
            wins2++;
            margin2Total += avgPnl2 - avgPnl1;
          } else {
            ties++;
          }
        }

        const totalGames = wins1 + wins2 + ties;
        headToHead.push({
          archetype1: arch1,
          archetype2: arch2,
          archetype1Wins: wins1,
          archetype2Wins: wins2,
          ties,
          archetype1AvgMargin: wins1 > 0 ? margin1Total / wins1 : 0,
          archetype2AvgMargin: wins2 > 0 ? margin2Total / wins2 : 0,
          winRate1: totalGames > 0 ? wins1 / totalGames : 0,
          winRate2: totalGames > 0 ? wins2 / totalGames : 0,
        });
      }
    }

    return headToHead;
  }

  /**
   * Calculate overall archetype rankings
   */
  private calculateRankings(
    allResults: MatchupAgentResult[][],
  ): MatchupBenchmarkResult["archetypeRankings"] {
    const archetypes = this.getArchetypes();
    const rankings: Map<
      string,
      {
        totalRank: number;
        totalPnl: number;
        wins: number;
        losses: number;
        count: number;
      }
    > = new Map();

    // Initialize
    for (const arch of archetypes) {
      rankings.set(arch, {
        totalRank: 0,
        totalPnl: 0,
        wins: 0,
        losses: 0,
        count: 0,
      });
    }

    // Aggregate results
    for (const roundResults of allResults) {
      const archetypeResults = new Map<string, number[]>();

      for (const result of roundResults) {
        const existing = archetypeResults.get(result.archetype) || [];
        existing.push(result.pnl);
        archetypeResults.set(result.archetype, existing);

        const stats = rankings.get(result.archetype);
        if (stats) {
          stats.totalRank += result.rank;
          stats.totalPnl += result.pnl;
          stats.count++;
          if (result.rank === 1) stats.wins++;
          if (result.rank === roundResults.length) stats.losses++;
        }
      }
    }

    return Array.from(rankings.entries())
      .map(([archetype, stats]) => ({
        archetype,
        avgRank: stats.count > 0 ? stats.totalRank / stats.count : 0,
        avgPnl: stats.count > 0 ? stats.totalPnl / stats.count : 0,
        totalWins: stats.wins,
        totalLosses: stats.losses,
        winRate: stats.count > 0 ? stats.wins / stats.count : 0,
      }))
      .sort((a, b) => a.avgRank - b.avgRank);
  }

  /**
   * Generate insights from the matchup results
   */
  private generateInsights(
    rankings: MatchupBenchmarkResult["archetypeRankings"],
    headToHead: ArchetypeVsResult[],
    marketCondition: string,
  ): string[] {
    const insights: string[] = [];

    // Top performer insight
    const topRanking = rankings[0];
    if (topRanking) {
      insights.push(
        `${topRanking.archetype} performed best in ${marketCondition} conditions with avg rank ${topRanking.avgRank.toFixed(2)}`,
      );
    }

    // Find dominant matchups
    for (const h2h of headToHead) {
      if (h2h.winRate1 >= 0.7) {
        insights.push(
          `${h2h.archetype1} dominates ${h2h.archetype2} (${(h2h.winRate1 * 100).toFixed(0)}% win rate)`,
        );
      } else if (h2h.winRate2 >= 0.7) {
        insights.push(
          `${h2h.archetype2} dominates ${h2h.archetype1} (${(h2h.winRate2 * 100).toFixed(0)}% win rate)`,
        );
      }
    }

    // Find rock-paper-scissors patterns
    const counters = this.findCounterArchetypes(headToHead);
    for (const counter of counters) {
      insights.push(counter);
    }

    return insights;
  }

  /**
   * Find archetype counter relationships (A beats B, B beats C, C beats A)
   */
  private findCounterArchetypes(headToHead: ArchetypeVsResult[]): string[] {
    const insights: string[] = [];
    const wins = new Map<string, Set<string>>();

    // Build win graph
    for (const h2h of headToHead) {
      if (h2h.winRate1 > 0.6) {
        const set = wins.get(h2h.archetype1) || new Set();
        set.add(h2h.archetype2);
        wins.set(h2h.archetype1, set);
      }
      if (h2h.winRate2 > 0.6) {
        const set = wins.get(h2h.archetype2) || new Set();
        set.add(h2h.archetype1);
        wins.set(h2h.archetype2, set);
      }
    }

    // Find triangles (rock-paper-scissors patterns)
    for (const [a, aWins] of wins) {
      for (const b of aWins) {
        const bWins = wins.get(b);
        if (bWins) {
          for (const c of bWins) {
            const cWins = wins.get(c);
            if (cWins?.has(a)) {
              insights.push(
                `Counter triangle found: ${a} → ${b} → ${c} → ${a}`,
              );
            }
          }
        }
      }
    }

    return insights;
  }

  /**
   * Run the complete matchup benchmark
   */
  async run(): Promise<MatchupBenchmarkResult[]> {
    const startTime = Date.now();
    const results: MatchupBenchmarkResult[] = [];

    logger.info(
      "Starting Archetype Matchup Benchmark",
      {
        archetypes: this.getArchetypes(),
        agentsPerArchetype: this.config.agentsPerArchetype,
        rounds: this.config.rounds,
        conditions: this.config.marketConditions,
      },
      "ArchetypeMatchupBenchmark",
    );

    const agents = this.createAgents();

    for (const condition of this.config.marketConditions) {
      logger.info(
        `Testing in ${condition} market conditions`,
        {},
        "ArchetypeMatchupBenchmark",
      );

      const allRoundResults: MatchupAgentResult[][] = [];

      for (let round = 0; round < this.config.rounds; round++) {
        const snapshot = await this.generateBenchmarkData(condition);
        const roundResults = await this.simulateRound(
          agents,
          snapshot,
          round + 1,
        );
        allRoundResults.push(roundResults);
      }

      // Flatten agent results for this condition
      const flatAgentResults = allRoundResults.flat();

      // Calculate aggregated results
      const headToHead = this.calculateHeadToHead(allRoundResults);
      const rankings = this.calculateRankings(allRoundResults);
      const insights = this.generateInsights(rankings, headToHead, condition);

      results.push({
        benchmarkId: `matchup-${condition}-${Date.now()}`,
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        agents: flatAgentResults,
        archetypeRankings: rankings,
        headToHead,
        marketCondition: condition,
        insights,
      });

      logger.info(
        `Completed ${condition} market benchmark`,
        {
          topArchetype: rankings[0]?.archetype,
          avgPnl: rankings[0]?.avgPnl.toFixed(2),
        },
        "ArchetypeMatchupBenchmark",
      );
    }

    // Cleanup
    this.orchestrator.unloadAll();

    const totalDuration = Date.now() - startTime;
    logger.info(
      "Archetype Matchup Benchmark complete",
      {
        totalDurationMs: totalDuration,
        conditionsTested: this.config.marketConditions.length,
        totalRounds: this.config.rounds * this.config.marketConditions.length,
      },
      "ArchetypeMatchupBenchmark",
    );

    return results;
  }

  /**
   * Generate a summary report of the matchup results
   */
  static generateReport(results: MatchupBenchmarkResult[]): string {
    const lines: string[] = [];
    lines.push("# Archetype Matchup Benchmark Report\n");

    for (const result of results) {
      lines.push(
        `## ${result.marketCondition.toUpperCase()} Market Conditions\n`,
      );

      // Rankings table
      lines.push("### Overall Rankings\n");
      lines.push("| Rank | Archetype | Avg PnL | Win Rate |");
      lines.push("|------|-----------|---------|----------|");
      for (const ranking of result.archetypeRankings) {
        lines.push(
          `| ${ranking.avgRank.toFixed(1)} | ${ranking.archetype} | ${ranking.avgPnl.toFixed(2)} | ${(ranking.winRate * 100).toFixed(1)}% |`,
        );
      }
      lines.push("");

      // Head-to-head table
      lines.push("### Head-to-Head Results\n");
      lines.push("| Matchup | Winner | Win Rate |");
      lines.push("|---------|--------|----------|");
      for (const h2h of result.headToHead) {
        const winner =
          h2h.winRate1 > h2h.winRate2 ? h2h.archetype1 : h2h.archetype2;
        const winRate = Math.max(h2h.winRate1, h2h.winRate2);
        lines.push(
          `| ${h2h.archetype1} vs ${h2h.archetype2} | ${winner} | ${(winRate * 100).toFixed(1)}% |`,
        );
      }
      lines.push("");

      // Insights
      if (result.insights.length > 0) {
        lines.push("### Key Insights\n");
        for (const insight of result.insights) {
          lines.push(`- ${insight}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }
}

/**
 * Run a quick matchup benchmark with sensible defaults
 */
export async function runQuickMatchupBenchmark(): Promise<
  MatchupBenchmarkResult[]
> {
  const benchmark = new ArchetypeMatchupBenchmark({
    archetypes: "all",
    agentsPerArchetype: 2,
    rounds: 5,
    ticksPerRound: 100,
    marketConditions: ["bull", "bear", "volatile", "stable"],
    availableVramGb: 16,
  });

  return benchmark.run();
}
