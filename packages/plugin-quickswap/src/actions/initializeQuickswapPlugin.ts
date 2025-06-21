import { Action, IAgentRuntime, logger, Memory } from '@elizaos/core';

/**
 * M5-00: Initializes the Quickswap Plugin Structure and Configuration.
 * This action confirms that the Quickswap plugin has been successfully loaded
 * and its configuration processed.
 */
export const initializeQuickswapPluginAction: Action = {
  name: 'QUICKSWAP_INITIALIZE_PLUGIN',
  description: 'Initializes the Quickswap Plugin and confirms its configuration.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(
      `[initializeQuickswapPluginAction] Validate called for message: "${message.content?.text}"`
    );

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn(
        '[initializeQuickswapPluginAction] QUICKSWAP_API_URL is required but not provided'
      );
      return false;
    }

    logger.info('[initializeQuickswapPluginAction] Validation passed');
    return true;
  },
  handler: async (runtime: IAgentRuntime) => {
    logger.info('Quickswap plugin initialization action called.');
    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');
    const walletPrivateKeyStatus = runtime.getSetting('WALLET_PRIVATE_KEY')
      ? 'configured'
      : 'not configured';

    return {
      message: 'Quickswap plugin structure and configuration initialized.',
      details: {
        quickswapApiUrl,
        walletPrivateKeyStatus,
        status: 'success',
      },
    };
  },
};
