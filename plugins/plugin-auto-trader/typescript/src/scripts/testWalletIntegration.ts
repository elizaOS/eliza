import { elizaLogger } from '@elizaos/core';
import { WalletIntegrationService } from '../services/WalletIntegrationService.ts';

// Mock runtime for testing
const mockRuntime = {
  getSetting: (key: string) => {
    const settings: Record<string, string> = {
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || '',
    };
    return settings[key] || '';
  },
  logger: elizaLogger,
} as any;

async function main() {
  console.log('🔧 Testing Wallet Integration Service\n');

  try {
    // Create and start wallet service
    const walletService = new WalletIntegrationService(mockRuntime);
    await walletService.start();

    // Check if wallet is available
    if (!walletService.isWalletAvailable()) {
      console.log('❌ Wallet not available. Please set WALLET_PRIVATE_KEY environment variable.');
      process.exit(1);
    }

    // Get wallet address
    const address = walletService.getWalletAddress();
    console.log(`✅ Wallet Address: ${address}`);

    // Get balance
    console.log('\n📊 Fetching wallet balance...');
    const balance = await walletService.getBalance();

    console.log(`💰 SOL Balance: ${balance.sol.toFixed(4)} SOL`);

    if (balance.tokens.size > 0) {
      console.log('\n🪙 Token Balances:');

      // Common token mints to check
      const knownTokens: Record<string, string> = {
        EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
        Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
        DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
        EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 'WIF',
        '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'POPCAT',
      };

      balance.tokens.forEach((tokenInfo, mint) => {
        const name = knownTokens[mint] || mint.slice(0, 8) + '...';
        console.log(`  • ${name}: ${tokenInfo.amount.toFixed(tokenInfo.decimals > 2 ? 4 : 2)}`);
      });
    } else {
      console.log('\n📭 No token balances found');
    }

    // Test connection
    const connection = walletService.getConnection();
    const slot = await connection.getSlot();
    console.log(`\n🌐 Connected to Solana - Current Slot: ${slot.toLocaleString()}`);

    console.log('\n✅ Wallet integration test completed successfully!');
  } catch (error) {
    console.error('\n❌ Error testing wallet integration:', error);
    process.exit(1);
  }
}

main()
  .then(() => {
    console.log('\n👋 Test complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
