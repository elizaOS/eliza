import {
  IAgentRuntime,
  type Entity,
  type Room,
  type Content,
  type Memory,
  createUniqueUuid,
  EventType,
  asUUID,
  ChannelType,
  type World,
  AgentRuntime,
  elizaLogger,
} from '@elizaos/core';
import { v4 as uuid } from 'uuid';
import { strict as assert } from 'node:assert';
import { AutoTradingManager } from '../../services/AutoTradingManager.ts';

/**
 * Sets up a standard scenario environment for an E2E test.
 *
 * This function creates a world, a user, and a room, providing an
 * isolated environment for each test case.
 *
 * @param runtime The live IAgentRuntime instance provided by the TestRunner.
 * @returns A promise that resolves to an object containing the created world, user, and room.
 */
export async function setupScenario(
  runtime: IAgentRuntime
): Promise<{ user: Entity; room: Room; world: World }> {
  assert(runtime.agentId, 'Runtime must have an agentId to run a scenario');

  // Set up mock environment for auto-trader
  process.env.USE_MOCK_EXCHANGE = 'true';

  // 1. Create a test user entity first, so we can assign ownership
  const user: Entity = {
    id: asUUID(uuid()),
    names: ['Test User'],
    agentId: runtime.agentId,
    metadata: { type: 'user' },
  };
  await runtime.createEntity(user);
  assert(user.id, 'Created user must have an id');

  // 2. Create a World and assign the user as the owner.
  // This is critical for providers that check for ownership.
  const world: World = {
    id: asUUID(uuid()),
    agentId: runtime.agentId,
    name: 'E2E Test World',
    serverId: 'e2e-test-server',
    metadata: {
      ownership: {
        ownerId: user.id,
      },
    },
  };
  await runtime.ensureWorldExists(world);

  // 3. Create a test room associated with the world
  const room: Room = {
    id: asUUID(uuid()),
    name: 'Test DM Room',
    type: ChannelType.DM,
    source: 'e2e-test',
    worldId: world.id,
    serverId: world.serverId,
  };
  await runtime.createRoom(room);

  // 4. Ensure both the agent and the user are participants in the room
  await runtime.ensureParticipantInRoom(runtime.agentId, room.id);
  await runtime.ensureParticipantInRoom(user.id, room.id);

  // 5. Cache mock data for testing
  await runtime.setCache('mock_strategies', [
    { id: 'random', name: 'Random Strategy', description: 'Makes random trades.' },
    { id: 'rsi', name: 'RSI Strategy', description: 'Trades based on RSI indicator.' },
    { id: 'rule-based', name: 'Rule-Based Strategy', description: 'A simple rule-based strategy.' },
  ]);

  return { user, room, world };
}

/**
 * Simulates a user sending a message and waits for the agent's response.
 *
 * This function abstracts the event-driven nature of the message handler
 * into a simple async function, making tests easier to write and read.
 *
 * @param runtime The live IAgentRuntime instance.
 * @param room The room where the message is sent.
 * @param user The user entity sending the message.
 * @param text The content of the message.
 * @returns A promise that resolves with the agent's response content.
 */
export function sendMessageAndWaitForResponse(
  runtime: IAgentRuntime,
  room: Room,
  user: Entity,
  text: string
): Promise<Content> {
  return new Promise((resolve) => {
    assert(runtime.agentId, 'Runtime must have an agentId to send a message');
    assert(user.id, 'User must have an id to send a message');

    // Construct the message object, simulating an incoming message from a user
    const message: Memory = {
      id: createUniqueUuid(runtime, `${user.id}-${Date.now()}`),
      agentId: runtime.agentId,
      entityId: user.id,
      roomId: room.id,
      content: {
        text,
      },
      createdAt: Date.now(),
    };

    // The callback function that the message handler will invoke with the agent's final response.
    // We use this callback to resolve our promise.
    const callback = (responseContent: Content) => {
      resolve(responseContent);
    };

    // Emit the event to trigger the agent's message processing logic.
    runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime,
      message,
      callback,
    });
  });
}

export interface TestContext {
  runtime: IAgentRuntime;
  tradingManager: AutoTradingManager;
  startTime: number;
}

export async function waitForTrading(runtime: IAgentRuntime, maxWaitMs = 30000): Promise<boolean> {
  const tradingManager = runtime.getService('AutoTradingManager') as AutoTradingManager;
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    const status = tradingManager.getStatus();
    if (status.isTrading) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return false;
}

export async function monitorTrades(runtime: IAgentRuntime, durationMs: number): Promise<any> {
  const tradingManager = runtime.getService('AutoTradingManager') as AutoTradingManager;
  const startTime = Date.now();
  const tradeLog: any[] = [];
  
  elizaLogger.info(`[Test] Monitoring trades for ${durationMs / 1000} seconds...`);
  
  while (Date.now() - startTime < durationMs) {
    const status = tradingManager.getStatus();
    const performance = tradingManager.getPerformance();
    
    tradeLog.push({
      timestamp: Date.now(),
      isTrading: status.isTrading,
      strategy: status.strategy,
      positions: status.positions.length,
      performance: {
        totalPnL: performance.totalPnL,
        dailyPnL: performance.dailyPnL,
        totalTrades: performance.totalTrades,
        winRate: performance.winRate,
      }
    });
    
    // Log every 10 seconds
    if ((Date.now() - startTime) % 10000 < 1000) {
      elizaLogger.info(`[Test] Trading status:`, {
        elapsed: Math.floor((Date.now() - startTime) / 1000) + 's',
        ...tradeLog[tradeLog.length - 1]
      });
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return {
    duration: Date.now() - startTime,
    tradeLog,
    finalStatus: tradingManager.getStatus(),
    finalPerformance: tradingManager.getPerformance(),
  };
}

export function validateTradingResult(result: any): void {
  if (!result.finalStatus) {
    throw new Error('No final status in trading result');
  }
  
  if (!result.finalPerformance) {
    throw new Error('No final performance in trading result');
  }
  
  // Log summary
  elizaLogger.info(`[Test] Trading Summary:`, {
    duration: `${result.duration / 1000}s`,
    totalTrades: result.finalPerformance.totalTrades,
    winRate: `${(result.finalPerformance.winRate * 100).toFixed(1)}%`,
    totalPnL: result.finalPerformance.totalPnL.toFixed(2),
    dailyPnL: result.finalPerformance.dailyPnL.toFixed(2),
    finalPositions: result.finalStatus.positions.length,
  });
}

export async function simulateConversation(
  runtime: IAgentRuntime,
  messages: string[],
  delayMs = 5000
): Promise<void> {
  for (const message of messages) {
    elizaLogger.info(`[Test] User message: "${message}"`);
    
    // Simulate user sending a message
    // In a real implementation, this would go through the message handler
    // For now, we'll just log it
    
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
