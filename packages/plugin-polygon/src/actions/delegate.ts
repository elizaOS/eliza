import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';

// TODO: Define specific input/output schemas/types based on ElizaOS conventions

export const delegatePolygonAction: Action = {
  name: 'DELEGATE_POLYGON',
  similes: ['STAKE_MATIC', 'BOND_MATIC'], // Example similes
  description: 'Delegates (stakes) MATIC tokens to a validator on the Polygon network.',

  // TODO: Implement validation if necessary (e.g., check for valid validator ID)
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    logger.debug('Validating DELEGATE_POLYGON action...');

    if (
      !runtime.getSetting('WALLET_PUBLIC_KEY') ||
      !runtime.getSetting('WALLET_PRIVATE_KEY') ||
      !runtime.getSetting('POLYGON_PLUGINS_ENABLED')
    ) {
      logger.error(
        'Required settings (WALLET_PUBLIC_KEY, WALLET_PRIVATE_KEY, POLYGON_PLUGINS_ENABLED) are not configured for DELEGATE_POLYGON action.'
      );
      return false;
    }
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: any,
    callback: HandlerCallback | undefined,
    _responses: Memory[] | undefined
  ) => {
    logger.info('Handling DELEGATE_POLYGON action for message:', message.id);
    // TODO: Extract parameters (validatorId, amount) from message content or state
    // const params = { validatorId: '...', amount: '...' };
    // console.log('DELEGATE_POLYGON called with extracted params:', params);

    // TODO: Implement actual delegation logic (interaction with StakingManager on L1)
    logger.warn('Delegate Polygon action logic not implemented.');
    const txHash = '0x_delegate_placeholder_hash'; // Placeholder

    // Format the response content
    const responseContent: Content = {
      text: `Placeholder: Initiated MATIC delegation. Transaction hash: ${txHash}`,
      actions: ['DELEGATE_POLYGON'],
      source: message.content.source,
      // data: { transactionHash: txHash, status: 'pending' }
    };

    if (callback) {
      await callback(responseContent);
    }
    return responseContent;
  },

  // TODO: Add relevant examples
  examples: [
    {
      input: 'Stake 100 MATIC to validator 0x1234abcd...',
      output: 'Successfully delegated 100 MATIC to validator 0x1234abcd...\nTransaction hash: 0x9a8b7c6d5e4f3a2b1c0d1e2f3a4b5c6d7e8f9a0b\nValidator details:\nName: Validator Alpha\nCommission: 10%\nCurrent Stake: 1,000,100 MATIC\nEstimated Annual Yield: 8.5%',
    },
    {
      input: 'Delegate 50 MATIC to Polygon validator NodeOps',
      output: 'Successfully delegated 50 MATIC to validator NodeOps (0x2345bcde...)\nTransaction hash: 0x8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c\nGas used: 150,000 gwei (0.003 MATIC)\nYour delegation will start earning rewards in approximately 1 hour\nTotal delegated to NodeOps: 1,550 MATIC',
    },
    {
      input: 'I want to bond 200 MATIC with the validator that has the lowest commission',
      output: 'Delegated 200 MATIC to validator PolyStake (0x6789ghij...)\nTransaction hash: 0x7c6d5e4f3a2b1c0d1e2f3a4b5c6d7e8f9a0b1c2d\nThis validator was selected for having the lowest commission rate (3%)\nEstimated APY: 10.2%\nEstimated daily rewards: 0.056 MATIC',
    },
    {
      input: 'Stake 500 MATIC across the top 3 validators equally',
      output: 'Successfully executed multi-delegation strategy:\n1. Delegated 166.67 MATIC to Validator Alpha\nTx: 0x1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t\n2. Delegated 166.67 MATIC to Polygon Foundation\nTx: 0x2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u\n3. Delegated 166.66 MATIC to NodeOps\nTx: 0x3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v\nTotal gas fees: 0.009 MATIC',
    },
    {
      input: 'Delegate my entire MATIC balance to validator BlockDaemon with 10 MATIC reserved for gas',
      output: 'Delegated 489.5 MATIC to BlockDaemon (0x789abcde...)\nTransaction hash: 0x4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w\nReserved 10 MATIC for future gas fees\nYour wallet balance is now 10 MATIC\nEstimated monthly rewards: 3.52 MATIC',
    }
  ],
};
