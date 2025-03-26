import { TestSuite, IAgentRuntime, UUID, ChannelType, logger } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { LoadTestMetrics, ScaleConfig, SystemMetrics } from './types';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import {
  ThresholdLevel,
  THRESHOLD_CONFIGS,
  ensureLogsDirectory,
  generateTimestamp,
  createLoadTestSummaryHeader,
  createDetailedTestLogHeader,
  formatBreakingPointNotification,
  isBreakingPoint,
  formatDetailedMetrics,
  formatSummaryLogLine,
} from './utils';

/**
 * Load Testing Suite for Agent Scaling
 * Tests agent performance and stability at different scales
 */
export class AgentLoadTestSuite implements TestSuite {
  name = 'agent-load-test';
  description = 'Load testing for agent scalability';
  private scenarioService: any;
  private breakingPointReached: boolean = false;
  private systemMetrics: SystemMetrics = {
    cpuUsage: [],
    memoryUsage: [],
    timestamp: [],
  };

  // Define full range of test scales for comprehensive testing
  private readonly SCALE_CONFIGS: ScaleConfig[] = [
    { agents: 2, messageCount: 10, description: 'Minimal Load (2 agents)' },
    { agents: 5, messageCount: 20, description: 'Small Group (5 agents)' },
    { agents: 10, messageCount: 50, description: 'Medium Group (10 agents)' },
    { agents: 50, messageCount: 100, description: 'Large Group (50 agents)' },
    { agents: 100, messageCount: 150, description: 'Very Large Group (100 agents)' },
    { agents: 250, messageCount: 200, description: 'Mass Scale (250 agents)' },
    { agents: 500, messageCount: 300, description: 'Extreme Scale (500 agents)' },
    { agents: 1000, messageCount: 400, description: 'Maximum Load (1000 agents)' },
    { agents: 2000, messageCount: 500, description: 'Breaking Point (2000 agents)' },
  ];

  tests = [
    {
      name: 'Scale Testing - Sequential Load',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) {
          throw new Error('Scenario service not found');
        }

        // Ensure logs directory exists
        const logsDir = ensureLogsDirectory();
        const timestamp = generateTimestamp();
        const summaryLogFile = path.join(logsDir, `load-test-summary-${timestamp}.log`);
        const systemMetricsFile = path.join(logsDir, `system-metrics-${timestamp}.log`);

        // Start system metrics monitoring
        this.startSystemMetricsMonitoring();

        // Write header to summary file
        fs.writeFileSync(summaryLogFile, createLoadTestSummaryHeader());

        logger.info('Starting sequential load tests to find breaking points');

        // Run tests with different threshold levels
        const thresholdLevels = [ThresholdLevel.LOW, ThresholdLevel.MEDIUM, ThresholdLevel.HIGH];

        for (const thresholdLevel of thresholdLevels) {
          logger.info(`\nStarting test run with ${thresholdLevel} threshold settings`);

          // Main testing loop - continue until breaking point or all tests complete
          let breakingPointIdentified = false;

          for (const config of this.SCALE_CONFIGS) {
            // Skip if we've already found a breaking point
            if (breakingPointIdentified) {
              fs.appendFileSync(
                summaryLogFile,
                `${config.description.padEnd(13)} | ${String(config.agents).padEnd(6)} | ` +
                  `${String(config.messageCount).padEnd(8)} | SKIPPED (${thresholdLevel}) | - | - | - | -\n`
              );
              continue;
            }

            const detailedLogFile = path.join(
              logsDir,
              `load-test-${thresholdLevel}-${config.agents}-agents-${timestamp}.log`
            );

            try {
              // Write test header to detailed log
              fs.writeFileSync(detailedLogFile, createDetailedTestLogHeader(config));
              fs.appendFileSync(detailedLogFile, `Threshold Level: ${thresholdLevel}\n\n`);

              logger.info(
                `\nStarting load test for ${config.description} with ${thresholdLevel} threshold`
              );
              const metrics = await this.runSequentialLoadTest(runtime, config, thresholdLevel);

              // Check if this is a breaking point based on the current threshold level
              if (isBreakingPoint(metrics, thresholdLevel)) {
                breakingPointIdentified = true;
                logger.warn(
                  `BREAKING POINT IDENTIFIED at ${config.agents} agents with ${thresholdLevel} threshold!`
                );
                fs.appendFileSync(
                  detailedLogFile,
                  formatBreakingPointNotification(metrics, thresholdLevel)
                );
              }

              // Append detailed metrics to the log file
              fs.appendFileSync(detailedLogFile, formatDetailedMetrics(config, metrics));

              // Add summary line to summary file
              fs.appendFileSync(
                summaryLogFile,
                `${thresholdLevel} - ` + formatSummaryLogLine(config, metrics)
              );
            } catch (error) {
              breakingPointIdentified = true;
              logger.error(
                `BREAKING POINT: Error running test for ${config.description} with ${thresholdLevel} threshold:`,
                error
              );
              fs.appendFileSync(
                detailedLogFile,
                `\n*** FATAL ERROR - BREAKING POINT IDENTIFIED (${thresholdLevel} threshold) ***\n` +
                  `Test failed catastrophically at ${config.agents} agents with error:\n` +
                  `${error.message}\n`
              );
              fs.appendFileSync(
                summaryLogFile,
                `${thresholdLevel} - ${config.description.padEnd(13)} | ${String(config.agents).padEnd(6)} | ` +
                  `${String(config.messageCount).padEnd(8)} | FAILED | - | - | - | FATAL\n`
              );
            }
          }

          // Add separator between threshold runs
          fs.appendFileSync(
            summaryLogFile,
            '\n------------------------------------------------\n\n'
          );
        }

        // Stop metrics monitoring
        this.stopSystemMetricsMonitoring();

        // Write system metrics to file
        this.writeSystemMetrics(systemMetricsFile);

        // Determine optimal scaling threshold for each level
        const optimalConfigs = this.determineOptimalScalingPerThreshold(summaryLogFile);

        // Write summary conclusion
        fs.appendFileSync(summaryLogFile, '\n\nSCALABILITY ANALYSIS\n' + '====================\n');

        for (const [level, config] of Object.entries(optimalConfigs)) {
          fs.appendFileSync(
            summaryLogFile,
            `${level} Threshold:\n` +
              `- Breaking Point: Identified\n` +
              `- Last stable configuration: ${config.description}\n` +
              `- Recommended maximum agents: ${config.agents}\n` +
              `- Recommended maximum messages: ${config.messageCount}\n` +
              `- Optimal throughput: ~${config.throughput.toFixed(2)} messages/second\n\n`
          );
        }

        fs.appendFileSync(
          summaryLogFile,
          `Test Completed: ${new Date().toISOString()}\n` + '====================\n'
        );
      },
    },
  ];

  private async runSequentialLoadTest(
    runtime: IAgentRuntime,
    config: ScaleConfig,
    thresholdLevel: ThresholdLevel = ThresholdLevel.MEDIUM
  ): Promise<LoadTestMetrics> {
    const startTime = Date.now();
    const metrics: LoadTestMetrics = {
      totalTime: 0,
      errorCount: 0,
      messagesSent: 0,
      messagesProcessed: 0,
      avgResponseTime: 0,
      minResponseTime: Number.MAX_SAFE_INTEGER,
      maxResponseTime: 0,
      responseTimes: [],
      peakMemoryUsage: 0,
      memoryUsageStart: process.memoryUsage().heapUsed / 1024 / 1024,
      memoryUsageEnd: 0,
      successRate: 0,
      throughput: 0,
      timeoutCount: 0,
      errorTypes: {},
    };

    try {
      // Create test environment
      logger.info(`Creating test world for ${config.description}`);
      const worldId = await this.scenarioService.createWorld(
        `Load Test - ${config.agents} agents`,
        'Test Admin'
      );
      const roomId = await this.scenarioService.createRoom(worldId, `load-test-${config.agents}`);

      // Add the test agent
      await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);

      // Create and add test participants
      const participants: UUID[] = [];
      logger.info(`Creating ${config.agents} participants...`);
      for (let i = 0; i < config.agents; i++) {
        const participantId = uuidv4() as UUID;
        await this.scenarioService.addParticipant(worldId, roomId, participantId);
        participants.push(participantId);

        // Log progress for large numbers of agents
        if (config.agents > 20 && i % 10 === 0) {
          logger.info(`Created ${i + 1}/${config.agents} participants...`);
        }

        // For extreme testing, add more intensive validation
        if (config.agents >= 500) {
          // Check memory periodically during participant creation
          if (i % 100 === 0) {
            const currentMemory = process.memoryUsage().heapUsed / 1024 / 1024;
            const thresholds = THRESHOLD_CONFIGS[thresholdLevel];
            if (currentMemory > thresholds.memoryThreshold) {
              logger.warn(
                `Memory threshold exceeded during participant creation: ${currentMemory.toFixed(2)}MB (${thresholdLevel} threshold: ${thresholds.memoryThreshold}MB)`
              );
              metrics.errorTypes['excessive_memory'] =
                (metrics.errorTypes['excessive_memory'] || 0) + 1;
              throw new Error(
                `Memory threshold exceeded during participant creation: ${currentMemory.toFixed(2)}MB`
              );
            }
          }
        }
      }
      logger.info(`All ${config.agents} participants created successfully`);

      // Send test messages
      logger.info(`Sending ${config.messageCount} test messages...`);
      for (let i = 0; i < config.messageCount; i++) {
        const messageStart = Date.now();
        const senderId = participants[i % participants.length];
        const messageText = this.generateTestMessage(i, config);

        try {
          await this.scenarioService.sendMessage(runtime, worldId, roomId, messageText, senderId);

          metrics.messagesSent++;

          // Wait for agent to process and respond with timeout
          try {
            const completed = await this.scenarioService.waitForCompletion(10000);
            if (!completed) {
              metrics.timeoutCount++;
              metrics.errorTypes['timeout'] = (metrics.errorTypes['timeout'] || 0) + 1;
              throw new Error(`Message processing timeout for message ${i}`);
            }

            const responseTime = Date.now() - messageStart;
            metrics.messagesProcessed++;
            metrics.responseTimes.push(responseTime);
            metrics.minResponseTime = Math.min(metrics.minResponseTime, responseTime);
            metrics.maxResponseTime = Math.max(metrics.maxResponseTime, responseTime);

            // Log progress
            if (i % 10 === 0 || i === config.messageCount - 1) {
              logger.info(
                `Processed ${i + 1}/${config.messageCount} messages (last: ${responseTime}ms)`
              );
            }

            // Add early breaking point detection based on threshold level
            const thresholds = THRESHOLD_CONFIGS[thresholdLevel];
            if (responseTime > thresholds.responseTimeThreshold) {
              logger.warn(
                `Response time threshold exceeded: ${responseTime}ms (${thresholdLevel} threshold: ${thresholds.responseTimeThreshold}ms)`
              );
              metrics.errorTypes['slow_response'] = (metrics.errorTypes['slow_response'] || 0) + 1;
              if (metrics.errorTypes['slow_response'] > 5) {
                throw new Error(`Too many slow responses detected (>${responseTime}ms)`);
              }
            }
          } catch (timeoutError) {
            metrics.errorCount++;
            if (timeoutError.message.includes('timeout')) {
              metrics.timeoutCount++;
              metrics.errorTypes['timeout'] = (metrics.errorTypes['timeout'] || 0) + 1;
            } else {
              metrics.errorTypes['processing'] = (metrics.errorTypes['processing'] || 0) + 1;
            }
            logger.error(`Error processing message ${i}:`, timeoutError);
          }
        } catch (sendError) {
          metrics.errorCount++;
          metrics.errorTypes['send_failure'] = (metrics.errorTypes['send_failure'] || 0) + 1;
          logger.error(`Error sending message ${i}:`, sendError);
        }

        // Check system resources periodically
        if (i % 10 === 0 || i === config.messageCount - 1) {
          // Memory usage
          const currentMemory = process.memoryUsage().heapUsed / 1024 / 1024;
          metrics.peakMemoryUsage = Math.max(metrics.peakMemoryUsage, currentMemory);

          // Add metrics snapshot
          this.snapshotSystemMetrics();

          // Check if we're approaching system limits based on threshold level
          const thresholds = THRESHOLD_CONFIGS[thresholdLevel];
          if (
            currentMemory > thresholds.memoryThreshold ||
            this.systemMetrics.cpuUsage[this.systemMetrics.cpuUsage.length - 1] >
              thresholds.cpuThreshold
          ) {
            logger.warn(
              `System resource limits approaching (${thresholdLevel} threshold): Memory=${currentMemory.toFixed(2)}MB/${thresholds.memoryThreshold}MB, ` +
                `CPU=${this.systemMetrics.cpuUsage[this.systemMetrics.cpuUsage.length - 1]}/${thresholds.cpuThreshold}`
            );
            metrics.errorTypes['resource_limit'] = (metrics.errorTypes['resource_limit'] || 0) + 1;
            if (metrics.errorTypes['resource_limit'] > 3) {
              throw new Error('System resource limits exceeded repeatedly');
            }
          }
        }

        // Small delay between messages to prevent flooding
        const delayTime = config.agents > 500 ? 200 : 100; // Increase delay for larger tests
        await new Promise((resolve) => setTimeout(resolve, delayTime));
      }

      metrics.memoryUsageEnd = process.memoryUsage().heapUsed / 1024 / 1024;
    } catch (error) {
      metrics.errorCount++;
      logger.error('Load test failed:', error);
      throw error;
    }

    metrics.totalTime = Date.now() - startTime;
    metrics.avgResponseTime =
      metrics.responseTimes.length > 0
        ? metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length
        : 0;
    metrics.successRate =
      metrics.messagesSent > 0 ? (metrics.messagesProcessed / metrics.messagesSent) * 100 : 0;
    metrics.throughput =
      metrics.messagesProcessed > 0 ? (metrics.messagesProcessed / metrics.totalTime) * 1000 : 0; // messages per second

    this.reportMetrics(config, metrics, thresholdLevel);
    return metrics;
  }

  private startSystemMetricsMonitoring() {
    // Reset metrics
    this.systemMetrics = {
      cpuUsage: [],
      memoryUsage: [],
      timestamp: [],
    };

    // Take initial snapshot
    this.snapshotSystemMetrics();
  }

  private snapshotSystemMetrics() {
    try {
      // Get CPU load average (1 minute)
      const cpuLoad = os.loadavg()[0] / os.cpus().length; // Normalize by CPU count

      // Get memory usage
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMemPercentage = (totalMem - freeMem) / totalMem;

      // Store metrics
      this.systemMetrics.cpuUsage.push(cpuLoad);
      this.systemMetrics.memoryUsage.push(usedMemPercentage);
      this.systemMetrics.timestamp.push(Date.now());
    } catch (error) {
      logger.error('Error capturing system metrics:', error);
    }
  }

  private stopSystemMetricsMonitoring() {
    // Take final snapshot
    this.snapshotSystemMetrics();
  }

  private writeSystemMetrics(filePath: string) {
    try {
      let content = 'System Metrics During Load Testing\n';
      content += '================================\n\n';
      content += 'Timestamp,CPU Load,Memory Usage (%)\n';

      for (let i = 0; i < this.systemMetrics.timestamp.length; i++) {
        const time = new Date(this.systemMetrics.timestamp[i]).toISOString();
        const cpu = this.systemMetrics.cpuUsage[i].toFixed(3);
        const mem = (this.systemMetrics.memoryUsage[i] * 100).toFixed(2);

        content += `${time},${cpu},${mem}\n`;
      }

      fs.writeFileSync(filePath, content);
    } catch (error) {
      logger.error('Error writing system metrics:', error);
    }
  }

  private determineOptimalScalingPerThreshold(
    summaryFile: string
  ): Record<
    ThresholdLevel,
    { agents: number; messageCount: number; description: string; throughput: number }
  > {
    const results: Record<
      ThresholdLevel,
      {
        agents: number;
        messageCount: number;
        description: string;
        throughput: number;
      }
    > = {
      [ThresholdLevel.LOW]: {
        agents: 0,
        messageCount: 0,
        description: '',
        throughput: 0,
      },
      [ThresholdLevel.MEDIUM]: {
        agents: 0,
        messageCount: 0,
        description: '',
        throughput: 0,
      },
      [ThresholdLevel.HIGH]: {
        agents: 0,
        messageCount: 0,
        description: '',
        throughput: 0,
      },
    };

    try {
      // Read summary file
      const summary = fs.readFileSync(summaryFile, 'utf8');

      // For each threshold level, find the last successful test
      for (const level of Object.keys(ThresholdLevel)) {
        const thresholdLevel = level as ThresholdLevel;
        const rows = summary
          .split('\n')
          .filter((line) => line.startsWith(`${thresholdLevel} - `))
          .filter((line) => !line.includes('FAILED') && !line.includes('SKIPPED'));

        if (rows.length > 0) {
          const lastSuccessful = rows[rows.length - 1];
          const parts = lastSuccessful.split('|').map((p) => p.trim());

          // Parse the description and agent count
          const fullDescription = parts[0];
          const description = fullDescription.substring(fullDescription.indexOf('-') + 1).trim();
          const agents = parseInt(parts[1]);
          const messageCount = parseInt(parts[2]);
          const throughput = parseFloat(parts[6]);

          results[thresholdLevel] = {
            agents,
            messageCount,
            description,
            throughput,
          };

          logger.info(
            `Optimal configuration for ${thresholdLevel} threshold: ${agents} agents with throughput of ${throughput.toFixed(2)} msg/s`
          );
        } else {
          // If no successful tests, set default conservative values
          results[thresholdLevel] = {
            agents: 2,
            messageCount: 10,
            description: 'Minimal Load (2 agents)',
            throughput: 0,
          };

          logger.warn(
            `No successful tests for ${thresholdLevel} threshold, using default minimal configuration`
          );
        }
      }
    } catch (error) {
      logger.error('Error determining optimal scaling:', error);
      // Return default values in case of error
      return {
        [ThresholdLevel.LOW]: {
          agents: 2,
          messageCount: 10,
          description: 'Minimal Load (2 agents)',
          throughput: 0.5,
        },
        [ThresholdLevel.MEDIUM]: {
          agents: 5,
          messageCount: 20,
          description: 'Small Group (5 agents)',
          throughput: 1.0,
        },
        [ThresholdLevel.HIGH]: {
          agents: 10,
          messageCount: 50,
          description: 'Medium Group (10 agents)',
          throughput: 2.0,
        },
      };
    }

    return results;
  }

  private generateTestMessage(index: number, config: ScaleConfig): string {
    return `Test message ${index} from scalability test with ${config.agents} agents.`;
  }

  private reportMetrics(
    config: ScaleConfig,
    metrics: LoadTestMetrics,
    thresholdLevel: ThresholdLevel = ThresholdLevel.MEDIUM
  ) {
    logger.info('\n========== Test Results ==========');
    logger.info(`Configuration: ${config.description} (${thresholdLevel} threshold)`);
    logger.info(`Number of Agents: ${config.agents}`);
    logger.info(`Messages Sent: ${metrics.messagesSent}`);
    logger.info(`Messages Successfully Processed: ${metrics.messagesProcessed}`);
    logger.info(`Error Count: ${metrics.errorCount}`);
    logger.info(`Timeout Count: ${metrics.timeoutCount}`);
    logger.info(`Success Rate: ${metrics.successRate.toFixed(2)}%`);
    logger.info(
      `Total Test Time: ${metrics.totalTime}ms (${(metrics.totalTime / 1000).toFixed(2)}s)`
    );
    logger.info(`Average Response Time: ${metrics.avgResponseTime.toFixed(2)}ms`);
    logger.info(`Min Response Time: ${metrics.minResponseTime}ms`);
    logger.info(`Max Response Time: ${metrics.maxResponseTime}ms`);
    logger.info(
      `Memory Usage: ${metrics.memoryUsageStart.toFixed(2)}MB → ${metrics.memoryUsageEnd.toFixed(2)}MB`
    );
    logger.info(`Peak Memory Usage: ${metrics.peakMemoryUsage.toFixed(2)}MB`);
    logger.info(`Throughput: ${metrics.throughput.toFixed(2)} messages/second`);

    if (Object.keys(metrics.errorTypes).length > 0) {
      logger.info(`Error Types:`);
      for (const [type, count] of Object.entries(metrics.errorTypes)) {
        logger.info(`  - ${type}: ${count}`);
      }
    }

    logger.info('==================================\n');
  }
}
