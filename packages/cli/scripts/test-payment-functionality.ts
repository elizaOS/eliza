#!/usr/bin/env bun

import {
  AgentRuntime,
  type Character,
  type Memory,
  type UUID,
  ChannelType,
  asUUID,
} from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { plugin as sqlPlugin } from '@elizaos/plugin-sql';
import paymentPlugin from '@elizaos/plugin-payment';
import bootstrapPlugin from '@elizaos/plugin-message-handling';
import { v4 as uuidv4 } from 'uuid';

// Helper function to create a message
function createMessage(userId: UUID, roomId: UUID, text: string, agentId?: UUID): Memory {
  return {
    id: asUUID(uuidv4()),
    entityId: userId,
    roomId,
    agentId,
    content: {
      text,
      source: 'test',
    },
    createdAt: Date.now(),
  };
}

async function runPaymentTests() {
  console.log('🧪 Starting payment functionality tests...\n');

  try {
    // Initialize server
    const server = new AgentServer();
    await server.initialize();

    // Create test character
    const testCharacter: Character = {
      id: asUUID(uuidv4()),
      name: 'PaymentTestAgent',
      bio: ['An AI agent with payment capabilities for premium services'],
      system:
        'You are a helpful AI assistant that provides premium services with payment functionality.',
      plugins: [sqlPlugin.name, bootstrapPlugin.name, paymentPlugin.name],
      settings: {
        PAYMENT_ENABLED: 'true',
        PAYMENT_DEFAULT_CURRENCY: 'USDC',
        PAYMENT_TRUST_DISCOUNT_ADMIN: '1.0',
        PAYMENT_TRUST_DISCOUNT_OWNER: '1.0',
        PAYMENT_TRUST_DISCOUNT_FRIEND: '0.5',
        PAYMENT_TRUST_DISCOUNT_TRUSTED: '0.2',
        PAYMENT_DEFAULT_PRICE_RESEARCH: '1.0',
      },
    };

    // Create runtime
    console.log('🔧 Creating agent runtime...');
    const runtime = new AgentRuntime({
      adapter: server.database,
      agentId: testCharacter.id as UUID,
      character: testCharacter,
      plugins: [sqlPlugin, bootstrapPlugin, paymentPlugin],
    });

    // Initialize runtime
    await runtime.initialize();
    console.log('✅ Agent runtime initialized\n');

    // Test 1: Check if payment service is available
    console.log('📋 Test 1: Payment Service Availability');
    const paymentService = runtime.getService('payment');
    if (paymentService) {
      console.log('✅ Payment service is available');
    } else {
      console.log('❌ Payment service not found');
      return;
    }

    // Test 2: Check if research action is available
    console.log('\n📋 Test 2: Research Action Availability');
    const researchAction = runtime.actions.find((a) => a.name === 'RESEARCH');
    if (researchAction) {
      console.log('✅ Research action is available');
    } else {
      console.log('❌ Research action not found');
    }

    // Test 3: Test payment configuration
    console.log('\n📋 Test 3: Payment Configuration Test');

    // Check payment settings
    const paymentEnabled = runtime.getSetting('PAYMENT_ENABLED');
    const defaultCurrency = runtime.getSetting('PAYMENT_DEFAULT_CURRENCY');
    const researchPrice = runtime.getSetting('PAYMENT_DEFAULT_PRICE_RESEARCH');

    console.log(`   Payment enabled: ${paymentEnabled}`);
    console.log(`   Default currency: ${defaultCurrency}`);
    console.log(`   Research price: ${researchPrice} ${defaultCurrency}`);

    // Test 4: Check price oracle service
    console.log('\n📋 Test 4: Price Oracle Service');
    const priceOracleService = runtime.getService('price-oracle');
    if (priceOracleService) {
      console.log('✅ Price oracle service is available');

      // Test getting a price
      const price = await (priceOracleService as any).getPrice('RESEARCH', 'USDC');
      console.log(`   Research price in USDC: ${price}`);
    } else {
      console.log('❌ Price oracle service not found');
    }

    console.log('\n✅ All tests completed!');

    // Cleanup
    await server.stop();
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the tests
runPaymentTests().catch(console.error);
