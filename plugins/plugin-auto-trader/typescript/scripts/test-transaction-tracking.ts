#!/usr/bin/env bun

import { AutoTradingManager } from '../src/services/AutoTradingManager.ts';
import { TradeType, OrderType } from '../src/types.ts';

// Mock runtime
const mockRuntime = {
  getSetting: (key: string) => {
    if (key === 'TRADING_MODE') return 'live';
    if (key === 'SOLANA_ADDRESS') return 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';
    return null;
  },
  getService: (name: string) => {
    if (name === 'WalletIntegrationService') {
      return {
        getWalletAddress: () => 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      };
    }
    if (name === 'JupiterSwapService') {
      return {
        swap: async () => ({ signature: 'real_tx_signature_here' }),
      };
    }
    return null;
  },
} as any;

async function testTransactionTracking() {
  console.log('🧪 Testing Transaction ID Tracking\n');

  // Create trading manager
  const manager = new AutoTradingManager(mockRuntime);
  await manager.start();
  
  // Start trading to enable trade execution
  await manager.startTrading({
    strategy: 'random-v1',
    tokens: ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'], // BONK
    maxPositionSize: 10,
    intervalMs: 60000,
  });
  
  // Execute a mock trade
  const txId = await manager.executeTrade({
    action: TradeType.BUY,
    pair: 'BONK/USDC',
    quantity: 1000,
    price: 0.00001234,
    orderType: OrderType.MARKET,
    timestamp: Date.now(),
    reason: 'Test trade',
  });

  console.log('✅ Trade executed:');
  console.log(`   TX ID: ${txId}`);
  console.log(`   Length: ${txId.length} characters`);
  console.log(`   Is Mock: ${txId.startsWith('mock_')}`);
  console.log(`   Solscan URL: https://solscan.io/tx/${txId}`);

  // Get transaction history
  const history = manager.getTransactionHistory();
  console.log(`\n📜 Transaction History (${history.length} total):`);
  
  for (const tx of history) {
    console.log(`\n   ${tx.action} ${tx.quantity} ${tx.token}`);
    console.log(`   Price: $${tx.price}`);
    console.log(`   Time: ${new Date(tx.timestamp).toLocaleString()}`);
    console.log(`   TX: ${tx.id}`);
    console.log(`   Reason: ${tx.reason || 'N/A'}`);
  }

  // Test latest transactions
  console.log('\n📋 Latest Transaction:');
  const latest = manager.getLatestTransactions(1);
  if (latest.length > 0) {
    console.log(`   ${latest[0].id}`);
  }
  
  // Stop trading
  await manager.stop();
}

testTransactionTracking().catch(console.error); 