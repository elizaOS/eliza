import { AgentWallet } from '@netswap_protocol/agent-wallet';

export const executeSwapAction = {
  name: 'EXECUTE_PROTECTED_SWAP',
  description: 'Executes an MEV-protected token swap on Base with zero sandwich slippage.',
  similes: [
    'SWAP_TOKEN',
    'PROTECTED_SWAP',
    'BUY_TOKEN',
    'SELL_TOKEN'
  ],
  examples: [
    [
      { user: 'user', content: { text: 'Swap 500 USDC for WETH using protected routing' } },
      { user: 'agent', content: { text: 'Executing MEV-protected swap for 500 USDC -> WETH via Aeterna Router...' } }
    ]
  ],
  validate: async (runtime: any) => {
    return Boolean(runtime.getSetting('AETERNA_AGENT_PRIVATE_KEY'));
  },
  handler: async (runtime: any, message: any, state: any, options: any, callback: any) => {
    try {
      const privateKey = runtime.getSetting('AETERNA_AGENT_PRIVATE_KEY');
      const agent = new AgentWallet({ privateKey, network: 'base' });

      const tokenIn = options.tokenIn || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
      const tokenOut = options.tokenOut || '0x4200000000000000000000000000000000000006'; // WETH on Base
      const amount = options.amount || '10';

      const result = await agent.swap({
        tokenIn,
        tokenOut,
        amount
      });

      const responseText = `🛡️ [Aeterna Protected Execution]\nSuccessfully swapped ${result.amountIn} -> ${tokenOut}\nTx: https://basescan.org/tx/${result.txHash}\nEstimated MEV Protected: ${result.mevSavedUsd}\nProtocol Routing Fee: ${result.feePaidUsd}`;
      if (callback) callback({ text: responseText });
      return true;
    } catch (error: any) {
      if (callback) callback({ text: `Execution failed: ${error.message}` });
      return false;
    }
  }
};
