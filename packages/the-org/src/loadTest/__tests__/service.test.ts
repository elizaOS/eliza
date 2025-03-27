import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { LoadTestService } from '../service';
import { AgentRuntime, logger } from '@elizaos/core';

describe('LoadTestService', () => {
  let service: LoadTestService;
  let mockRuntime: AgentRuntime;
  let testStartTime: number;

  beforeEach(() => {
    testStartTime = Date.now();
    logger.info('=====================================================');
    logger.info(`Test starting at: ${new Date(testStartTime).toISOString()}`);
    logger.info('Setting up test environment for LoadTestService...');

    mockRuntime = {
      agentId: 'test-agent-id',
      getSetting: () => null,
      emit: (event: string, data: any) => {
        logger.info(`[MOCK] Event emitted: ${event}`, data);
        return Promise.resolve();
      }
    } as unknown as AgentRuntime;
    
    service = new LoadTestService(mockRuntime);
    logger.info(`Test environment setup complete in ${Date.now() - testStartTime}ms`);
    logger.info('-----------------------------------------------------');
  });

  afterEach(() => {
    const testDuration = Date.now() - testStartTime;
    logger.info('-----------------------------------------------------');
    logger.info(`Test completed in ${testDuration}ms`);
    logger.info('=====================================================');
  });

  it('should start a test and record metrics', async () => {
    const stepStartTime = Date.now();
    logger.info('Starting load test metrics test case...');
    
    const testId = 'test-1';
    logger.info(`Creating test with ID: ${testId}`);
    service.startTest(testId);
    logger.info(`Test created in ${Date.now() - stepStartTime}ms`);
    
    logger.info('Recording messages and errors for test...');
    const messageStartTime = Date.now();
    service.recordMessage(testId);
    logger.info(`Message 1 recorded at ${Date.now()}ms`);
    
    service.recordMessage(testId);
    logger.info(`Message 2 recorded at ${Date.now()}ms`);
    
    service.recordError(testId);
    logger.info(`Error recorded at ${Date.now()}ms`);
    
    logger.info(`All test messages recorded in ${Date.now() - messageStartTime}ms`);

    logger.info('Retrieving and validating test metrics...');
    const metrics = service.getTestMetrics(testId);
    logger.info('Current test metrics:', {
      testId,
      startTime: metrics.startTime,
      messageCount: metrics.messageCount,
      errors: metrics.errors,
      testDuration: Date.now() - metrics.startTime
    });
    
    expect(metrics).toBeDefined();
    expect(metrics.messageCount).toBe(2);
    expect(metrics.errors).toBe(1);
    logger.info('Metrics validation successful');

    logger.info('Testing service stop functionality...');
    const stopStartTime = Date.now();
    await service.stop();
    logger.info(`Service stopped in ${Date.now() - stopStartTime}ms`);
    
    const afterStopMetrics = service.getTestMetrics(testId);
    logger.info('After stop metrics:', afterStopMetrics);
    expect(afterStopMetrics).toBeUndefined();
    logger.info('Test complete - service stop cleared all test data as expected');
  });
}); 