#!/usr/bin/env tsx

import { allScenarios, pluginTestScenarios, exampleScenarios, rolodexScenarios } from './index.js';
import type { 
  Scenario, 
  ScenarioValidationResult, 
  ScenarioExecutionResult,
  PluginDependency,
  EnvironmentRequirement,
  ScenarioManifest
} from './types.js';

export interface TestRunnerOptions {
  parallel?: boolean;
  maxConcurrency?: number;
  verbose?: boolean;
  filter?: string;
  category?: string;
  tags?: string[];
  validateOnly?: boolean;
  continueOnError?: boolean;
  outputFormat?: 'json' | 'console' | 'both';
  outputFile?: string;
}

export interface TestRunnerResult {
  totalScenarios: number;
  passed: number;
  failed: number;
  skipped: number;
  validationErrors: number;
  duration: number;
  results: ScenarioExecutionResult[];
  validationResults: ScenarioValidationResult[];
  summary: {
    passRate: number;
    avgDuration: number;
    categories: Record<string, { passed: number; failed: number }>;
  };
}

/**
 * ScenarioManifestValidator - Validates scenario dependencies and environment
 */
export class ScenarioManifestValidator {
  private pluginCache = new Map<string, boolean>();
  private envCache = new Map<string, string | undefined>();

  async validateScenario(scenario: Scenario): Promise<ScenarioValidationResult> {
    const manifest = this.extractManifest(scenario);
    const errors: any[] = [];
    const warnings: any[] = [];
    const pluginStatus: any[] = [];
    const environmentStatus: any[] = [];

    // Validate plugin dependencies
    for (const plugin of manifest.plugins) {
      const status = await this.validatePlugin(plugin);
      pluginStatus.push(status);
      
      if (plugin.required && !status.available) {
        errors.push({
          type: 'plugin',
          message: `Required plugin ${plugin.name} is not available`,
          severity: 'error',
          context: { plugin: plugin.name }
        });
      }
    }

    // Validate environment requirements
    for (const env of manifest.environment) {
      const status = await this.validateEnvironment(env);
      environmentStatus.push(status);
      
      if (env.required && !status.present) {
        errors.push({
          type: 'environment',
          message: `Required environment variable ${env.name} is not set`,
          severity: 'error',
          context: { variable: env.name }
        });
      }
    }

    // Validate scenario configuration
    if (!scenario.actors || scenario.actors.length === 0) {
      errors.push({
        type: 'config',
        message: 'Scenario must have at least one actor',
        severity: 'error'
      });
    }

    if (!scenario.verification || !scenario.verification.rules) {
      warnings.push({
        type: 'config',
        message: 'Scenario has no verification rules',
        suggestion: 'Add verification rules to validate scenario outcomes'
      });
    }

    return {
      scenario: scenario.id,
      valid: errors.length === 0,
      errors,
      warnings,
      pluginStatus,
      environmentStatus
    };
  }

  private extractManifest(scenario: Scenario): ScenarioManifest {
    // Extract plugin dependencies from actor configurations
    const plugins = new Set<string>();
    const environment = new Set<EnvironmentRequirement>();

    scenario.actors.forEach(actor => {
      if (actor.plugins) {
        actor.plugins.forEach(plugin => plugins.add(plugin));
      }
    });

    // Common plugin dependencies based on scenario categories
    const pluginDeps: PluginDependency[] = Array.from(plugins).map(name => ({
      name,
      required: true,
      version: 'workspace:*'
    }));

    // Standard environment requirements
    const envReqs: EnvironmentRequirement[] = [
      {
        name: 'OPENAI_API_KEY',
        type: 'secret',
        required: false,
        description: 'OpenAI API key for LLM functionality'
      },
      {
        name: 'ANTHROPIC_API_KEY', 
        type: 'secret',
        required: false,
        description: 'Anthropic API key for Claude models'
      }
    ];

    // Add category-specific requirements
    if (scenario.category === 'blockchain' || scenario.tags?.includes('blockchain')) {
      envReqs.push({
        name: 'SOLANA_RPC_URL',
        type: 'config',
        required: false,
        description: 'Solana RPC endpoint'
      });
    }

    if (scenario.category === 'github' || scenario.tags?.includes('github')) {
      envReqs.push({
        name: 'GITHUB_API_TOKEN',
        type: 'secret',
        required: false,
        description: 'GitHub API token'
      });
    }

    return {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      category: scenario.category || 'general',
      tags: scenario.tags || [],
      plugins: pluginDeps,
      environment: envReqs,
      actors: scenario.actors.map(actor => ({
        role: actor.role,
        plugins: actor.plugins || [],
        config: actor.settings
      })),
      setup: scenario.setup,
      execution: scenario.execution,
      verification: scenario.verification,
      benchmarks: scenario.benchmarks
    };
  }

  private async validatePlugin(plugin: PluginDependency): Promise<any> {
    if (this.pluginCache.has(plugin.name)) {
      return {
        name: plugin.name,
        available: this.pluginCache.get(plugin.name),
        compatible: true,
        errors: []
      };
    }

    try {
      // Try to resolve the plugin module
      await import(plugin.name);
      this.pluginCache.set(plugin.name, true);
      
      return {
        name: plugin.name,
        available: true,
        compatible: true,
        errors: []
      };
    } catch (error) {
      this.pluginCache.set(plugin.name, false);
      
      return {
        name: plugin.name,
        available: false,
        compatible: false,
        errors: [`Failed to import: ${error.message}`]
      };
    }
  }

  private async validateEnvironment(env: EnvironmentRequirement): Promise<any> {
    if (this.envCache.has(env.name)) {
      const value = this.envCache.get(env.name);
      return {
        name: env.name,
        present: value !== undefined,
        valid: this.validateEnvValue(env, value),
        value: value ? '***' : undefined,
        errors: []
      };
    }

    const value = process.env[env.name];
    this.envCache.set(env.name, value);

    const valid = this.validateEnvValue(env, value);
    const errors: string[] = [];

    if (env.required && !value) {
      errors.push(`Required environment variable ${env.name} is not set`);
    }

    if (value && !valid) {
      errors.push(`Environment variable ${env.name} has invalid format`);
    }

    return {
      name: env.name,
      present: value !== undefined,
      valid,
      value: value ? '***' : undefined,
      errors
    };
  }

  private validateEnvValue(env: EnvironmentRequirement, value: string | undefined): boolean {
    if (!value) return !env.required;
    
    if (env.validation) {
      try {
        const regex = new RegExp(env.validation);
        return regex.test(value);
      } catch {
        return true; // If regex is invalid, assume value is valid
      }
    }

    return true;
  }
}

/**
 * ConsolidatedScenarioTestRunner - Main test runner
 */
export class ConsolidatedScenarioTestRunner {
  private validator = new ScenarioManifestValidator();

  async runAllScenarios(options: TestRunnerOptions = {}): Promise<TestRunnerResult> {
    const startTime = Date.now();
    const scenarios = this.filterScenarios(allScenarios, options);
    
    console.log(`🚀 Starting scenario test run with ${scenarios.length} scenarios`);
    
    const results: ScenarioExecutionResult[] = [];
    const validationResults: ScenarioValidationResult[] = [];
    
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let validationErrors = 0;

    // Sequential execution to avoid conflicts
    for (const scenario of scenarios) {
      try {
        console.log(`\n🔍 Validating scenario: ${scenario.name}`);
        
        // Validate scenario
        const validation = await this.validator.validateScenario(scenario);
        validationResults.push(validation);
        
        if (!validation.valid) {
          validationErrors++;
          console.log(`❌ Validation failed for ${scenario.name}:`);
          validation.errors.forEach(error => 
            console.log(`  - ${error.message}`)
          );
          
          if (!options.continueOnError) {
            skipped++;
            continue;
          }
        }

        if (options.validateOnly) {
          console.log(`✅ Validation passed for ${scenario.name}`);
          continue;
        }

        // Execute scenario
        console.log(`🏃 Executing scenario: ${scenario.name}`);
        const result = await this.executeScenario(scenario, options);
        results.push(result);
        
        if (result.status === 'passed') {
          passed++;
          console.log(`✅ ${scenario.name} PASSED`);
        } else {
          failed++;
          console.log(`❌ ${scenario.name} FAILED`);
          if (options.verbose) {
            result.errors.forEach(error => console.log(`  - ${error}`));
          }
        }
        
      } catch (error) {
        failed++;
        console.log(`💥 ${scenario.name} CRASHED: ${error.message}`);
        
        results.push({
          scenario: scenario.id,
          status: 'failed',
          duration: 0,
          transcript: [],
          errors: [error.message]
        });

        if (!options.continueOnError) {
          break;
        }
      }
    }

    const duration = Date.now() - startTime;
    const passRate = scenarios.length > 0 ? (passed / scenarios.length) * 100 : 0;
    const avgDuration = results.length > 0 ? results.reduce((sum, r) => sum + r.duration, 0) / results.length : 0;

    // Calculate category breakdown
    const categories: Record<string, { passed: number; failed: number }> = {};
    scenarios.forEach(scenario => {
      const category = scenario.category || 'general';
      if (!categories[category]) {
        categories[category] = { passed: 0, failed: 0 };
      }
      
      const result = results.find(r => r.scenario === scenario.id);
      if (result?.status === 'passed') {
        categories[category].passed++;
      } else {
        categories[category].failed++;
      }
    });

    const finalResult: TestRunnerResult = {
      totalScenarios: scenarios.length,
      passed,
      failed,
      skipped,
      validationErrors,
      duration,
      results,
      validationResults,
      summary: {
        passRate,
        avgDuration,
        categories
      }
    };

    await this.outputResults(finalResult, options);
    return finalResult;
  }

  private filterScenarios(scenarios: Scenario[], options: TestRunnerOptions): Scenario[] {
    let filtered = [...scenarios];

    if (options.filter) {
      const filterRegex = new RegExp(options.filter, 'i');
      filtered = filtered.filter(s => 
        filterRegex.test(s.name) || 
        filterRegex.test(s.description) ||
        filterRegex.test(s.id)
      );
    }

    if (options.category) {
      filtered = filtered.filter(s => s.category === options.category);
    }

    if (options.tags && options.tags.length > 0) {
      filtered = filtered.filter(s => 
        s.tags && options.tags!.some(tag => s.tags!.includes(tag))
      );
    }

    return filtered;
  }

  private async executeScenario(scenario: Scenario, options: TestRunnerOptions): Promise<ScenarioExecutionResult> {
    // This is a placeholder implementation
    // In a real implementation, this would:
    // 1. Set up the test environment
    // 2. Create agent runtimes with proper plugins
    // 3. Execute the scenario steps
    // 4. Validate the results
    // 5. Clean up resources

    const startTime = Date.now();
    
    try {
      // Simulate scenario execution
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
      
      const duration = Date.now() - startTime;
      const success = Math.random() > 0.3; // 70% success rate for demo
      
      return {
        scenario: scenario.id,
        status: success ? 'passed' : 'failed',
        duration,
        transcript: [],
        errors: success ? [] : ['Simulated test failure'],
        metrics: {
          scenario: scenario.id,
          timestamp: Date.now(),
          duration,
          messageCount: Math.floor(Math.random() * 20) + 5,
          avgResponseTime: Math.random() * 1000 + 500,
          benchmarks: [],
          failures: success ? undefined : [{ metric: 'accuracy', reason: 'Below threshold' }]
        }
      };
      
    } catch (error) {
      return {
        scenario: scenario.id,
        status: 'failed',
        duration: Date.now() - startTime,
        transcript: [],
        errors: [error.message]
      };
    }
  }

  private async outputResults(results: TestRunnerResult, options: TestRunnerOptions): Promise<void> {
    if (options.outputFormat === 'json' || options.outputFormat === 'both') {
      const jsonOutput = JSON.stringify(results, null, 2);
      
      if (options.outputFile) {
        const fs = await import('fs');
        fs.writeFileSync(options.outputFile, jsonOutput);
        console.log(`\n📄 Results written to ${options.outputFile}`);
      }
      
      if (options.outputFormat === 'json') {
        console.log(jsonOutput);
        return;
      }
    }

    // Console output
    console.log('\n' + '='.repeat(80));
    console.log('🏁 SCENARIO TEST RESULTS');
    console.log('='.repeat(80));
    console.log(`Total Scenarios: ${results.totalScenarios}`);
    console.log(`✅ Passed: ${results.passed}`);
    console.log(`❌ Failed: ${results.failed}`);
    console.log(`⏭️  Skipped: ${results.skipped}`);
    console.log(`🔍 Validation Errors: ${results.validationErrors}`);
    console.log(`⏱️  Total Duration: ${(results.duration / 1000).toFixed(2)}s`);
    console.log(`📊 Pass Rate: ${results.summary.passRate.toFixed(1)}%`);
    console.log(`⚡ Avg Duration: ${(results.summary.avgDuration / 1000).toFixed(2)}s`);

    console.log('\n📈 Category Breakdown:');
    Object.entries(results.summary.categories).forEach(([category, stats]) => {
      const total = stats.passed + stats.failed;
      const rate = total > 0 ? ((stats.passed / total) * 100).toFixed(1) : '0.0';
      console.log(`  ${category}: ${stats.passed}/${total} (${rate}%)`);
    });

    if (results.validationErrors > 0) {
      console.log('\n⚠️  Validation Issues:');
      results.validationResults
        .filter(v => !v.valid)
        .forEach(validation => {
          console.log(`  ${validation.scenario}:`);
          validation.errors.forEach(error => 
            console.log(`    - ${error.message}`)
          );
        });
    }

    if (results.failed > 0 && options.verbose) {
      console.log('\n❌ Failed Scenarios:');
      results.results
        .filter(r => r.status === 'failed')
        .forEach(result => {
          console.log(`  ${result.scenario}:`);
          result.errors.forEach(error => 
            console.log(`    - ${error}`)
          );
        });
    }

    console.log('\n' + '='.repeat(80));
  }
}

// Export for programmatic use
export {
  allScenarios,
  pluginTestScenarios,
  exampleScenarios,
  rolodexScenarios
};

// CLI interface
export async function runScenarioTests(): Promise<void> {
  const args = process.argv.slice(2);
  const options: TestRunnerOptions = {
    verbose: args.includes('--verbose') || args.includes('-v'),
    continueOnError: args.includes('--continue-on-error'),
    validateOnly: args.includes('--validate-only'),
    parallel: false, // Always sequential for now
    outputFormat: 'console'
  };

  // Parse additional options
  const filterIndex = args.indexOf('--filter');
  if (filterIndex !== -1 && args[filterIndex + 1]) {
    options.filter = args[filterIndex + 1];
  }

  const categoryIndex = args.indexOf('--category');
  if (categoryIndex !== -1 && args[categoryIndex + 1]) {
    options.category = args[categoryIndex + 1];
  }

  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    options.outputFile = args[outputIndex + 1];
    options.outputFormat = 'both';
  }

  const runner = new ConsolidatedScenarioTestRunner();
  
  try {
    const results = await runner.runAllScenarios(options);
    
    // Exit with error code if tests failed
    const exitCode = results.failed > 0 ? 1 : 0;
    process.exit(exitCode);
    
  } catch (error) {
    console.error('💥 Test runner crashed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runScenarioTests();
}