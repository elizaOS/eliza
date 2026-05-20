/**
 * Benchmark Runner for Autonomous Feed Agent
 *
 * Runs this agent through benchmark simulations to measure performance.
 * Uses the same decision-making logic but with a simulated A2A interface.
 */

import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

import fs from "node:fs";
import path from "node:path";

// Benchmark types (defined locally for examples)
// NOTE: Benchmark runner is disabled until simulation modules are available as packages
interface BenchmarkGameSnapshot {
  markets: unknown[];
  posts: unknown[];
  timestamp: number;
  ticks: Array<{ tick: number; markets: unknown[]; posts: unknown[] }>;
}

interface SimulationResult {
  id: string;
  totalTrades: number;
  totalPnL: number;
  winRate: number;
  avgROI: number;
  metrics: {
    totalPnl: number;
    predictionMetrics: {
      accuracy: number;
    };
    optimalityScore: number;
  };
}

const LOG_DIR = "./logs";
const LOG_FILE = path.join(LOG_DIR, "benchmark.log");

function log(message: string, level: "info" | "warn" | "error" = "info") {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

  console.log(logLine.trim());

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  fs.appendFileSync(LOG_FILE, logLine);
}

async function loadBenchmark(
  benchmarkFile: string,
): Promise<BenchmarkGameSnapshot> {
  const data = fs.readFileSync(benchmarkFile, "utf-8");
  return JSON.parse(data);
}

async function runBenchmark(
  benchmarkFile: string,
  outputDir: string,
): Promise<SimulationResult> {
  log("🎯 Starting Autonomous Agent Benchmark");
  log(`Benchmark: ${benchmarkFile}`);
  log(`Output: ${outputDir}`);

  // 1. Load benchmark
  log("📊 Loading benchmark data...");
  const snapshot = await loadBenchmark(benchmarkFile);
  log(`  Loaded: ${snapshot.ticks.length} ticks`);

  // 2. Dynamic import of benchmark modules
  log("🔧 Loading simulation modules...");

  // TODO: Benchmark simulation modules not yet available as packages
  // These would need to be migrated to @feed/testing or similar
  // For now, benchmark runner is disabled
  throw new Error(
    "Benchmark runner requires simulation modules that are not yet available as packages. " +
      "Please use the main app benchmark runner instead.",
  );

  // Placeholder types for when modules are available
  // const { SimulationEngine } = await import('@feed/testing/benchmark/SimulationEngine');
  // const { SimulationA2AInterface } = await import('@feed/testing/benchmark/SimulationA2AInterface');
  // const { MetricsVisualizer } = await import('@feed/testing/benchmark/MetricsVisualizer');

  // NOTE: All code below is unreachable due to throw above, but kept for reference
  // when simulation modules become available as packages
  /*
  // 3. Create simulation engine
  log('🎮 Creating simulation engine...');
  const simConfig = {
    snapshot,
    agentId: 'feed-typescript-agent',
    fastForward: true,
    responseTimeout: 30000,
  };

  const engine = new SimulationEngine(simConfig);

  // 4. Create A2A interface
  log('🔌 Creating simulation A2A interface...');
  const a2aInterface = new SimulationA2AInterface(
    engine,
    'feed-typescript-agent'
  );

  // 5. Initialize agent components
  log('🧠 Initializing agent memory and decision maker...');
  const memory = new AgentMemory({ maxEntries: 20 });

  const strategy = (process.env.AGENT_STRATEGY ?? 'balanced') as
    | 'conservative'
    | 'balanced'
    | 'aggressive'
    | 'social';
  const decisionMaker = new AgentDecisionMaker({
    strategy,
    groqApiKey: process.env.GROQ_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
  });

  log(`  Strategy: ${strategy}`);
  log(`  LLM Provider: ${decisionMaker.getProvider()}`);

  // 6. Run simulation loop
  log('🚀 Starting simulation loop...');
  let tickCount = 0;
  const totalTicks = snapshot.ticks.length;

  while (engine.getGameState().tick < totalTicks) {
    tickCount++;

    if (tickCount % 10 === 0 || tickCount === 1) {
      log(
        `  Tick ${tickCount}/${totalTicks} (${((tickCount / totalTicks) * 100).toFixed(0)}%)`
      );
    }

    await (async () => {
      // Gather context via A2A interface
      const portfolioResponse = (await a2aInterface.sendRequest(
        'a2a.getPortfolio'
      )) as { balance: number; positions: A2APerpPosition[]; pnl: number };
      const portfolio: {
        balance: number;
        positions: A2APerpPosition[];
        pnl: number;
      } = {
        balance: portfolioResponse?.balance ?? 10000,
        positions: portfolioResponse?.positions ?? [],
        pnl: portfolioResponse?.pnl ?? 0,
      };

      const predictionsResponse = (await a2aInterface.sendRequest(
        'a2a.getPredictions'
      )) as { predictions: PredictionMarket[] };
      const perpetualsResponse = (await a2aInterface.sendRequest(
        'a2a.getPerpetuals'
      )) as { perpetuals: PerpMarket[] };
      const feedResponse = (await a2aInterface.sendRequest('a2a.getFeed', {
        limit: 10,
      })) as { posts: FeedPost[] };

      const markets = {
        predictions: predictionsResponse?.predictions ?? [],
        perps: perpetualsResponse?.perpetuals ?? [],
      };

      const recentMemory = memory.getRecent(5);

      // Make decision
      const decision = await decisionMaker.decide({
        portfolio,
        markets,
        feed: feedResponse ? { posts: feedResponse.posts } : { posts: [] },
        memory: recentMemory,
      });

      // Execute action (if not HOLD)
      if (decision.action !== 'HOLD') {
        // Create a wrapper that matches A2AActionClient interface
        const actionClient: A2AActionClient = {
          buyShares: async (
            marketId: string,
            outcome: 'YES' | 'NO',
            amount: number
          ) => {
            const result = await a2aInterface.buyShares(
              marketId,
              outcome,
              amount
            );
            return result as Record<string, JsonValue>;
          },
          sellShares: async (positionId: string, shares: number) => {
            const result = await a2aInterface.sellShares(positionId, shares);
            return result as Record<string, JsonValue>;
          },
          openPosition: async (
            ticker: string,
            side: 'LONG' | 'SHORT',
            amount: number,
            leverage: number
          ) => {
            // Convert LONG/SHORT to long/short for SimulationA2AInterface
            const simSide = side === 'LONG' ? 'long' : 'short';
            const result = await a2aInterface.openPosition(
              ticker,
              simSide,
              amount,
              leverage
            );
            return result as Record<string, JsonValue>;
          },
          closePosition: async (positionId: string) => {
            const result = await a2aInterface.closePosition(positionId);
            return result as Record<string, JsonValue>;
          },
          createPost: async (content: string, type?: string) => {
            const result = await a2aInterface.createPost(content, type);
            return result as Record<string, JsonValue>;
          },
          createComment: async (postId: string, content: string) => {
            const result = await a2aInterface.createComment(postId, content);
            return result as Record<string, JsonValue>;
          },
        };

        const result = await executeAction(actionClient, decision);

        if (result.success) {
          memory.add({
            action: decision.action,
            params: decision.params ?? {},
            result: result.data ?? {},
            timestamp: Date.now(),
          });
        }
      }

      // Advance tick
      engine.advanceTick();
    })().catch((error: Error) => {
      log(`  ⚠️  Error on tick ${tickCount}: ${error.message}`, 'warn');
      // Continue anyway
      engine.advanceTick();
    });
  }

  log(`✅ Simulation complete: ${tickCount} ticks processed`);

  // 7. Get final results
  log('📊 Collecting results...');
  const result = await engine.run();

  // 8. Save results
  log('💾 Saving results...');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(outputDir, 'result.json'),
    JSON.stringify(result, null, 2)
  );

  fs.writeFileSync(
    path.join(outputDir, 'metrics.json'),
    JSON.stringify(result.metrics, null, 2)
  );

  // 9. Generate visualizations
  log('📈 Generating visualizations...');
  await MetricsVisualizer.visualizeSingleRun(result, {
    outputDir,
    generateHtml: true,
    generateCsv: true,
    generateCharts: false,
  });

  log('✅ Benchmark Complete!');
  log('');
  log('Results:');
  log(`  Total P&L: $${result.metrics.totalPnl.toFixed(2)}`);
  log(
    `  Prediction Accuracy: ${(result.metrics.predictionMetrics.accuracy * 100).toFixed(1)}%`
  );
  log(
    `  Perp Win Rate: ${(result.metrics.perpMetrics.winRate * 100).toFixed(1)}%`
  );
  log(`  Optimality Score: ${result.metrics.optimalityScore.toFixed(1)}%`);
  log(
    `  Duration: ${(result.metrics.timing.totalDuration / 1000).toFixed(1)}s`
  );
  log('');
  log(`View report: file://${path.join(outputDir, 'index.html')}`);

  return result;
  */

  // Unreachable - return placeholder to satisfy type checker
  return {
    id: "disabled",
    totalTrades: 0,
    totalPnL: 0,
    winRate: 0,
    avgROI: 0,
    metrics: {
      totalPnl: 0,
      predictionMetrics: { accuracy: 0 },
      optimalityScore: 0,
    },
  };
}

async function runMultiple(
  _benchmarkFile: string,
  _outputDir: string,
  _runs: number,
): Promise<{ runs: SimulationResult[]; comparison: unknown }> {
  // Benchmark runner is disabled - see runBenchmark function
  throw new Error(
    "Benchmark runner requires simulation modules that are not yet available as packages.",
  );

  // Unreachable code kept for reference
  /*
  log(`🔄 Running ${runs} benchmark iterations`);

  const results: SimulationResult[] = [];

  for (let i = 0; i < runs; i++) {
    log('');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`Run ${i + 1}/${runs}`);
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const runDir = path.join(outputDir, `run-${i + 1}`);
    const result = await runBenchmark(benchmarkFile, runDir);
    results.push(result);

    // Delay between runs
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Calculate comparison metrics
  const calculateAverage = (getValue: (r: SimulationResult) => number) =>
    results.reduce((sum, r) => sum + getValue(r), 0) / runs;

  const avgPnl = calculateAverage((r) => r.metrics.totalPnl);
  const avgAccuracy = calculateAverage(
    (r) => r.metrics.predictionMetrics.accuracy
  );
  const avgOptimality = calculateAverage((r) => r.metrics.optimalityScore);

  const bestRun = results.reduce((best, r) =>
    r.metrics.totalPnl > best.metrics.totalPnl ? r : best
  );
  const worstRun = results.reduce((worst, r) =>
    r.metrics.totalPnl < worst.metrics.totalPnl ? r : worst
  );

  const comparison = {
    runs: results,
    comparison: {
      avgPnl,
      avgAccuracy,
      avgOptimality,
      bestRun: bestRun.id,
      worstRun: worstRun.id,
    },
  };

  fs.writeFileSync(
    path.join(outputDir, 'comparison.json'),
    JSON.stringify(comparison, null, 2)
  );

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('🏆 ALL BENCHMARKS COMPLETE');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`  Runs: ${runs}`);
  log(`  Avg P&L: $${avgPnl.toFixed(2)}`);
  log(`  Avg Accuracy: ${(avgAccuracy * 100).toFixed(1)}%`);
  log(`  Avg Optimality: ${avgOptimality.toFixed(1)}%`);
  log('');
  log(`Results: ${outputDir}`);
  */

  // Unreachable - return placeholder to satisfy type checker
  return {
    runs: [],
    comparison: {},
  };
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  const benchmarkFile = args
    .find((a) => a.startsWith("--benchmark="))
    ?.split("=")[1];
  const outputDir =
    args.find((a) => a.startsWith("--output="))?.split("=")[1] ??
    `./benchmark-results/${Date.now()}`;
  const runs = Number.parseInt(
    args.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? "1",
    10,
  );

  if (!benchmarkFile) {
    console.error("Error: --benchmark is required");
    console.log("\nUsage:");
    console.log(
      "  bun run src/benchmark-runner.ts --benchmark=path/to/benchmark.json [options]",
    );
    console.log("\nOptions:");
    console.log("  --output=path/to/results  Output directory");
    console.log("  --runs=5                  Number of runs (default: 1)");
    process.exit(1);
  }

  if (runs === 1) {
    await runBenchmark(benchmarkFile, outputDir);
  } else {
    await runMultiple(benchmarkFile, outputDir, runs);
  }
}

main();
