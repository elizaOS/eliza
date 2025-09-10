#!/usr/bin/env node

/**
 * Main entry point for benchmark testing
 */

import { BenchmarkRunner } from "./runner";
import { config } from "./config";

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || "all";
const verbose = args.includes("--verbose") || args.includes("-v");

// Override verbose setting if provided
if (verbose) {
  config.output.verbose = true;
}

// Display configuration
console.log("🔧 Benchmark Configuration:");
console.log(`   Server: ${config.server.url}`);
console.log(`   Categories: Typewriter=${config.categories.typewriter}, Math=${config.categories.multiverseMath}, Relational=${config.categories.relationalData}`);
console.log(`   Runs per prompt: ${config.test.runsPerPrompt}`);
console.log(`   Verbose: ${config.output.verbose}`);
console.log(`   Save results: ${config.output.saveResults}`);

async function main() {
  const runner = new BenchmarkRunner(verbose);
  
  try {
    // Initialize connection
    await runner.initialize();
    
    // Run tests based on command
    switch (command) {
      case "typewriter":
        await runner.runTypewriter();
        break;
      case "math":
      case "multiverse":
        await runner.runMultiverseMath();
        break;
      case "relational":
      case "data":
        await runner.runRelationalData();
        break;
      case "all":
      default:
        await runner.runAll();
        break;
    }
    
  } catch (error) {
    console.error("❌ Benchmark failed:", error);
    process.exit(1);
  } finally {
    await runner.cleanup();
  }
}

// Display usage information
function showUsage() {
  console.log(`
Usage: npx tsx test-scripts/index.ts [command] [options]

Commands:
  all          Run all benchmark categories (default)
  typewriter   Run only typewriter benchmarks
  math         Run only multiverse math benchmarks
  relational   Run only relational data benchmarks

Options:
  --verbose, -v    Show detailed output

Environment Variables:
  ELIZA_SERVER_URL         WebSocket URL (default: ws://localhost:3000)
  TEST_TYPEWRITER          Enable typewriter tests (default: true)
  TEST_MULTIVERSE_MATH     Enable math tests (default: true)
  TEST_RELATIONAL_DATA     Enable relational tests (default: true)
  VERBOSE                  Verbose output (default: false)

Examples:
  npx tsx test-scripts/index.ts                    # Run all tests
  npx tsx test-scripts/index.ts typewriter -v      # Run typewriter tests with verbose output
  npx tsx test-scripts/index.ts math               # Run only math tests
  
  ELIZA_SERVER_URL=ws://remote:3000 npx tsx test-scripts/index.ts all
  TEST_TYPEWRITER=false npx tsx test-scripts/index.ts all  # Skip typewriter tests
`);
}

// Show help if requested
if (args.includes("--help") || args.includes("-h")) {
  showUsage();
  process.exit(0);
}

// Run the main function
main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
