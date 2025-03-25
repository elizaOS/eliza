import { TestSuite, IAgentRuntime, UUID, ChannelType, logger } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { LoadTestMetrics, ScaleConfig, SystemMetrics } from './types';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

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
    timestamp: []
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
    { agents: 2000, messageCount: 500, description: 'Breaking Point (2000 agents)' }
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
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const logsDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logsDir)) {
          fs.mkdirSync(logsDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/:/g, '-');
        const summaryLogFile = path.join(logsDir, `load-test-summary-${timestamp}.log`);
        const systemMetricsFile = path.join(logsDir, `system-metrics-${timestamp}.log`);
        
        // Start system metrics monitoring
        this.startSystemMetricsMonitoring();
        
        // Write header to summary file
        fs.writeFileSync(summaryLogFile, 
          'Scale Testing Summary - Finding Breaking Points\n' +
          '===========================================\n' +
          `Test Started: ${new Date().toISOString()}\n\n` +
          'Configuration | Agents | Messages | Success Rate | Avg Response | Memory | Throughput | Errors\n' +
          '-------------|--------|----------|--------------|--------------|--------|------------|-------\n'
        );

        logger.info('Starting sequential load tests to find breaking points');
        
        // Main testing loop - continue until breaking point or all tests complete
        let breakingPointIdentified = false;
        
        for (const config of this.SCALE_CONFIGS) {
          // Skip if we've already found a breaking point
          if (breakingPointIdentified) {
            fs.appendFileSync(summaryLogFile, 
              `${config.description.padEnd(13)} | ${String(config.agents).padEnd(6)} | ` +
              `${String(config.messageCount).padEnd(8)} | SKIPPED | - | - | - | -\n`
            );
            continue;
          }
          
          const detailedLogFile = path.join(logsDir, `load-test-${config.agents}-agents-${timestamp}.log`);
          
          try {
            // Write test header to detailed log
            fs.writeFileSync(detailedLogFile, 
              `Load Test: ${config.description}\n` +
              `================${'='.repeat(config.description.length)}\n` +
              `Agents: ${config.agents}\n` +
              `Messages: ${config.messageCount}\n` +
              `Started: ${new Date().toISOString()}\n\n` +
              'DETAILED TEST LOG:\n' +
              '=================\n\n'
            );
            
            logger.info(`\nStarting load test for ${config.description}`);
            const metrics = await this.runSequentialLoadTest(runtime, config);
            
            // Check if this is a breaking point (high error rate or very slow responses)
            if (metrics.errorCount > 0.2 * metrics.messagesSent || 
                metrics.avgResponseTime > 2000 || 
                metrics.successRate < 90) {
              breakingPointIdentified = true;
              logger.warn(`BREAKING POINT IDENTIFIED at ${config.agents} agents!`);
              fs.appendFileSync(detailedLogFile, 
                `\n*** BREAKING POINT IDENTIFIED ***\n` +
                `High error rate: ${metrics.errorCount} / ${metrics.messagesSent}\n` +
                `Slow response time: ${metrics.avgResponseTime.toFixed(2)}ms\n` +
                `Low success rate: ${metrics.successRate.toFixed(2)}%\n`
              );
            }
            
            // Append detailed metrics to the log file
            this.writeDetailedMetrics(detailedLogFile, config, metrics);
            
            // Add summary line to summary file
            this.appendToSummaryLog(summaryLogFile, config, metrics);
            
          } catch (error) {
            breakingPointIdentified = true;
            logger.error(`BREAKING POINT: Error running test for ${config.description}:`, error);
            fs.appendFileSync(detailedLogFile, 
              `\n*** FATAL ERROR - BREAKING POINT IDENTIFIED ***\n` +
              `Test failed catastrophically at ${config.agents} agents with error:\n` +
              `${error.message}\n`
            );
            fs.appendFileSync(summaryLogFile, 
              `${config.description.padEnd(13)} | ${String(config.agents).padEnd(6)} | ` +
              `${String(config.messageCount).padEnd(8)} | FAILED | - | - | - | FATAL\n`
            );
          }
        }
        
        // Stop metrics monitoring
        this.stopSystemMetricsMonitoring();
        
        // Write system metrics to file
        this.writeSystemMetrics(systemMetricsFile);
        
        // Determine optimal scaling threshold
        const optimalConfig = this.determineOptimalScaling(summaryLogFile);
        
        // Write summary conclusion
        fs.appendFileSync(summaryLogFile, 
          '\n\nSCALABILITY ANALYSIS\n' +
          '====================\n' +
          `Breaking Point: ${breakingPointIdentified ? 'Identified' : 'Not reached'}\n` +
          `${breakingPointIdentified ? 'Last stable configuration: ' + optimalConfig.description : 'All configurations stable'}\n` +
          `Recommended maximum agents: ${optimalConfig.agents}\n` +
          `Recommended maximum messages: ${optimalConfig.messageCount}\n` +
          `Optimal throughput: ~${optimalConfig.throughput.toFixed(2)} messages/second\n\n` +
          `Test Completed: ${new Date().toISOString()}\n` +
          '====================\n'
        );
      }
    }
  ];

  private async runSequentialLoadTest(
    runtime: IAgentRuntime,
    config: ScaleConfig
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
      errorTypes: {}
    };

    try {
      // Create test environment
      logger.info(`Creating test world for ${config.description}`);
      const worldId = await this.scenarioService.createWorld(`Load Test - ${config.agents} agents`, 'Test Admin');
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
            if (currentMemory > 1024) { // If memory usage exceeds 1GB
              logger.warn(`Memory threshold exceeded during participant creation: ${currentMemory.toFixed(2)}MB`);
              metrics.errorTypes['excessive_memory'] = (metrics.errorTypes['excessive_memory'] || 0) + 1;
              throw new Error(`Memory threshold exceeded during participant creation: ${currentMemory.toFixed(2)}MB`);
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
          await this.scenarioService.sendMessage(
            runtime,
            worldId,
            roomId,
            messageText,
            senderId
          );

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
              logger.info(`Processed ${i + 1}/${config.messageCount} messages (last: ${responseTime}ms)`);
            }
            
            // Add early breaking point detection
            if (responseTime > 5000) { // If any single response takes > 5 seconds
              logger.warn(`Response time threshold exceeded: ${responseTime}ms`);
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
          
          // Check if we're approaching system limits
          if (currentMemory > 1024 || this.systemMetrics.cpuUsage[this.systemMetrics.cpuUsage.length - 1] > 0.9) {
            logger.warn(`System resource limits approaching: Memory=${currentMemory.toFixed(2)}MB, CPU=${this.systemMetrics.cpuUsage[this.systemMetrics.cpuUsage.length - 1]}`);
            metrics.errorTypes['resource_limit'] = (metrics.errorTypes['resource_limit'] || 0) + 1;
            if (metrics.errorTypes['resource_limit'] > 3) {
              throw new Error('System resource limits exceeded repeatedly');
            }
          }
        }

        // Small delay between messages to prevent flooding
        const delayTime = config.agents > 500 ? 200 : 100; // Increase delay for larger tests
        await new Promise(resolve => setTimeout(resolve, delayTime));
      }

      metrics.memoryUsageEnd = process.memoryUsage().heapUsed / 1024 / 1024;
    } catch (error) {
      metrics.errorCount++;
      logger.error('Load test failed:', error);
      throw error;
    }

    metrics.totalTime = Date.now() - startTime;
    metrics.avgResponseTime = metrics.responseTimes.length > 0 ? 
      metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length : 0;
    metrics.successRate = metrics.messagesSent > 0 ? 
      (metrics.messagesProcessed / metrics.messagesSent) * 100 : 0;
    metrics.throughput = metrics.messagesProcessed > 0 ? 
      (metrics.messagesProcessed / metrics.totalTime) * 1000 : 0; // messages per second

    this.reportMetrics(config, metrics);
    return metrics;
  }

  private startSystemMetricsMonitoring() {
    // Reset metrics
    this.systemMetrics = {
      cpuUsage: [],
      memoryUsage: [],
      timestamp: []
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
  
  private determineOptimalScaling(summaryFile: string): { agents: number, messageCount: number, description: string, throughput: number } {
    // Default to minimum configuration
    let optimal = {
      agents: this.SCALE_CONFIGS[0].agents,
      messageCount: this.SCALE_CONFIGS[0].messageCount,
      description: this.SCALE_CONFIGS[0].description,
      throughput: 0
    };
    
    try {
      // Read the summary file to find last successful test
      const content = fs.readFileSync(summaryFile, 'utf8');
      const lines = content.split('\n');
      
      // Find all successful test lines (containing success rate)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('%') && !line.includes('FAILED') && !line.includes('SKIPPED')) {
          // Extract configuration details
          const parts = line.split('|').map(p => p.trim());
          
          // Extract the throughput
          const throughputStr = parts[parts.length - 2];
          const throughput = parseFloat(throughputStr);
          
          // If we have valid data and higher throughput, update optimal
          if (!isNaN(throughput) && throughput > optimal.throughput) {
            // Extract agent count
            const agentsStr = parts[1].trim();
            const agents = parseInt(agentsStr);
            
            // Extract message count
            const messagesStr = parts[2].trim();
            const messages = parseInt(messagesStr);
            
            // Extract description
            const description = parts[0].trim();
            
            if (!isNaN(agents) && !isNaN(messages)) {
              optimal = {
                agents,
                messageCount: messages,
                description,
                throughput
              };
            }
          }
        }
      }
    } catch (error) {
      logger.error('Error determining optimal scaling:', error);
    }
    
    return optimal;
  }

  private generateTestMessage(index: number, config: ScaleConfig): string {
    const templates = [
      `Test message ${index} for load testing with ${config.agents} agents`,
      `Can you process this request? (message ${index})`,
      `This is message ${index} in a test with ${config.agents} participants`,
      `Load test - checking response time for message ${index}`,
      `Simulation message ${index} - how quickly can you respond?`
    ];
    return templates[index % templates.length];
  }

  private reportMetrics(config: ScaleConfig, metrics: LoadTestMetrics) {
    logger.info('\n========== Test Results ==========');
    logger.info(`Configuration: ${config.description}`);
    logger.info(`Number of Agents: ${config.agents}`);
    logger.info(`Messages Sent: ${metrics.messagesSent}`);
    logger.info(`Messages Successfully Processed: ${metrics.messagesProcessed}`);
    logger.info(`Error Count: ${metrics.errorCount}`);
    logger.info(`Timeout Count: ${metrics.timeoutCount}`);
    logger.info(`Success Rate: ${metrics.successRate.toFixed(2)}%`);
    logger.info(`Total Test Time: ${metrics.totalTime}ms (${(metrics.totalTime / 1000).toFixed(2)}s)`);
    logger.info(`Average Response Time: ${metrics.avgResponseTime.toFixed(2)}ms`);
    logger.info(`Min Response Time: ${metrics.minResponseTime}ms`);
    logger.info(`Max Response Time: ${metrics.maxResponseTime}ms`);
    logger.info(`Memory Usage: ${metrics.memoryUsageStart.toFixed(2)}MB → ${metrics.memoryUsageEnd.toFixed(2)}MB`);
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
  
  private writeDetailedMetrics(logFile: string, config: ScaleConfig, metrics: LoadTestMetrics) {
    const detailedLog = 
      '\nTEST RESULTS:\n' +
      '============\n' +
      `Messages Sent: ${metrics.messagesSent}\n` +
      `Messages Processed: ${metrics.messagesProcessed}\n` +
      `Error Count: ${metrics.errorCount}\n` +
      `Timeout Count: ${metrics.timeoutCount}\n` +
      `Success Rate: ${metrics.successRate.toFixed(2)}%\n` +
      `Total Test Time: ${metrics.totalTime}ms (${(metrics.totalTime / 1000).toFixed(2)}s)\n` +
      `Average Response Time: ${metrics.avgResponseTime.toFixed(2)}ms\n` +
      `Min Response Time: ${metrics.minResponseTime}ms\n` +
      `Max Response Time: ${metrics.maxResponseTime}ms\n` +
      `Memory Usage Start: ${metrics.memoryUsageStart.toFixed(2)}MB\n` +
      `Memory Usage End: ${metrics.memoryUsageEnd.toFixed(2)}MB\n` +
      `Peak Memory Usage: ${metrics.peakMemoryUsage.toFixed(2)}MB\n` +
      `Throughput: ${metrics.throughput.toFixed(2)} messages/second\n`;
      
    let errorDetails = '';
    if (Object.keys(metrics.errorTypes).length > 0) {
      errorDetails = '\nERROR DETAILS:\n' +
        '=============\n';
      for (const [type, count] of Object.entries(metrics.errorTypes)) {
        errorDetails += `${type}: ${count}\n`;
      }
    }
    
    const histogramSection = 
      '\nRESPONSE TIME HISTOGRAM:\n' +
      this.generateHistogram(metrics.responseTimes) + '\n\n' +
      `Test Completed: ${new Date().toISOString()}\n`;
    
    fs.appendFileSync(logFile, detailedLog + errorDetails + histogramSection);
  }
  
  private appendToSummaryLog(summaryFile: string, config: ScaleConfig, metrics: LoadTestMetrics) {
    const summaryLine = 
      `${config.description.padEnd(13)} | ${String(config.agents).padEnd(6)} | ` +
      `${String(config.messageCount).padEnd(8)} | ${metrics.successRate.toFixed(1).padEnd(12)}% | ` +
      `${metrics.avgResponseTime.toFixed(1).padEnd(12)}ms | ${metrics.peakMemoryUsage.toFixed(1).padEnd(6)}MB | ` +
      `${metrics.throughput.toFixed(2).padEnd(10)} | ${metrics.errorCount}\n`;
    
    fs.appendFileSync(summaryFile, summaryLine);
  }
  
  private generateHistogram(responseTimes: number[]): string {
    if (responseTimes.length === 0) return 'No data';
    
    // Find min and max
    const min = Math.min(...responseTimes);
    const max = Math.max(...responseTimes);
    
    // Create 10 buckets
    const bucketSize = Math.max(Math.ceil((max - min) / 10), 1);
    const buckets = new Array(10).fill(0);
    
    // Fill buckets
    for (const time of responseTimes) {
      const bucketIndex = Math.min(Math.floor((time - min) / bucketSize), 9);
      buckets[bucketIndex]++;
    }
    
    // Generate histogram
    let result = '';
    for (let i = 0; i < buckets.length; i++) {
      const lowerBound = min + (i * bucketSize);
      const upperBound = min + ((i + 1) * bucketSize);
      const count = buckets[i];
      const percentage = (count / responseTimes.length) * 100;
      
      result += `${lowerBound.toFixed(0)}-${upperBound.toFixed(0)}ms: ${'#'.repeat(Math.ceil(percentage / 2))} (${count} - ${percentage.toFixed(1)}%)\n`;
    }
    
    return result;
  }
}