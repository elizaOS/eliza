import {
  type Plugin,
  type IAgentRuntime,
  type Action,
  type Provider,
  type ProviderResult,
  logger,
  type Service,
  elizaLogger,
  type Memory,
  type State,
} from '@elizaos/core';
import { z } from 'zod';
import { ethers } from 'ethers';

// Add global handler for unhandled promise rejections to prevent Node crashes
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection:', reason);
  // Don't crash, just log the error and continue
});

import { transferPolygonAction } from './actions/transfer.ts';
import { delegateL1Action } from './actions/delegateL1.ts';
import { getCheckpointStatusAction } from './actions/getCheckpointStatus.ts';
import { getValidatorInfoAction } from './actions/getValidatorInfo.ts';
import { getDelegatorInfoAction } from './actions/getDelegatorInfo.ts';
import { withdrawRewardsAction } from './actions/withdrawRewardsL1.ts';
import { bridgeDepositAction } from './actions/bridgeDeposit.ts';
import { getL2BlockNumberAction } from './actions/getL2BlockNumber.ts';
import { getMaticBalanceAction } from './actions/getMaticBalance.ts';
import { getPolygonGasEstimatesAction } from './actions/getPolygonGasEstimates.ts';
import { undelegateL1Action } from './actions/undelegateL1.ts';
import { restakeRewardsL1Action } from './actions/restakeRewardsL1.ts';
import { isL2BlockCheckpointedAction } from './actions/isL2BlockCheckpointed.ts';
// Heimdall read-only query actions
import { heimdallValidatorInfoAction } from './actions/heimdallValidatorInfoAction.ts';
import { heimdallValidatorSetAction } from './actions/heimdallValidatorSetAction.ts';
import { heimdallCheckpointStatusAction } from './actions/heimdallCheckpointStatusAction.ts';
// import { getNativeBalanceAction, getERC20BalanceAction } from './actions/getBalanceInfo.ts';
import { getUSDCBalanceAction, getWETHBalanceAction } from './actions/getBalanceInfo.ts';
import { getBlockNumberAction, getBlockDetailsAction } from './actions/getBlockInfo.ts';
import { getPolygonBlockDetailsAction } from './actions/getPolygonBlockDetails.ts';
import { proposeGovernanceAction } from './actions/proposeGovernance.ts';
import { executeGovernanceAction } from './actions/executeGovernance.ts';
import { voteGovernanceAction } from './actions/voteGovernance.ts';
import { queueGovernanceAction } from './actions/queueGovernance.ts';
import { swapAction } from './actions/swap.ts';

import {
  WalletProvider,
  initWalletProvider,
  polygonWalletProvider,
} from './providers/PolygonWalletProvider.ts';
import {
  PolygonRpcService,
  type ValidatorInfo,
  type DelegatorInfo,
  ValidatorStatus,
} from './services/PolygonRpcService.ts';
import { HeimdallService } from './services/HeimdallService.ts';
import { getGasPriceEstimates, type GasPriceEstimates } from './services/GasService.ts';
import { parseBigIntString } from './utils.ts'; // Import from utils

// --- Configuration Schema --- //
const configSchema = z.object({
  POLYGON_RPC_URL: z.string().url('Invalid Polygon RPC URL').min(1),
  ETHEREUM_RPC_URL: z.string().url('Invalid Ethereum RPC URL').min(1),
  PRIVATE_KEY: z.string().min(1, 'Private key is required'),
  POLYGONSCAN_KEY: z.string().min(1, 'PolygonScan API Key is required'),
  HEIMDALL_RPC_URL: z.string().url('Invalid Heimdall RPC URL').min(1).optional(),
});

// Infer the type from the schema
type PolygonPluginConfig = z.infer<typeof configSchema>;

// --- Define Actions --- //
const polygonActions: Action[] = [
  transferPolygonAction,
  getValidatorInfoAction,
  getDelegatorInfoAction,
  bridgeDepositAction,
  getCheckpointStatusAction,
  getL2BlockNumberAction,
  getMaticBalanceAction,
  getPolygonGasEstimatesAction,
  delegateL1Action,
  undelegateL1Action,
  withdrawRewardsAction,
  restakeRewardsL1Action,
  isL2BlockCheckpointedAction,
  getBlockNumberAction,
  // getBlockDetailsAction,  // Temporarily disabled - uses old interface, conflicts with getPolygonBlockDetailsAction
  getPolygonBlockDetailsAction,
  getUSDCBalanceAction,
  getWETHBalanceAction,
  heimdallValidatorInfoAction,
  heimdallValidatorSetAction,
  heimdallCheckpointStatusAction,
  proposeGovernanceAction,
  executeGovernanceAction,
  voteGovernanceAction,
  queueGovernanceAction,
  swapAction,
];

// Debug logging for action registration
logger.info(`[PolygonPlugin] Registering ${polygonActions.length} actions:`);
polygonActions.forEach((action) => {
  logger.info(
    `[PolygonPlugin] - Action: ${action.name} (similes: ${action.similes?.join(', ') || 'none'})`
  );
});
logger.info(
  `[PolygonPlugin] Actions with new interface: GET_MATIC_BALANCE, GET_L2_BLOCK_NUMBER, GET_POLYGON_BLOCK_DETAILS, GET_USDC_BALANCE, GET_WETH_BALANCE`
);

// --- Define Providers --- //

/**
 * Provider to fetch and display Polygon-specific info like address, balance, gas.
 */
const polygonProviderInfo: Provider = {
  name: 'Polygon Provider Info',
  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    state: State | undefined
  ): Promise<ProviderResult> {
    try {
      // 1. Initialize WalletProvider to get address
      const polygonWalletProviderInstance = await initWalletProvider(runtime);
      if (!polygonWalletProviderInstance) {
        // Renamed to avoid conflict
        throw new Error(
          'Failed to initialize PolygonWalletProvider - check PRIVATE_KEY configuration'
        );
      }
      const agentAddress = polygonWalletProviderInstance.getAddress();
      if (!agentAddress) throw new Error('Could not determine agent address from provider');

      // 2. Get PolygonRpcService instance (should be already started)
      const polygonRpcService = runtime.getService<PolygonRpcService>(
        PolygonRpcService.serviceType
      );
      if (!polygonRpcService) {
        throw new Error('PolygonRpcService not available or not started');
      }

      // 3. Get L2 (Polygon) MATIC balance
      const maticBalanceWei = await polygonRpcService.getBalance(agentAddress, 'L2');
      const maticBalanceFormatted = ethers.formatEther(maticBalanceWei);

      // 4. Get Gas price info
      const gasEstimates = await getGasPriceEstimates(runtime);

      const agentName = state?.agentName || 'The agent';

      // 5. Format the text output
      let text = `${agentName}'s Polygon Status:\\n`;
      text += `  Wallet Address: ${agentAddress}\\n`;
      text += `  MATIC Balance: ${maticBalanceFormatted} MATIC\\n`;
      text += '  Current Gas Prices (Max Priority Fee Per Gas - Gwei):\\n';
      const safeLowGwei = gasEstimates.safeLow?.maxPriorityFeePerGas
        ? ethers.formatUnits(gasEstimates.safeLow.maxPriorityFeePerGas, 'gwei')
        : 'N/A';
      const averageGwei = gasEstimates.average?.maxPriorityFeePerGas
        ? ethers.formatUnits(gasEstimates.average.maxPriorityFeePerGas, 'gwei')
        : 'N/A';
      const fastGwei = gasEstimates.fast?.maxPriorityFeePerGas
        ? ethers.formatUnits(gasEstimates.fast.maxPriorityFeePerGas, 'gwei')
        : 'N/A';
      const baseFeeGwei = gasEstimates.estimatedBaseFee
        ? ethers.formatUnits(gasEstimates.estimatedBaseFee, 'gwei')
        : 'N/A';

      text += `    - Safe Low: ${safeLowGwei}\\n`;
      text += `    - Average:  ${averageGwei}\\n`; // Adjusted name to average
      text += `    - Fast:     ${fastGwei}\\n`;
      text += `  Estimated Base Fee (Gwei): ${baseFeeGwei}\\n`;

      return {
        text,
        data: {
          address: agentAddress,
          maticBalance: maticBalanceFormatted,
          gasEstimates: {
            safeLowGwei,
            averageGwei,
            fastGwei,
            baseFeeGwei,
          },
        },
        values: {
          // Provide raw values or formatted strings as needed
          address: agentAddress,
          maticBalance: maticBalanceFormatted,
          gas_safe_low_gwei: safeLowGwei,
          gas_average_gwei: averageGwei, // Changed key name
          gas_fast_gwei: fastGwei,
          gas_base_fee_gwei: baseFeeGwei,
        },
      };
    } catch (error) {
      logger.error('Error getting Polygon provider info:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Create a more user-friendly message based on the error
      const userMessage = errorMessage.includes('private key')
        ? 'There was an issue with the wallet configuration. Please ensure PRIVATE_KEY is correctly set.'
        : `Error getting Polygon provider info: ${errorMessage}`;

      return {
        text: userMessage,
        data: { error: errorMessage },
        values: { error: errorMessage },
      };
    }
  },
};

const polygonProviders: Provider[] = [polygonWalletProvider, polygonProviderInfo];

// --- Define Services --- //
const polygonServices: (typeof Service)[] = [PolygonRpcService, HeimdallService];

// --- Plugin Definition --- //
export const polygonPlugin: Plugin = {
  name: '@elizaos/plugin-polygon',
  description: 'Plugin for interacting with the Polygon PoS network and staking.',

  // Configuration loaded from environment/character settings
  config: {
    POLYGON_RPC_URL: process.env.POLYGON_RPC_URL,
    ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    POLYGONSCAN_KEY: process.env.POLYGONSCAN_KEY,
    HEIMDALL_RPC_URL: process.env.HEIMDALL_RPC_URL,
  },

  // Initialization logic
  async init(config: Record<string, unknown>, runtime: IAgentRuntime) {
    logger.info(`Initializing plugin: ${this.name}`);
    try {
      // Validate configuration
      const validatedConfig = await configSchema.parseAsync(config);
      logger.info('Polygon plugin configuration validated successfully.');

      // Store validated config in runtime settings for services/actions/providers to access
      // This assumes runtime has a way to store validated plugin config or settings are global
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (!runtime.getSetting(key)) {
          logger.warn(
            `Setting ${key} was validated but not found via runtime.getSetting. Ensure it is loaded globally before plugin init.`
          );
        }
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error('Invalid Polygon plugin configuration:', error.errors);
        throw new Error(
          `Invalid Polygon plugin configuration: ${error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`
        );
      }
      logger.error('Error during Polygon plugin initialization:', error);
      throw error;
    }
  },

  // Register components
  actions: polygonActions,
  providers: polygonProviders,
  services: polygonServices,

  // Optional lifecycle methods, models, tests, routes, events
  models: {},
  tests: [],
  routes: [],
  events: {},
};

// Default export for ElizaOS to load
export default polygonPlugin;
