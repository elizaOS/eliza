#!/usr/bin/env bun

/**
 * Test Commands
 *
 * Commands:
 *   load     - Run load tests against the server
 *   a2a      - Run A2A protocol stress tests
 *   scambench-seed - Seed a ScamBench scenario into Feed chats
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getOption, parseArgs, wantsHelp } from '../lib/args.js';
import { logger } from '../lib/logger.js';

function printHelp(): void {
  console.log(`
Test Commands

USAGE:
  feed test <command> [options]

COMMANDS:
  load      Run load tests against the server
  a2a       Run A2A protocol stress tests
  scambench-seed  Seed a ScamBench scenario into Feed chats

OPTIONS (load):
  --scenario=NAME   Test scenario: light, normal, heavy, stress (default: normal)
  --url=URL         Base URL (default: http://localhost:3000)

OPTIONS (a2a):
  --scenario=NAME   Test scenario: light, normal, heavy, rate-limit, coalition (default: normal)
  --url=URL         Base URL (default: http://localhost:3000)

OPTIONS (scambench-seed):
  --scenario-id=ID  Scenario id from the ScamBench catalog
  --user-id=ID      Target Feed user id
  --catalog=PATH    Scenario catalog JSON (default: ../scambench/generated/scenario-catalog.json)
  --target-chats=N  Ensure user is seeded into at least N NPC group chats first (default: 3)

EXAMPLES:
  feed test load                       Normal load test
  feed test load --scenario=heavy      Heavy load test
  feed test a2a --scenario=rate-limit  Test rate limiting
  feed test scambench-seed --scenario-id=group-to-dm-asymmetric-info --user-id=123
`);
}

function resolveDefaultCatalogPath(): string {
  const candidates = [
    resolve(process.cwd(), '../scambench/generated/scenario-catalog.json'),
    resolve(process.cwd(), '../../scambench/generated/scenario-catalog.json'),
    resolve(process.cwd(), 'scambench/generated/scenario-catalog.json'),
    resolve(
      process.cwd(),
      '../benchmarks/scambench/generated/scenario-catalog.json'
    ),
    resolve(
      process.cwd(),
      '../../benchmarks/scambench/generated/scenario-catalog.json'
    ),
    resolve(
      process.cwd(),
      'benchmarks/scambench/generated/scenario-catalog.json'
    ),
  ];

  return (
    candidates.find((candidate) => Bun.file(candidate).exists()) ??
    candidates[0]!
  );
}

async function runScamBenchSeed(
  args: ReturnType<typeof parseArgs>
): Promise<void> {
  const scenarioId = getOption(args, 'scenario-id');
  const userId = getOption(args, 'user-id');
  const catalogPath = getOption(args, 'catalog') || resolveDefaultCatalogPath();
  const targetChatsPerUser = Number(getOption(args, 'target-chats') || '3');

  if (!scenarioId || !userId) {
    logger.fail('Missing required options: --scenario-id and --user-id');
    process.exit(1);
  }

  const catalogRaw = await readFile(resolve(catalogPath), 'utf-8');
  const catalog = JSON.parse(catalogRaw) as {
    scenarios?: Array<{
      id: string;
      name: string;
      preamble?: unknown[];
      liveAttacker?: { name: string };
      stages?: unknown[];
    }>;
  };

  const scenario = catalog.scenarios?.find((entry) => entry.id === scenarioId);
  if (!scenario) {
    logger.fail(`Scenario not found in catalog: ${scenarioId}`);
    process.exit(1);
  }

  const { seedScamBenchScenario } = await import('@feed/engine');
  const scenarioPayload = {
    id: scenario.id,
    name: scenario.name,
    preamble: Array.isArray(scenario.preamble)
      ? (scenario.preamble as Record<string, unknown>[])
      : [],
    liveAttacker: scenario.liveAttacker,
    stages: Array.isArray(scenario.stages)
      ? (scenario.stages as Record<string, unknown>[])
      : [],
  };
  const result = await seedScamBenchScenario({
    scenario: scenarioPayload as unknown as Parameters<
      typeof seedScamBenchScenario
    >[0]['scenario'],
    targetUserId: userId,
    targetChatsPerUser: Number.isFinite(targetChatsPerUser)
      ? Math.max(1, targetChatsPerUser)
      : 3,
    createMissingSpeakers: true,
  });

  logger.header('ScamBench Scenario Seeded');
  console.log(`Scenario: ${result.scenarioId}`);
  console.log(`Target user: ${result.targetUserId}`);
  console.log(`Auto-joined NPC chats: ${result.autoJoinedGroupChats}`);
  console.log(`Chats seeded: ${result.chats.length}`);
  console.log(`Messages seeded: ${result.messages.length}`);
  console.log(
    `Speakers created/resolved: ${Object.keys(result.speakerUserIds).join(', ')}`
  );
}

async function runLoadTest(args: ReturnType<typeof parseArgs>): Promise<void> {
  const scenario = getOption(args, 'scenario') || 'normal';
  const baseUrl = getOption(args, 'url') || 'http://localhost:3000';

  const validScenarios = ['light', 'normal', 'heavy', 'stress'];
  if (!validScenarios.includes(scenario)) {
    logger.fail(`Invalid scenario: ${scenario}`);
    console.log(`Valid scenarios: ${validScenarios.join(', ')}`);
    process.exit(1);
  }

  logger.header('Feed Load Test');
  console.log(`Scenario: ${scenario}`);
  console.log(`Base URL: ${baseUrl}\n`);

  // Import dynamically to avoid loading testing infrastructure if not needed
  const { LoadTestSimulator, TEST_SCENARIOS } = await import(
    '@feed/testing'
  );

  const scenarioKey = scenario.toUpperCase() as keyof typeof TEST_SCENARIOS;
  const config = TEST_SCENARIOS[scenarioKey];

  console.log(`Concurrent Users: ${config.concurrentUsers}`);
  console.log(`Duration: ${config.durationSeconds}s`);
  console.log(`Ramp-up: ${config.rampUpSeconds || 0}s\n`);

  // Check server
  const response = await fetch(`${baseUrl}/api/stats`);
  console.log(`✅ Server responding (status: ${response.status})\n`);

  // Enable query monitoring
  process.env.ENABLE_QUERY_MONITORING = 'true';

  // Run test
  const simulator = new LoadTestSimulator(baseUrl);

  process.on('SIGINT', () => {
    console.log('\n\n⚠️  Stopping test...');
    simulator.stop();
  });

  const result = await simulator.runTest(config);

  // Display results
  console.log('\n═══════════════════════════════════════');
  console.log('  Load Test Results');
  console.log('═══════════════════════════════════════\n');

  console.log(`Total Requests:      ${result.totalRequests.toLocaleString()}`);
  console.log(
    `Successful:          ${result.successfulRequests.toLocaleString()} (${(result.throughput.successRate * 100).toFixed(2)}%)`
  );
  console.log(`Failed:              ${result.failedRequests.toLocaleString()}`);
  console.log(`Duration:            ${(result.durationMs / 1000).toFixed(2)}s`);
  console.log(
    `Throughput:          ${result.throughput.requestsPerSecond.toFixed(2)} req/s`
  );

  console.log('\nResponse Times:');
  console.log(`  Min:               ${result.responseTime.min.toFixed(2)}ms`);
  console.log(`  Mean:              ${result.responseTime.mean.toFixed(2)}ms`);
  console.log(
    `  Median:            ${result.responseTime.median.toFixed(2)}ms`
  );
  console.log(`  95th Percentile:   ${result.responseTime.p95.toFixed(2)}ms`);
  console.log(`  99th Percentile:   ${result.responseTime.p99.toFixed(2)}ms`);
  console.log(`  Max:               ${result.responseTime.max.toFixed(2)}ms`);

  // Assessment
  const p95 = result.responseTime.p95;
  const successRate = result.throughput.successRate;

  console.log('\n═══════════════════════════════════════');
  console.log('  Assessment');
  console.log('═══════════════════════════════════════\n');

  if (successRate >= 0.99 && p95 < 200) {
    console.log('✅ EXCELLENT - System performing well under load');
  } else if (successRate >= 0.95 && p95 < 500) {
    console.log('⚠️  GOOD - System stable with room for optimization');
  } else if (successRate >= 0.9 && p95 < 1000) {
    console.log('⚠️  FAIR - System needs optimization');
  } else {
    console.log('❌ POOR - System has critical performance issues');
  }
}

async function runA2AStressTest(
  args: ReturnType<typeof parseArgs>
): Promise<void> {
  const scenario = getOption(args, 'scenario') || 'normal';
  const baseUrl = getOption(args, 'url') || 'http://localhost:3000';

  const validScenarios = [
    'light',
    'normal',
    'heavy',
    'rate-limit',
    'coalition',
  ];
  if (!validScenarios.includes(scenario)) {
    logger.fail(`Invalid scenario: ${scenario}`);
    console.log(`Valid scenarios: ${validScenarios.join(', ')}`);
    process.exit(1);
  }

  logger.header('A2A Protocol Stress Test');
  console.log(`Scenario: ${scenario}`);
  console.log(`Base URL: ${baseUrl}\n`);

  // Import dynamically
  const { LoadTestSimulator, A2A_TEST_SCENARIOS } = await import(
    '@feed/testing'
  );

  const scenarioKey = scenario
    .toUpperCase()
    .replace('-', '_') as keyof typeof A2A_TEST_SCENARIOS;
  const config = A2A_TEST_SCENARIOS[scenarioKey];

  console.log(`Concurrent Agents: ${config.concurrentUsers}`);
  console.log(`Duration: ${config.durationSeconds}s`);
  console.log(`Max RPS: ${config.maxRps || 'unlimited'}\n`);

  // Check A2A endpoint
  const response = await fetch(`${baseUrl}/api/a2a`);
  const data = await response.json();

  if (data.service !== 'Feed A2A Protocol') {
    logger.fail('A2A endpoint not responding correctly');
    process.exit(1);
  }
  console.log(`✅ A2A endpoint active (version: ${data.version})\n`);

  // Run test
  const simulator = new LoadTestSimulator(baseUrl);

  process.on('SIGINT', () => {
    console.log('\n\n⚠️  Stopping test...');
    simulator.stop();
  });

  const result = await simulator.runTest(config);

  // Display results
  console.log('\n═══════════════════════════════════════');
  console.log('  A2A Stress Test Results');
  console.log('═══════════════════════════════════════\n');

  console.log(`Total Requests:      ${result.totalRequests.toLocaleString()}`);
  console.log(
    `Successful:          ${result.successfulRequests.toLocaleString()} (${(result.throughput.successRate * 100).toFixed(2)}%)`
  );
  console.log(`Failed:              ${result.failedRequests.toLocaleString()}`);
  console.log(
    `Throughput:          ${result.throughput.requestsPerSecond.toFixed(2)} req/s`
  );

  console.log('\nResponse Times:');
  console.log(`  Mean:              ${result.responseTime.mean.toFixed(2)}ms`);
  console.log(`  95th Percentile:   ${result.responseTime.p95.toFixed(2)}ms`);
  console.log(`  99th Percentile:   ${result.responseTime.p99.toFixed(2)}ms`);

  // Rate limiting analysis
  type LoadTestError = { endpoint: string; error: string; count: number };
  const rateLimitErrors = result.errors.filter(
    (e: LoadTestError) =>
      e.error.includes('429') || e.error.toLowerCase().includes('rate limit')
  );
  const totalRateLimitErrors = rateLimitErrors.reduce(
    (sum: number, e: LoadTestError) => sum + e.count,
    0
  );

  console.log('\nRate Limiting:');
  console.log(`  Rate Limit Errors: ${totalRateLimitErrors.toLocaleString()}`);

  if (scenario === 'rate-limit') {
    if (totalRateLimitErrors > 0) {
      console.log('  ✅ Rate limiting is WORKING (expected in this test)');
    } else {
      console.log('  ⚠️  Rate limiting may NOT be working');
    }
  }
}

/**
 * Main entry point for test domain commands.
 *
 * @param args - Raw command-line arguments for the test domain
 */
export async function runTestCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (wantsHelp(parsed)) {
    printHelp();
    process.exit(0);
  }

  switch (parsed.command) {
    case 'load':
      await runLoadTest(parsed);
      break;

    case 'a2a':
      await runA2AStressTest(parsed);
      break;

    case 'scambench-seed':
      await runScamBenchSeed(parsed);
      break;

    default:
      if (parsed.command) {
        logger.fail(`Unknown command: ${parsed.command}`);
      }
      printHelp();
      process.exit(parsed.command ? 1 : 0);
  }
}
