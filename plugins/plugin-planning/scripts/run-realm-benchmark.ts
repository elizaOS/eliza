#!/usr/bin/env node

console.log('🚀 Running REALM Benchmark for Planning Plugin...\n');

console.log('ℹ️  To run the benchmark, please ensure you have:');
console.log('   1. Built the project: npm run build');
console.log('   2. Set up test data in test-data/realm-bench/');
console.log('   3. Have necessary environment variables configured\n');

console.log('📌 For a quick benchmark demo, you can run:');
console.log('   bun test benchmarks\n');

console.log('📌 For the full benchmark suite:');
console.log('   1. Import and configure BenchmarkRunner in your code');
console.log('   2. Set up character and plugin configuration');
console.log('   3. Run the benchmarks programmatically\n');

console.log('Example usage:');
console.log(`
import { BenchmarkRunner } from '@elizaos/plugin-planning';

const config = {
  character: { name: 'BenchmarkAgent' },
  plugins: [],
  runRealmBench: true,
  runApiBank: false,
  outputDir: './benchmark-results',
  saveDetailedLogs: true,
  enableMetrics: true,
  enableMemoryTracking: true,
};

const runner = new BenchmarkRunner(config);
const results = await runner.runBenchmarks();
`);

console.log('\n✅ Benchmark runner is available in the planning plugin.');
