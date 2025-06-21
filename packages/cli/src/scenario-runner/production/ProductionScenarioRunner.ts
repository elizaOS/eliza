import { type IAgentRuntime, logger, type UUID, type Character } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { TestAgentFactory } from './TestAgentFactory.js';
import { ScenarioTestHarness } from './ScenarioTestHarness.js';
import { Scenario, ScenarioExecutionResult, TranscriptMessage, MetricsReport } from '../types.js';
export interface ProductionRunnerConfig {
  databaseUrl?: string;
  modelProvider?: string;
  apiKeys?: Record<string, string>;
  enableMetrics?: boolean;
  enableVerification?: boolean;
  cleanupAfterRun?: boolean;
}

export class ProductionScenarioRunner {
  private config: ProductionRunnerConfig;
  private factory: TestAgentFactory;
  private testHarnesses: Map<UUID, ScenarioTestHarness> = new Map();
  private runtimes: Map<UUID, IAgentRuntime> = new Map();

  constructor(config: ProductionRunnerConfig = {}) {
    this.config = {
      enableMetrics: true,
      enableVerification: true,
      cleanupAfterRun: true,
      ...config,
    };
    this.factory = new TestAgentFactory();
  }

  async run(scenario: Scenario): Promise<ScenarioExecutionResult> {
    const startTime = Date.now();
    const transcript: TranscriptMessage[] = [];
    const errors: string[] = [];
    let status: 'passed' | 'failed' | 'partial' = 'passed';

    try {
      logger.info(`🚀 Running scenario: ${scenario.name}`);
      logger.info(`📝 ${scenario.description}`);

      // Create test database for this scenario
      const dbName = `eliza_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const testDbUrl = await this.factory.createTestDatabase(dbName);

      // Create real agents for all actors
      logger.info(`🤖 Creating ${scenario.actors.length} agents...`);
      for (const actor of scenario.actors) {
        const character: Character = {
          id: actor.id,
          name: actor.name,
          bio: [actor.bio || `I am ${actor.name}, a ${actor.role} in this scenario.`],
          system: actor.system || 'You are a helpful assistant participating in a test scenario.',
          plugins: actor.plugins || [],
          settings: actor.settings,
        };

        const runtime = await this.factory.createRealAgent({
          character,
          plugins: actor.plugins,
          testDatabaseUrl: testDbUrl,
          apiKeys: this.config.apiKeys,
        });

        this.runtimes.set(actor.id, runtime);
        const harness = new ScenarioTestHarness(runtime);
        this.testHarnesses.set(actor.id, harness);

        logger.success(`✅ Created agent: ${actor.name} (${actor.role})`);
      }

      // Execute the scenario
      logger.info(`🎬 Executing scenario steps...`);
      const result = await this.executeScenarioSteps(scenario, transcript);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
        status = result.critical ? 'failed' : 'partial';
      }

      // Run verifications if enabled
      if (this.config.enableVerification && scenario.expectations) {
        logger.info(`🔍 Running verifications...`);
        const verificationResult = await this.runVerifications(scenario, transcript);

        if (!verificationResult.success) {
          errors.push(...verificationResult.errors);
          status = verificationResult.critical ? 'failed' : 'partial';
        }
      }

      // Run benchmarks if enabled
      let metrics: MetricsReport | undefined;
      if (this.config.enableMetrics && scenario.benchmarks) {
        logger.info(`📊 Running benchmarks...`);
        metrics = await this.runBenchmarks(scenario, transcript, startTime);

        if (metrics.failures && metrics.failures.length > 0) {
          errors.push(...metrics.failures.map((f) => f.reason));
          status = 'partial';
        }
      }

      const duration = Date.now() - startTime;

      logger.info(`\n📋 Scenario Results:`);
      logger.info(
        `   Status: ${status === 'passed' ? '✅ PASSED' : status === 'failed' ? '❌ FAILED' : '⚠️  PARTIAL'}`
      );
      logger.info(`   Duration: ${(duration / 1000).toFixed(2)}s`);
      logger.info(`   Messages: ${transcript.length}`);
      if (errors.length > 0) {
        logger.info(`   Errors: ${errors.length}`);
        errors.forEach((error, i) => {
          logger.error(`     ${i + 1}. ${error}`);
        });
      }

      return {
        scenario: scenario.name,
        status,
        duration,
        transcript,
        errors,
        metrics,
      };
    } catch (error) {
      logger.error(`Fatal error in scenario execution:`, error);
      return {
        scenario: scenario.name,
        status: 'failed',
        duration: Date.now() - startTime,
        transcript,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    } finally {
      // Cleanup
      if (this.config.cleanupAfterRun) {
        await this.cleanup();
      }
    }
  }

  private async executeScenarioSteps(
    scenario: Scenario,
    transcript: TranscriptMessage[]
  ): Promise<{ errors: string[]; critical: boolean }> {
    const errors: string[] = [];
    let critical = false;

    for (const actor of scenario.actors) {
      const runtime = this.runtimes.get(actor.id);
      const harness = this.testHarnesses.get(actor.id);

      if (!runtime || !harness) {
        errors.push(`Runtime or harness not found for actor ${actor.name}`);
        critical = true;
        continue;
      }

      for (const step of actor.script?.steps || []) {
        try {
          switch (step.type) {
            case 'message': {
              const messageContent = step.content || '';
              logger.info(`💬 ${actor.name}: "${messageContent}"`);

              const response = await harness.sendMessageAndWaitForResponse(
                messageContent,
                scenario.roomId as UUID
              );

              // Add user message to transcript
              transcript.push({
                id: uuidv4() as UUID,
                timestamp: Date.now(),
                actorId: actor.id,
                actorName: actor.name,
                content: { text: step.content },
                messageType: 'outgoing',
              });

              // Add agent response to transcript
              if (response) {
                transcript.push({
                  id: response.id,
                  timestamp: response.timestamp,
                  actorId: runtime.agentId,
                  actorName: actor.name,
                  content: response.content,
                  messageType: 'incoming',
                });

                logger.info(`🤖 Response: "${response.content.text}"`);
              }
              break;
            }

            case 'wait': {
              logger.info(`⏳ Waiting ${step.waitTime}ms...`);
              await new Promise((resolve) => setTimeout(resolve, step.waitTime));
              break;
            }

            case 'action': {
              const actionName = step.action || step.actionName || 'unknown-action';
              logger.info(`🎯 Waiting for action: ${actionName}`);
              await harness.waitForAction(actionName, step.timeout || 10000);
              break;
            }

            case 'condition': {
              logger.info(`🔄 Waiting for condition: ${step.description}`);
              // This would need implementation based on the condition
              break;
            }
          }
        } catch (error) {
          const errorMsg = `Step failed for ${actor.name}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(errorMsg);
          logger.error(errorMsg);

          if (step.critical) {
            critical = true;
            break;
          }
        }
      }
    }

    return { errors, critical };
  }

  private async runVerifications(
    scenario: Scenario,
    transcript: TranscriptMessage[]
  ): Promise<{ success: boolean; errors: string[]; critical: boolean }> {
    const errors: string[] = [];
    let critical = false;

    if (!scenario.expectations) {
      return { success: true, errors: [], critical: false };
    }

    // Verify message patterns
    if (scenario.expectations.messagePatterns) {
      for (const pattern of scenario.expectations.messagePatterns) {
        const regex = new RegExp(pattern.pattern, pattern.flags);
        const matches = transcript.filter((msg) => regex.test(msg.content.text || ''));

        if (matches.length === 0) {
          errors.push(`Expected pattern "${pattern.pattern}" not found in transcript`);
        }
      }
    }

    // Verify response times
    if (scenario.expectations.responseTime) {
      const slowResponses = transcript.filter((msg, index) => {
        if (index === 0 || msg.messageType !== 'incoming') return false;
        const prevMsg = transcript[index - 1];
        const responseTime = msg.timestamp - prevMsg.timestamp;
        return responseTime > scenario.expectations!.responseTime!.max;
      });

      if (slowResponses.length > 0) {
        errors.push(
          `${slowResponses.length} responses exceeded max response time of ${scenario.expectations.responseTime.max}ms`
        );
      }
    }

    // Verify action calls
    if (scenario.expectations.actionCalls) {
      // This would need to track actual action calls
      logger.warn('Action call verification not yet implemented');
    }

    return {
      success: errors.length === 0,
      errors,
      critical,
    };
  }

  private async runBenchmarks(
    scenario: Scenario,
    transcript: TranscriptMessage[],
    startTime: number
  ): Promise<MetricsReport> {
    const report: MetricsReport = {
      scenario: scenario.name,
      timestamp: Date.now(),
      duration: Date.now() - startTime,
      messageCount: transcript.length,
      avgResponseTime: 0,
      benchmarks: [],
      failures: [],
    };

    // Calculate average response time
    let totalResponseTime = 0;
    let responseCount = 0;

    for (let i = 1; i < transcript.length; i++) {
      if (
        transcript[i].messageType === 'incoming' &&
        transcript[i - 1].messageType === 'outgoing'
      ) {
        totalResponseTime += transcript[i].timestamp - transcript[i - 1].timestamp;
        responseCount++;
      }
    }

    report.avgResponseTime = responseCount > 0 ? totalResponseTime / responseCount : 0;

    // Run custom benchmarks
    if (scenario.benchmarks?.customMetrics) {
      for (const metric of scenario.benchmarks.customMetrics) {
        try {
          // This would need custom metric calculation logic
          const value = await this.calculateCustomMetric(metric.name, transcript);

          report.benchmarks.push({
            metric: metric.name,
            value,
            threshold: metric.threshold,
            passed: metric.threshold ? value <= metric.threshold : true,
          });
        } catch (error) {
          report.failures?.push({
            metric: metric.name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return report;
  }

  private async calculateCustomMetric(
    metricName: string,
    transcript: TranscriptMessage[]
  ): Promise<number> {
    // Implement custom metric calculations based on metric name
    switch (metricName) {
      case 'messages_per_second':
        const duration = transcript[transcript.length - 1].timestamp - transcript[0].timestamp;
        return transcript.length / (duration / 1000);

      case 'unique_words':
        const allWords = transcript
          .map((msg) => msg.content.text || '')
          .join(' ')
          .toLowerCase()
          .split(/\s+/);
        return new Set(allWords).size;

      default:
        return 0;
    }
  }

  private async cleanup(): Promise<void> {
    logger.info('🧹 Cleaning up test resources...');

    // Clean up test harnesses
    for (const harness of this.testHarnesses.values()) {
      harness.cleanup();
    }

    // Clean up factory resources
    await this.factory.cleanup();

    // Clear maps
    this.testHarnesses.clear();
    this.runtimes.clear();
  }
}
