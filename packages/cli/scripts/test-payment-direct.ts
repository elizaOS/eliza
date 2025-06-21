#!/usr/bin/env bun

import {
  AgentRuntime,
  type Character,
  type Plugin,
  logger,
  type UUID,
  ChannelType,
} from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { plugin as sqlPlugin } from '@elizaos/plugin-sql';
import paymentPlugin from '@elizaos/plugin-payment';
import bootstrapPlugin from '@elizaos/plugin-message-handling';
import { v4 as uuidv4 } from 'uuid';

async function runPaymentTests() {
  logger.info('🧪 Starting direct payment functionality tests...');

  try {
    // Initialize server
    const server = new AgentServer();
    await server.initialize();

    // Create test characters
    const paymentAgentCharacter: Character = {
      id: uuidv4(),
      name: 'PaymentTestAgent',
      bio: ['An AI agent with payment capabilities for premium services'],
      system: `You are an AI agent with payment integration. You offer premium services that require payment:
- Research services cost 1 USDC
- Data analysis costs 5 USDC
- Premium content generation costs 2 USDC

When users request these services, inform them of the cost and process payments appropriately.
Always be transparent about pricing and provide value for paid services.`,
      modelProvider: 'openai',
      settings: {
        model: 'gpt-4o-mini',
        temperature: 0.7,
      },
    };

    const customerCharacter: Character = {
      id: uuidv4(),
      name: 'TestCustomer',
      bio: ['A test customer for payment scenarios'],
      system: 'You are a customer interested in premium services.',
      modelProvider: 'openai',
      settings: {
        model: 'gpt-4o-mini',
        temperature: 0.7,
      },
    };

    // Create runtimes
    const plugins: Plugin[] = [sqlPlugin, bootstrapPlugin, paymentPlugin];

    const agentRuntime = new AgentRuntime({
      character: paymentAgentCharacter,
      plugins,
      adapter: server.database,
    });

    const customerRuntime = new AgentRuntime({
      character: customerCharacter,
      plugins,
      adapter: server.database,
    });

    await agentRuntime.initialize();
    await customerRuntime.initialize();

    logger.info('✅ Runtimes initialized successfully');

    // Test 1: Basic Payment Flow
    logger.info('\n📋 Test 1: Basic Payment Flow');

    // Create a test room
    const roomId = await agentRuntime.createRoom({
      name: 'Payment Test Room',
      source: 'test',
      type: 'DM',
    });

    // Simulate conversation
    const message1 = await customerRuntime.createMemory(
      {
        entityId: customerRuntime.agentId,
        roomId,
        content: {
          text: 'Hi! I need help researching the latest developments in quantum computing.',
        },
      },
      'messages'
    );

    // Process message with agent
    const state = await agentRuntime.composeState({
      entityId: agentRuntime.agentId,
      roomId,
      content: message1.content,
    });

    // Check if payment service is available
    const paymentService = agentRuntime.getService('payment');
    logger.info(`Payment service available: ${!!paymentService}`);

    // Test 2: Payment Service Methods
    if (paymentService) {
      logger.info('\n📋 Test 2: Payment Service Methods');

      try {
        // Test balance check
        const balance = await paymentService.checkBalance(customerRuntime.agentId, 'USDC');
        logger.info(`Customer USDC balance: ${balance}`);

        // Test payment processing
        const paymentResult = await paymentService.processPayment({
          fromUserId: customerRuntime.agentId,
          toUserId: agentRuntime.agentId,
          amount: 1,
          currency: 'USDC',
          description: 'Research service payment',
        });
        logger.info(`Payment result: ${paymentResult.success ? 'Success' : 'Failed'}`);
        if (!paymentResult.success) {
          logger.info(`Payment error: ${paymentResult.error}`);
        }
      } catch (error) {
        logger.error('Payment service test error:', error);
      }
    }

    // Test 3: Trust-based exemptions
    logger.info('\n📋 Test 3: Trust-based exemptions');

    // Update customer metadata to be admin
    await customerRuntime.updateEntity({
      id: customerRuntime.agentId,
      metadata: {
        role: 'ADMIN',
      },
    });

    const isExempt = await paymentService?.isPaymentExempt(
      customerRuntime.agentId,
      agentRuntime.agentId
    );
    logger.info(`Admin payment exemption: ${isExempt}`);

    // Cleanup
    await agentRuntime.stop();
    await customerRuntime.stop();
    await server.stop();

    logger.info('\n✅ All tests completed');
  } catch (error) {
    logger.error('Test failed:', error);
    process.exit(1);
  }
}

// Run tests
runPaymentTests().catch(console.error);
