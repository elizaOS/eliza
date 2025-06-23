/**
 * Benchmark CLI Commands
 * Enables external agents to participate in real-world benchmarks
 */

import { Command } from 'commander';
import { logger } from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { ScenarioRunner } from '../scenario-runner/index.js';
import { createMockRuntime } from '../utils/mock-runtime.js';
// Using built-in Node.js console formatting instead of external dependencies

interface BenchmarkOptions {
  port?: number;
  timeout?: number;
  verbose?: boolean;
  config?: string;
  dryRun?: boolean;
  maxCost?: number;
  environment?: 'sandbox' | 'production';
}

interface AgentRegistrationOptions {
  name: string;
  description: string;
  endpoint: string;
  token?: string;
  capabilities: string;
  security: 'sandbox' | 'trusted';
  maxCost: number;
}

interface BenchmarkRunOptions {
  agent: string;
  benchmark: string;
  parameters?: string;
  timeout?: number;
  channel?: string;
  realMoney?: boolean;
}

/**
 * Create the benchmark command group
 */
function createBenchmarkCommand(): Command {
  const benchmark = new Command('benchmark')
    .description('Real-world agent benchmarking platform')
    .option('-p, --port <port>', 'Server port', '3000')
    .option('-v, --verbose', 'Verbose logging')
    .option('--config <file>', 'Configuration file')
    .option('--environment <env>', 'Environment (sandbox|production)', 'sandbox');

  // Subcommand: List available benchmarks
  benchmark
    .command('list')
    .description('List all available benchmarks')
    .option('--category <category>', 'Filter by category')
    .option('--difficulty <level>', 'Filter by difficulty')
    .action(async (options) => {
      await listBenchmarks(options);
    });

  // Subcommand: Register external agent
  benchmark
    .command('register')
    .description('Register an external agent for benchmarking')
    .requiredOption('--name <name>', 'Agent name')
    .requiredOption('--description <desc>', 'Agent description')
    .requiredOption('--endpoint <url>', 'Agent API endpoint')
    .option('--token <token>', 'Authentication token')
    .requiredOption('--capabilities <caps>', 'Comma-separated capabilities')
    .option('--security <level>', 'Security level (sandbox|trusted)', 'sandbox')
    .option('--max-cost <amount>', 'Maximum benchmark cost (USD)', '100')
    .action(async (options: AgentRegistrationOptions) => {
      await registerAgent(options);
    });

  // Subcommand: Run benchmark
  benchmark
    .command('run')
    .description('Run a benchmark for an agent')
    .requiredOption('--agent <id>', 'Agent ID or name')
    .requiredOption('--benchmark <id>', 'Benchmark ID')
    .option('--parameters <json>', 'Benchmark parameters as JSON')
    .option('--timeout <ms>', 'Timeout in milliseconds', '3600000') // 1 hour
    .option('--channel <id>', 'Communication channel ID')
    .option('--real-money', 'Use real money (production only)')
    .action(async (options: BenchmarkRunOptions) => {
      await runBenchmark(options);
    });

  // Subcommand: View leaderboards
  benchmark
    .command('leaderboard')
    .description('View benchmark leaderboards')
    .option('--benchmark <id>', 'Specific benchmark type')
    .option('--limit <count>', 'Number of entries to show', '10')
    .option('--format <type>', 'Output format (table|json)', 'table')
    .action(async (options) => {
      await showLeaderboard(options);
    });

  // Subcommand: View agent history
  benchmark
    .command('history')
    .description('View agent benchmark history')
    .requiredOption('--agent <id>', 'Agent ID')
    .option('--limit <count>', 'Number of entries to show', '20')
    .option('--format <type>', 'Output format (table|json)', 'table')
    .action(async (options) => {
      await showAgentHistory(options);
    });

  // Subcommand: View real-time stats
  benchmark
    .command('stats')
    .description('View real-time benchmark statistics')
    .option('--watch', 'Watch mode (refresh every 30s)')
    .option('--format <type>', 'Output format (table|json)', 'table')
    .action(async (options) => {
      await showStats(options);
    });

  // Subcommand: Monitor benchmarks
  benchmark
    .command('monitor')
    .description('Monitor active benchmarks in real-time')
    .option('--agent <id>', 'Monitor specific agent')
    .option('--benchmark <type>', 'Monitor specific benchmark type')
    .action(async (options) => {
      await monitorBenchmarks(options);
    });

  // Subcommand: Validate agent setup
  benchmark
    .command('validate')
    .description('Validate agent setup for benchmarking')
    .requiredOption('--agent <id>', 'Agent ID or endpoint')
    .option('--benchmark <id>', 'Specific benchmark to validate for')
    .action(async (options) => {
      await validateAgent(options);
    });

  return benchmark;
}

/**
 * List available benchmarks
 */
async function listBenchmarks(options: any): Promise<void> {
  console.log('\n🎯 Available Real-World Benchmarks\n');

  try {
    const mockRuntime = createMockRuntime();
    const server = new AgentServer(mockRuntime);
    const runner = new ScenarioRunner(server, mockRuntime);

    const benchmarks = runner.getAvailableBenchmarks();

    const filteredBenchmarks = benchmarks
      .filter(benchmark => {
        if (options.category && benchmark.category !== options.category) return false;
        if (options.difficulty && benchmark.difficulty !== options.difficulty) return false;
        return true;
      })
      .map(benchmark => ({
        ID: benchmark.id,
        Name: benchmark.name,
        Category: benchmark.category,
        Difficulty: benchmark.difficulty,
        'Est. Cost (USD)': `$${benchmark.estimatedCost.min}-${benchmark.estimatedCost.max}`,
        Description: benchmark.description.substring(0, 60) + (benchmark.description.length > 60 ? '...' : ''),
      }));

    if (filteredBenchmarks.length === 0) {
      console.log('No benchmarks found matching the criteria.');
    } else {
      console.table(filteredBenchmarks);
    }

    console.log(`\nFound ${filteredBenchmarks.length} available benchmarks`);
    console.log('Use "elizaos benchmark register" to register your agent');
    console.log('Use "elizaos benchmark run" to execute a benchmark\n');

  } catch (error) {
    console.error('❌ Error listing benchmarks:', error);
    process.exit(1);
  }
}

/**
 * Register an external agent
 */
async function registerAgent(options: AgentRegistrationOptions): Promise<void> {
  console.log('\n🤖 Registering External Agent\n');

  try {
    const mockRuntime = createMockRuntime();
    const server = new AgentServer(mockRuntime);
    const runner = new ScenarioRunner(server, mockRuntime);

    const capabilities = options.capabilities.split(',').map(c => c.trim());
    const maxCost = parseFloat(options.maxCost.toString());

    const agentId = await runner.registerExternalAgent({
      name: options.name,
      description: options.description,
      apiEndpoint: options.endpoint,
      authToken: options.token,
      capabilities,
      securityLevel: options.security,
      maxBenchmarkCost: maxCost,
    });

    console.log('✅ Agent registered successfully!');
    console.log(`Agent ID: ${agentId}`);
    console.log(`Security Level: ${options.security}`);
    console.log(`Max Cost: $${maxCost}`);
    console.log(`Capabilities: ${capabilities.join(', ')}\n`);

    console.log('Next Steps:');
    console.log('1. Use "elizaos benchmark validate" to test your agent');
    console.log('2. Use "elizaos benchmark run" to execute benchmarks');
    console.log('3. Monitor progress with "elizaos benchmark monitor"\n');

  } catch (error) {
    console.error('❌ Error registering agent:', error);
    process.exit(1);
  }
}

/**
 * Run a benchmark
 */
async function runBenchmark(options: BenchmarkRunOptions): Promise<void> {
  console.log(`\n🚀 Running Benchmark: ${options.benchmark}\n`);

  try {
    const mockRuntime = createMockRuntime();
    const server = new AgentServer(mockRuntime);
    const runner = new ScenarioRunner(server, mockRuntime);

    // Parse parameters
    let parameters = {};
    if (options.parameters) {
      try {
        parameters = JSON.parse(options.parameters);
      } catch (error) {
        console.error('❌ Invalid parameters JSON:', error);
        process.exit(1);
      }
    }

    console.log('Starting benchmark execution...');
    console.log(`Agent: ${options.agent}`);
    console.log(`Benchmark: ${options.benchmark}`);
    console.log(`Parameters: ${JSON.stringify(parameters, null, 2)}`);
    console.log(`Real Money: ${options.realMoney ? 'YES' : 'NO'}\n`);

    let result;
    if (options.benchmark === 'defi-portfolio-v1') {
      result = await runner.runDeFiBenchmark(options.agent, {
        initialBalance: parameters.initialBalance || 1000,
        riskTolerance: parameters.riskTolerance || 'moderate',
        timeHorizon: parameters.timeHorizon || 3600000, // 1 hour
        channelId: options.channel,
        ...parameters,
      });
    } else if (options.benchmark === 'ecommerce-store-v1') {
      result = await runner.runEcommerceBenchmark(options.agent, {
        initialCapital: parameters.initialCapital || 500,
        businessType: parameters.businessType || 'dropshipping',
        targetMarket: parameters.targetMarket || ['US'],
        timeHorizon: parameters.timeHorizon || 7200000, // 2 hours
        channelId: options.channel,
        ...parameters,
      });
    } else {
      console.error(`❌ Unknown benchmark: ${options.benchmark}`);
      process.exit(1);
    }

    // Display results
    console.log('\n✅ Benchmark completed successfully!\n');
    
    const resultsData = [
      { Metric: 'Overall Score', Value: `${(result.score.overallScore * 100).toFixed(1)}%` },
      { Metric: 'Rank', Value: `#${result.score.ranking.overall}` },
      { Metric: 'Percentile', Value: `${result.score.percentile.toFixed(1)}th` },
      { Metric: 'Total Cost', Value: `$${result.benchmarkResult.totalCost.toFixed(2)}` },
      { Metric: 'Duration', Value: `${(result.benchmarkResult.duration / 1000).toFixed(0)}s` },
      { Metric: 'Technical Score', Value: `${(result.score.categoryScores.technical * 100).toFixed(1)}%` },
      { Metric: 'Economic Score', Value: `${(result.score.categoryScores.economic * 100).toFixed(1)}%` },
      { Metric: 'Efficiency Score', Value: `${(result.score.categoryScores.efficiency * 100).toFixed(1)}%` },
      { Metric: 'Reliability Score', Value: `${(result.score.categoryScores.reliability * 100).toFixed(1)}%` },
      { Metric: 'Innovation Score', Value: `${(result.score.categoryScores.innovation * 100).toFixed(1)}%` }
    ];

    console.table(resultsData);

    if (result.score.improvementSuggestions.length > 0) {
      console.log('\n💡 Improvement Suggestions:');
      result.score.improvementSuggestions.forEach((suggestion, i) => {
        console.log(`${i + 1}. ${suggestion}`);
      });
    }

    console.log(`\n🏆 Leaderboard Position: #${result.score.ranking.overall}`);
    console.log('Use "elizaos benchmark leaderboard" to see full rankings\n');

  } catch (error) {
    console.error('❌ Error running benchmark:', error);
    process.exit(1);
  }
}

/**
 * Show leaderboard
 */
async function showLeaderboard(options: any): Promise<void> {
  console.log('\n🏆 Benchmark Leaderboards\n');

  try {
    const mockRuntime = createMockRuntime();
    const server = new AgentServer(mockRuntime);
    const runner = new ScenarioRunner(server, mockRuntime);

    const benchmarkTypes = options.benchmark ? [options.benchmark] : ['defi_portfolio', 'ecommerce_store'];
    const limit = parseInt(options.limit) || 10;

    for (const benchmarkType of benchmarkTypes) {
      const leaderboard = await runner.getBenchmarkLeaderboard(benchmarkType, limit);
      
      console.log(`${benchmarkType.toUpperCase()} LEADERBOARD`);
      
      if (options.format === 'json') {
        console.log(JSON.stringify(leaderboard, null, 2));
        continue;
      }

      const leaderboardData = leaderboard.map((entry, index) => ({
        Rank: `#${index + 1}`,
        Agent: entry.agentId.substring(0, 20) + '...',
        Score: `${(entry.overallScore * 100).toFixed(1)}%`,
        Cost: `$${entry.economicMetrics.totalCost.toFixed(0)}`,
        Date: new Date(entry.timestamp).toLocaleDateString(),
      }));

      if (leaderboardData.length === 0) {
        console.log('No entries found for this benchmark.');
      } else {
        console.table(leaderboardData);
      }
      console.log('');
    }

  } catch (error) {
    console.error('❌ Error showing leaderboard:', error);
    process.exit(1);
  }
}

/**
 * Show agent history
 */
async function showAgentHistory(options: any): Promise<void> {
  console.log(`\n📊 Agent History: ${options.agent}\n`);

  try {
    const mockRuntime = createMockRuntime();
    const server = new AgentServer(mockRuntime);
    const runner = new ScenarioRunner(server, mockRuntime);

    const history = await runner.getAgentBenchmarkHistory(options.agent);
    const limit = parseInt(options.limit) || 20;
    const recentHistory = history.slice(0, limit);

    if (options.format === 'json') {
      console.log(JSON.stringify(recentHistory, null, 2));
      return;
    }

    const historyData = recentHistory.map(entry => ({
      Date: new Date(entry.timestamp).toLocaleString(),
      Benchmark: entry.benchmarkType,
      Score: `${(entry.overallScore * 100).toFixed(1)}%`,
      Rank: `#${entry.ranking.overall}`,
      Cost: `$${entry.economicMetrics.totalCost.toFixed(0)}`,
    }));

    if (historyData.length === 0) {
      console.log('No benchmark history found for this agent.');
    } else {
      console.table(historyData);
    }

    console.log(`\nShowing ${recentHistory.length} of ${history.length} total benchmark runs\n`);

  } catch (error) {
    console.error('❌ Error showing agent history:', error);
    process.exit(1);
  }
}

/**
 * Show real-time stats
 */
async function showStats(options: any): Promise<void> {
  const refreshStats = async () => {
    console.clear();
    console.log('\n📈 Real-Time Benchmark Statistics\n');

    try {
      const mockRuntime = createMockRuntime();
      const server = new AgentServer(mockRuntime);
      const runner = new ScenarioRunner(server, mockRuntime);

      const stats = await runner.getBenchmarkStats();

      if (options.format === 'json') {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      const statsData = [
        { Metric: 'Active Benchmarks', Value: stats.activeBenchmarks },
        { Metric: 'Registered Agents', Value: stats.registeredAgents.length },
        { Metric: 'Total Benchmarks Run', Value: stats.totalBenchmarks || 0 },
        { Metric: 'Total Costs', Value: `$${stats.totalCosts.toFixed(2)}` },
        { Metric: 'Average Score', Value: `${((stats.averageScore || 0) * 100).toFixed(1)}%` },
        { Metric: 'Cost Tracker Status', Value: stats.platformStatus.costTracker },
        { Metric: 'Message Bus Status', Value: stats.platformStatus.messageBus },
        { Metric: 'Task Executor Status', Value: stats.platformStatus.taskExecutor },
        { Metric: 'Scoring System Status', Value: stats.platformStatus.scoringSystem }
      ];

      console.table(statsData);
      console.log(`\nLast updated: ${new Date().toLocaleString()}`);

      if (options.watch) {
        console.log('\n⏱️  Refreshing in 30 seconds... (Press Ctrl+C to exit)');
      }

    } catch (error) {
      console.error('❌ Error showing stats:', error);
      if (!options.watch) process.exit(1);
    }
  };

  await refreshStats();

  if (options.watch) {
    const interval = setInterval(refreshStats, 30000);
    
    process.on('SIGINT', () => {
      clearInterval(interval);
      console.log('\n\nMonitoring stopped.\n');
      process.exit(0);
    });
  }
}

/**
 * Monitor benchmarks in real-time
 */
async function monitorBenchmarks(options: any): Promise<void> {
  console.log('\n👀 Real-Time Benchmark Monitor\n');
  console.log('Monitoring active benchmarks... (Press Ctrl+C to exit)\n');

  try {
    const mockRuntime = createMockRuntime();
    const server = new AgentServer(mockRuntime);
    const runner = new ScenarioRunner(server, mockRuntime);

    // Start real-time monitoring
    await runner.startRealtimeMonitoring();

    // This would be a real-time stream in a full implementation
    console.log('✅ Real-time monitoring started');
    console.log('📊 Monitoring benchmarks...');
    
    // Keep the process alive
    process.on('SIGINT', async () => {
      console.log('\n\nStopping monitoring...');
      await runner.stopAllBenchmarks();
      console.log('✅ Monitoring stopped.\n');
      process.exit(0);
    });

    // Prevent the process from exiting
    setInterval(() => {
      // Keep alive
    }, 1000);

  } catch (error) {
    console.error('❌ Error starting monitoring:', error);
    process.exit(1);
  }
}

/**
 * Validate agent setup
 */
async function validateAgent(options: any): Promise<void> {
  console.log(`\n🔍 Validating Agent: ${options.agent}\n`);

  try {
    console.log('Running validation checks...');

    const mockRuntime = createMockRuntime();
    const server = new AgentServer(mockRuntime);
    const runner = new ScenarioRunner(server, mockRuntime);

    // Perform actual validation checks
    const validationResults = await runner.validateExternalAgent(options.agent, {
      benchmarkId: options.benchmark,
      includeCapabilityCheck: true,
      includeSecurityCheck: true,
      includeConnectivityCheck: true,
    });

    const validationData = validationResults.checks.map(check => ({
      Check: check.name,
      Status: check.passed ? '✅ PASS' : '❌ FAIL',
      Details: check.details || check.error || 'No details',
    }));

    console.table(validationData);

    const passedChecks = validationResults.checks.filter(c => c.passed).length;
    const totalChecks = validationResults.checks.length;

    console.log(`\nValidation Results: ${passedChecks}/${totalChecks} checks passed`);
    
    if (validationResults.overall.passed) {
      console.log('\n✅ Agent validation successful!');
      console.log('Your agent is ready for benchmarking.\n');
      
      if (validationResults.recommendations.length > 0) {
        console.log('💡 Recommendations:');
        validationResults.recommendations.forEach((rec, i) => {
          console.log(`${i + 1}. ${rec}`);
        });
        console.log('');
      }
    } else {
      console.log('\n❌ Agent validation failed!');
      console.log('Please fix the issues above before running benchmarks.\n');
      
      if (validationResults.criticalIssues.length > 0) {
        console.log('⚠️  Critical Issues:');
        validationResults.criticalIssues.forEach((issue, i) => {
          console.log(`${i + 1}. ${issue}`);
        });
        console.log('');
      }
      
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Error validating agent:', error);
    console.log('\nThis could indicate:');
    console.log('• Agent endpoint is not reachable');
    console.log('• Invalid agent ID or authentication');
    console.log('• Benchmark platform is not available');
    console.log('• Network connectivity issues\n');
    process.exit(1);
  }
}

// Export the command
export default createBenchmarkCommand();