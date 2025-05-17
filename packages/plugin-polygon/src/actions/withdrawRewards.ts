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

export const withdrawRewardsAction: Action = {
  name: 'WITHDRAW_REWARDS',
  similes: ['CLAIM_STAKING_REWARDS', 'COLLECT_REWARDS'], // Example similes
  description: 'Withdraws accumulated staking rewards.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    logger.debug('Validating WITHDRAW_REWARDS action...');

    if (
      !runtime.getSetting('WALLET_PUBLIC_KEY') ||
      !runtime.getSetting('WALLET_PRIVATE_KEY') ||
      !runtime.getSetting('POLYGON_PLUGINS_ENABLED')
    ) {
      logger.error(
        'Required settings (WALLET_PUBLIC_KEY, WALLET_PRIVATE_KEY, POLYGON_PLUGINS_ENABLED) are not configured for WITHDRAW_REWARDS action.'
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
    logger.info('Handling WITHDRAW_REWARDS action for message:', message.id);
    // TODO: Extract optional validatorAddress from message content or state if needed by the underlying contract call
    // const params = { validatorAddress: '...' };
    // console.log('WITHDRAW_REWARDS called with extracted params:', params);

    // TODO: Implement actual withdraw logic (interaction with StakingManager on L1?)
    logger.warn('Withdraw Rewards action logic not implemented.');
    const txHash = '0x_withdraw_placeholder_hash'; // Placeholder

    // Format the response content
    const responseContent: Content = {
      text: `Placeholder: Initiated staking reward withdrawal. Transaction hash: ${txHash}`,
      actions: ['WITHDRAW_REWARDS'],
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
      input: 'Withdraw my staking rewards from Polygon',
      output: 'Initiated staking reward withdrawal. Transaction hash: 0x7a3b5d8f1e6c4b2a9d0e1f2a3b4c5d6e7f8a9b0c\nTotal rewards: 45.23 MATIC\nEstimated completion time: ~5 minutes\nGas used: 150,000 gwei',
    },
    {
      input: 'Claim my MATIC rewards from validator 0x1234abcd...',
      output: 'Withdrawing rewards from validator 0x1234abcd...\nTransaction hash: 0x2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c\nTotal rewards: 12.5 MATIC\nReward period: May 1 - June 1, 2023\nGas fee: 0.002 MATIC',
    },
    {
      input: 'Collect all staking rewards from my Polygon validators',
      output: 'Initiated withdrawal of all staking rewards\nTransaction hash: 0x3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d\nTotal from 3 validators: 30.75 MATIC\nBreakdown:\n- Validator Alpha: 15.3 MATIC\n- NodeOps: 10.2 MATIC\n- PolyStake: 5.25 MATIC',
    },
    {
      input: "What's the gas cost to withdraw my staking rewards?",
      output: 'Current estimated gas cost for withdrawing staking rewards:\nStandard: 0.003 MATIC (~$0.002 USD)\nFast: 0.005 MATIC (~$0.003 USD)\nYou have 45.23 MATIC in pending rewards available for withdrawal.',
    },
    {
      input: 'Withdraw my rewards and restake them',
      output: 'Executing compound strategy (withdraw + restake):\nStep 1: Withdrew 45.23 MATIC rewards\nTransaction: 0x7a3b5d8f1e6c4b2a9d0e1f2a3b4c5d6e7f8a9b0c\nStep 2: Restaked 45.00 MATIC to same validators\nTransaction: 0x8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c\nGas fees: 0.23 MATIC',
    }
  ],
};
