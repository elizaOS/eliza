#!/usr/bin/env bun

import { logger } from '@elizaos/core';

async function testPaymentPlugin() {
  logger.info('🧪 Testing payment plugin loading...');

  try {
    // Test 1: Can we import the payment plugin?
    const paymentModule = await import('@elizaos/plugin-payment');
    logger.info('✅ Payment module imported successfully');

    const paymentPlugin = paymentModule.default || paymentModule.paymentPlugin;
    if (!paymentPlugin) {
      throw new Error('Payment plugin not found in module exports');
    }

    logger.info(`✅ Payment plugin loaded: ${paymentPlugin.name}`);
    logger.info(`   Description: ${paymentPlugin.description}`);
    logger.info(`   Services: ${paymentPlugin.services?.length || 0}`);
    logger.info(`   Actions: ${paymentPlugin.actions?.length || 0}`);

    // Test 2: Check PaymentService
    if (paymentPlugin.services && paymentPlugin.services.length > 0) {
      const PaymentService = paymentPlugin.services[0];
      logger.info(`✅ PaymentService found: ${PaymentService.name}`);
    }

    // Test 3: Check research action
    if (paymentPlugin.actions && paymentPlugin.actions.length > 0) {
      const researchAction = paymentPlugin.actions[0];
      logger.info(`✅ Research action found: ${researchAction.name}`);
      logger.info(`   Description: ${researchAction.description}`);
    }

    logger.info('\n✅ All basic tests passed!');
  } catch (error) {
    logger.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testPaymentPlugin().catch(console.error);
