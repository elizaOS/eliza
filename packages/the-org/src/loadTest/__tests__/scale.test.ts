import { describe, it, beforeAll, afterAll } from 'vitest';
import { AgentLoadTestSuite } from '../index';
import { AgentRuntime, logger } from '@elizaos/core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

describe('Agent Scale Testing', () => {
  const testSuite = new AgentLoadTestSuite();
  let mockRuntime: any;

  // Set up a mock runtime with the required scenario service
  beforeAll(() => {
    logger.info('Setting up test environment for scale testing...');

    // Create mock runtime with scenario service
    mockRuntime = {
      agentId: 'test-agent-id',
      getSetting: () => null,
      getService: (serviceName: string) => {
        if (serviceName === 'scenario') {
          return createMockScenarioService();
        }
        return null;
      },
      emit: (event: string, data: any) => {
        logger.info(`[MOCK] Event emitted: ${event}`);
        return Promise.resolve();
      },
    } as unknown as AgentRuntime;

    // Ensure logs directory exists
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    logger.info('Test environment setup complete');
  });

  afterAll(() => {
    logger.info('Cleaning up after scale tests...');
  });

  it('should run load tests across all agent scales', async () => {
    logger.info('Starting scale test execution...');

    // Find the specific test for scale testing
    const scaleTest = testSuite.tests.find((test) => test.name.includes('Scale Testing'));
    if (!scaleTest) {
      throw new Error('Scale testing function not found in test suite');
    }

    // Execute the test
    await scaleTest.fn(mockRuntime);

    logger.info('Scale testing completed successfully');
  }, 300000); // 5 minute timeout for large-scale testing
});

// Helper to create a mock scenario service
function createMockScenarioService() {
  const participants = new Map<string, Set<string>>();
  const worldRooms = new Map<string, Set<string>>();
  let lastRequestTime = Date.now();
  let messageId = 0;

  return {
    createWorld: async (name: string, owner: string) => {
      const worldId = `world-${Date.now()}`;
      worldRooms.set(worldId, new Set());
      logger.info(`[MOCK] Created world ${worldId} with name ${name}`);
      return worldId;
    },

    createRoom: async (worldId: string, name: string) => {
      const roomId = `room-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      worldRooms.get(worldId)?.add(roomId);
      participants.set(roomId, new Set());
      logger.info(`[MOCK] Created room ${roomId} in world ${worldId}`);
      return roomId;
    },

    addParticipant: async (worldId: string, roomId: string, participantId: string) => {
      const roomParticipants = participants.get(roomId) || new Set();
      roomParticipants.add(participantId);
      participants.set(roomId, roomParticipants);
      logger.debug(`[MOCK] Added participant ${participantId} to room ${roomId}`);
      return true;
    },

    sendMessage: async (
      runtime: any,
      worldId: string,
      roomId: string,
      message: string,
      senderId?: string
    ) => {
      messageId++;
      lastRequestTime = Date.now();

      // Simulate random processing time to make the results more realistic
      const processingTime = Math.floor(Math.random() * 30) + 10;
      await new Promise((resolve) => setTimeout(resolve, processingTime));

      logger.debug(`[MOCK] Message sent to room ${roomId}: ${message.substring(0, 30)}...`);
      return { id: `msg-${messageId}`, success: true };
    },

    waitForCompletion: async (timeout: number) => {
      const responseTime = Math.random() * 200 + 50; // 50-250ms random response time
      await new Promise((resolve) => setTimeout(resolve, responseTime));
      return true;
    },
  };
}
