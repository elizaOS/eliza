/**
 * Main test runner for benchmark performance testing
 */

import { ElizaSocketClient } from "./socket-client";
import { TestPrompt, TestResult, TestSession, ElizaResponse } from "./types";
import { validateResponse } from "./validation";
import { calculateMetrics, formatMetrics, generateHistogram, checkThresholds, generateSummaryReport } from "./performance-metrics";
import { config } from "./config";
import { typewriterPrompts } from "./prompts/typewriter";
import { multiverseMathPrompts } from "./prompts/multiverse-math";
import { relationalDataPrompts } from "./prompts/relational-data";
import * as fs from "fs";
import * as path from "path";

export class BenchmarkRunner {
  private client: ElizaSocketClient;
  private session: TestSession;
  private verbose: boolean;

  constructor(verbose: boolean = config.output.verbose) {
    this.client = new ElizaSocketClient();
    this.verbose = verbose;
    this.session = {
      sessionId: `bench-${Date.now()}`,
      startTime: Date.now(),
      results: [],
    };
  }

  /**
   * Initialize the runner and connect to ELIZA
   */
  async initialize(): Promise<void> {
    console.log("🚀 Initializing benchmark runner...");
    
    try {
      await this.client.connect();
      await this.client.waitForConnection();
      console.log("✅ Connected to ELIZA server");
      
      // Run warmup prompts
      if (config.test.warmupPrompts > 0) {
        console.log(`🔥 Running ${config.test.warmupPrompts} warmup prompts...`);
        await this.runWarmup();
      }
    } catch (error) {
      console.error("❌ Failed to initialize:", error);
      throw error;
    }
  }

  /**
   * Run warmup prompts to prime the system
   */
  private async runWarmup(): Promise<void> {
    const warmupPrompts = [
      "hello",
      "what can you do",
      "help",
    ];

    for (let i = 0; i < config.test.warmupPrompts && i < warmupPrompts.length; i++) {
      try {
        await this.client.sendMessage(warmupPrompts[i], 3000);
        await this.delay(config.test.delayBetweenPrompts);
      } catch (error) {
        // Ignore warmup errors
      }
    }
  }

  /**
   * Run all benchmark tests
   */
  async runAll(): Promise<void> {
    console.log("\n" + "=".repeat(60));
    console.log("STARTING BENCHMARK TESTS");
    console.log("=".repeat(60) + "\n");

    const categories: Array<{ name: string; prompts: TestPrompt[]; enabled: boolean }> = [
      { name: "Typewriter", prompts: typewriterPrompts, enabled: config.categories.typewriter },
      { name: "Multiverse Math", prompts: multiverseMathPrompts, enabled: config.categories.multiverseMath },
      { name: "Relational Data", prompts: relationalDataPrompts, enabled: config.categories.relationalData },
    ];

    const allMetrics = [];

    for (const category of categories) {
      if (!category.enabled) {
        console.log(`⏭️  Skipping ${category.name} (disabled in config)`);
        continue;
      }

      console.log(`\n📊 Running ${category.name} benchmarks...`);
      console.log("─".repeat(40));

      const results = await this.runCategory(category.prompts);
      const metrics = calculateMetrics(results, category.name);
      allMetrics.push(metrics);

      // Display results
      console.log(formatMetrics(metrics));
      
      if (this.verbose) {
        const responseTimes = results
          .filter(r => r.success)
          .map(r => r.responseTime);
        console.log(generateHistogram(responseTimes));
      }

      // Check thresholds
      const thresholdCheck = checkThresholds(metrics, config.thresholds);
      if (!thresholdCheck.passed) {
        console.log("⚠️  Threshold violations:");
        thresholdCheck.failures.forEach(f => console.log(`   - ${f}`));
      } else {
        console.log("✅ All thresholds passed");
      }

      // Add delay between categories
      await this.delay(1000);
    }

    // Generate summary report
    this.session.endTime = Date.now();
    this.session.metrics = allMetrics;

    console.log(generateSummaryReport(allMetrics));

    // Save results if configured
    if (config.output.saveResults) {
      await this.saveResults();
    }
  }

  /**
   * Run tests for a specific category
   */
  async runCategory(prompts: TestPrompt[]): Promise<TestResult[]> {
    const results: TestResult[] = [];

    for (const prompt of prompts) {
      console.log(`\n🧪 Testing: "${prompt.prompt}" (${prompt.id})`);
      
      // Run setup prompts if needed
      if (prompt.setup && prompt.setup.length > 0) {
        console.log("   📋 Running setup prompts...");
        for (const setupPrompt of prompt.setup) {
          await this.runSinglePrompt(setupPrompt, 1, false);
          await this.delay(config.test.delayBetweenPrompts);
        }
      }

      // Run the actual test multiple times
      const promptResults = await this.runSinglePrompt(
        prompt,
        config.test.runsPerPrompt,
        true
      );
      
      results.push(...promptResults);

      // Display summary for this prompt
      const successCount = promptResults.filter(r => r.success).length;
      const avgTime = promptResults.reduce((sum, r) => sum + r.responseTime, 0) / promptResults.length;
      
      console.log(`   ✓ Success rate: ${successCount}/${promptResults.length} (${(successCount/promptResults.length*100).toFixed(1)}%)`);
      console.log(`   ⏱️  Avg response time: ${avgTime.toFixed(2)}ms`);
      
      if (!promptResults[0].success && this.verbose) {
        console.log(`   ❌ Error: ${promptResults[0].error}`);
      }
    }

    return results;
  }

  /**
   * Run a single prompt multiple times
   */
  private async runSinglePrompt(
    prompt: TestPrompt,
    runs: number,
    collectResults: boolean
  ): Promise<TestResult[]> {
    const results: TestResult[] = [];

    for (let i = 0; i < runs; i++) {
      const startTime = Date.now();
      
      try {
        const response = await this.client.sendMessage(
          prompt.prompt,
          prompt.timeout || config.test.defaultTimeout
        );
        
        const responseTime = Date.now() - startTime;
        const validation = validateResponse(response, prompt);
        
        const result: TestResult = {
          promptId: prompt.id,
          prompt: prompt.prompt,
          success: validation.success,
          responseTime,
          response: response.text,
          matchedPatterns: validation.matchedPatterns,
          error: validation.error,
          timestamp: Date.now(),
        };

        if (collectResults) {
          results.push(result);
          this.session.results.push(result);
        }

        if (this.verbose && i === 0) {
          console.log(`   📝 Response: "${response.text.substring(0, 100)}${response.text.length > 100 ? '...' : ''}"`);
          if (response.actions && response.actions.length > 0) {
            console.log(`   🎯 Actions: ${response.actions.join(", ")}`);
          }
        }

      } catch (error: any) {
        const result: TestResult = {
          promptId: prompt.id,
          prompt: prompt.prompt,
          success: false,
          responseTime: Date.now() - startTime,
          response: "",
          matchedPatterns: [],
          error: error.message,
          timestamp: Date.now(),
        };

        if (collectResults) {
          results.push(result);
          this.session.results.push(result);
        }

        if (this.verbose) {
          console.log(`   ❌ Error: ${error.message}`);
        }
      }

      // Add delay between runs
      if (i < runs - 1) {
        await this.delay(config.test.delayBetweenPrompts);
      }
    }

    return results;
  }

  /**
   * Save test results to file
   */
  private async saveResults(): Promise<void> {
    const resultsDir = path.resolve(config.output.resultsDir);
    
    // Create results directory if it doesn't exist
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const filename = `benchmark-${this.session.sessionId}.json`;
    const filepath = path.join(resultsDir, filename);

    try {
      fs.writeFileSync(filepath, JSON.stringify(this.session, null, 2));
      console.log(`\n💾 Results saved to: ${filepath}`);
    } catch (error) {
      console.error("❌ Failed to save results:", error);
    }
  }

  /**
   * Cleanup and disconnect
   */
  async cleanup(): Promise<void> {
    console.log("\n🧹 Cleaning up...");
    this.client.disconnect();
  }

  /**
   * Utility to add delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Run specific category only
   */
  async runTypewriter(): Promise<void> {
    console.log("\n📊 Running Typewriter benchmarks only...");
    const results = await this.runCategory(typewriterPrompts);
    const metrics = calculateMetrics(results, "Typewriter");
    console.log(formatMetrics(metrics));
    
    if (config.output.saveResults) {
      this.session.metrics = [metrics];
      await this.saveResults();
    }
  }

  async runMultiverseMath(): Promise<void> {
    console.log("\n📊 Running Multiverse Math benchmarks only...");
    const results = await this.runCategory(multiverseMathPrompts);
    const metrics = calculateMetrics(results, "Multiverse Math");
    console.log(formatMetrics(metrics));
    
    if (config.output.saveResults) {
      this.session.metrics = [metrics];
      await this.saveResults();
    }
  }

  async runRelationalData(): Promise<void> {
    console.log("\n📊 Running Relational Data benchmarks only...");
    const results = await this.runCategory(relationalDataPrompts);
    const metrics = calculateMetrics(results, "Relational Data");
    console.log(formatMetrics(metrics));
    
    if (config.output.saveResults) {
      this.session.metrics = [metrics];
      await this.saveResults();
    }
  }
}
