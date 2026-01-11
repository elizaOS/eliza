#!/usr/bin/env bun
/**
 * Standalone E2E test for plugin-blockrun
 *
 * Run with: bun run test-e2e.ts
 * Requires: BASE_CHAIN_WALLET_KEY environment variable
 */

import { LLMClient } from '@blockrun/llm';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function testWalletProvider() {
  console.log('\n=== Testing Wallet Provider ===\n');

  const privateKey = process.env.BASE_CHAIN_WALLET_KEY;
  if (!privateKey) {
    console.log('❌ BASE_CHAIN_WALLET_KEY not set');
    return false;
  }

  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    console.log('✅ Wallet address:', account.address);

    const publicClient = createPublicClient({
      chain: base,
      transport: http(),
    });

    // Get USDC balance
    const usdcBalance = await publicClient.readContract({
      address: USDC_BASE as `0x${string}`,
      abi: [{
        constant: true,
        inputs: [{ name: '_owner', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: 'balance', type: 'uint256' }],
        type: 'function',
      }],
      functionName: 'balanceOf',
      args: [account.address],
    });

    console.log('✅ USDC balance:', formatUnits(usdcBalance, 6), 'USDC');

    // Get ETH balance
    const ethBalance = await publicClient.getBalance({ address: account.address });
    console.log('✅ ETH balance:', formatUnits(ethBalance, 18), 'ETH');

    return true;
  } catch (error) {
    console.log('❌ Wallet error:', error);
    return false;
  }
}

async function testBlockrunChat() {
  console.log('\n=== Testing BlockRun Chat (x402) ===\n');

  const privateKey = process.env.BASE_CHAIN_WALLET_KEY;
  if (!privateKey) {
    console.log('❌ BASE_CHAIN_WALLET_KEY not set');
    return false;
  }

  try {
    const client = new LLMClient({ privateKey: privateKey as `0x${string}` });
    console.log('✅ LLMClient initialized');
    console.log('   Wallet:', client.getWalletAddress());

    // Test 1: Simple chat
    console.log('\n📤 Test 1: Simple question...');
    const start1 = Date.now();
    const response1 = await client.chat('openai/gpt-4o-mini', 'What is 2+2? Reply with just the number.');
    console.log('📥 Response:', response1);
    console.log('⏱️  Latency:', Date.now() - start1, 'ms');

    // Test 2: Another model
    console.log('\n📤 Test 2: Different question...');
    const start2 = Date.now();
    const response2 = await client.chat('openai/gpt-4o-mini', 'Say hello in Japanese. Just the greeting.');
    console.log('📥 Response:', response2);
    console.log('⏱️  Latency:', Date.now() - start2, 'ms');

    // Test 3: With system prompt
    console.log('\n📤 Test 3: With system prompt...');
    const start3 = Date.now();
    const response3 = await client.chat('openai/gpt-4o-mini', 'What do you do?', {
      system: 'You are a pirate. Speak like one.',
      maxTokens: 50,
    });
    console.log('📥 Response:', response3);
    console.log('⏱️  Latency:', Date.now() - start3, 'ms');

    console.log('\n✅ All BlockRun chat tests passed!');
    return true;
  } catch (error) {
    console.log('❌ BlockRun error:', error);
    return false;
  }
}

async function testListModels() {
  console.log('\n=== Testing List Models ===\n');

  const privateKey = process.env.BASE_CHAIN_WALLET_KEY;
  if (!privateKey) {
    console.log('❌ BASE_CHAIN_WALLET_KEY not set');
    return false;
  }

  try {
    const client = new LLMClient({ privateKey: privateKey as `0x${string}` });
    const models = await client.listModels();

    console.log('✅ Available models:', models.length);
    models.slice(0, 5).forEach(m => {
      console.log(`   - ${m.id}: $${m.inputPrice}/1M input, $${m.outputPrice}/1M output`);
    });

    return true;
  } catch (error) {
    console.log('❌ List models error:', error);
    return false;
  }
}

async function main() {
  console.log('🚀 BlockRun Plugin E2E Test');
  console.log('============================');

  const results = {
    wallet: await testWalletProvider(),
    models: await testListModels(),
    chat: await testBlockrunChat(),
  };

  console.log('\n============================');
  console.log('📊 Test Results:');
  console.log('   Wallet Provider:', results.wallet ? '✅ PASS' : '❌ FAIL');
  console.log('   List Models:', results.models ? '✅ PASS' : '❌ FAIL');
  console.log('   BlockRun Chat:', results.chat ? '✅ PASS' : '❌ FAIL');

  const allPassed = Object.values(results).every(r => r);
  console.log('\n' + (allPassed ? '🎉 All tests passed!' : '⚠️  Some tests failed'));

  process.exit(allPassed ? 0 : 1);
}

main();
