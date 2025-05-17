import {
  type Plugin,
  type IAgentRuntime,
  type Action,
  type Provider,
  type ProviderResult,
  logger,
  Service,
} from '@elizaos/core';
import { z } from 'zod';

// Import all action files
import { transferPolygonAction } from './actions/transfer.js';
import { delegatePolygonAction } from './actions/delegate.js';
import { getCheckpointStatusAction } from './actions/getCheckpointStatus.js';
import { proposeGovernanceAction } from './actions/proposeGovernance.js';
import { voteGovernanceAction } from './actions/voteGovernance.js';
import { getValidatorInfoAction } from './actions/getValidatorInfo.js';
import { getDelegatorInfoAction } from './actions/getDelegatorInfo.js';
import { withdrawRewardsAction } from './actions/withdrawRewards.js';
import { bridgeDepositAction } from './actions/bridgeDeposit.js';
import { getBlockNumberAction, getBlockDetailsAction } from './actions/getBlockInfo.js';
import { getTransactionDetailsAction } from './actions/getTransactionInfo.js';
import { getNativeBalanceAction, getERC20BalanceAction } from './actions/getBalanceInfo.js';
import { getGovernanceInfoAction, getVotingPowerAction } from './actions/getGovernanceInfo.js';

// Import providers and services
import { WalletProvider } from './providers/PolygonWalletProvider.js';
import { PolygonRpcService } from './services/PolygonRpcService.js';
import { GovernanceService } from './services/GovernanceService.js';
import { getGasPriceEstimates, GasPriceEstimates } from './services/GasService.js';
import { PolygonBridgeService } from './services/PolygonBridgeService.js';

// Import our custom formatters
import { formatUnits } from './utils/formatters.js';

// Import default configuration
import { DEFAULT_RPC_URLS } from './config.js';

// --- Configuration Schema --- //
const configSchema = z.object({
  POLYGON_RPC_URL: z.string().url('Invalid Polygon RPC URL').min(1).default(DEFAULT_RPC_URLS.POLYGON_RPC_URL),
  ETHEREUM_RPC_URL: z.string().url('Invalid Ethereum RPC URL').min(1).default(DEFAULT_RPC_URLS.ETHEREUM_RPC_URL),
  PRIVATE_KEY: z.string().min(1, 'Private key is required'),
  POLYGONSCAN_KEY: z.string().min(1, 'PolygonScan API Key is required'),
  GOVERNOR_ADDRESS: z.string().optional(),
  TOKEN_ADDRESS: z.string().optional(),
  TIMELOCK_ADDRESS: z.string().optional(),
});

// Infer the type from the schema
type PolygonPluginConfig = z.infer<typeof configSchema>;

// Helper to parse amount/shares (could be moved to utils)
function parseBigIntString(value: unknown, unitName: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`Invalid ${unitName} amount: Must be a string representing an integer.`);
  }
  try {
    return BigInt(value);
  } catch (e) {
    throw new Error(`Invalid ${unitName} amount: Cannot parse '${value}' as BigInt.`);
  }
}

// --- Define Actions --- //
const polygonActions: Action[] = [
  // Core actions
  transferPolygonAction,
  getValidatorInfoAction,
  getDelegatorInfoAction,
  bridgeDepositAction,
  getCheckpointStatusAction,
  proposeGovernanceAction,
  voteGovernanceAction,
  withdrawRewardsAction,
  delegatePolygonAction,
  
  // New modular actions for blockchain data access
  getBlockNumberAction,
  getBlockDetailsAction,
  getTransactionDetailsAction,
  getNativeBalanceAction,
  getERC20BalanceAction,
  
  // Governance actions
  getGovernanceInfoAction,
  getVotingPowerAction,
  
  // Simple action for gas price estimates
  {
    name: 'GET_POLYGON_GAS_ESTIMATES',
    description: 'Gets current gas price estimates for Polygon from PolygonScan.',
    validate: async () => true,
    handler: async (runtime: IAgentRuntime) => {
      const estimates: GasPriceEstimates = await getGasPriceEstimates(runtime);
      let text = 'Polygon Gas Estimates (Wei):\n';
      
      // Format priority fee per gas using our formatter
      const safeLowPriority = estimates.safeLow?.maxPriorityFeePerGas
        ? formatUnits(estimates.safeLow.maxPriorityFeePerGas, 9) + ' Gwei'
        : 'N/A';
      
      const averagePriority = estimates.average?.maxPriorityFeePerGas
        ? formatUnits(estimates.average.maxPriorityFeePerGas, 9) + ' Gwei'
        : 'N/A';
      
      const fastPriority = estimates.fast?.maxPriorityFeePerGas
        ? formatUnits(estimates.fast.maxPriorityFeePerGas, 9) + ' Gwei'
        : 'N/A';
      
      const baseFee = estimates.estimatedBaseFee
        ? formatUnits(estimates.estimatedBaseFee, 9) + ' Gwei'
        : 'N/A';
      
      text += `  Safe Low Priority: ${safeLowPriority}\n`;
      text += `  Average Priority:  ${averagePriority}\n`;
      text += `  Fast Priority:     ${fastPriority}\n`;
      text += `  Estimated Base:    ${baseFee}`;
      
      if (estimates.fallbackGasPrice) {
        text += `\n  (Used Fallback Price: ${formatUnits(estimates.fallbackGasPrice, 9)} Gwei)`;
      }
      
      return { text, actions: ['GET_POLYGON_GAS_ESTIMATES'], data: estimates };
    },
    examples: [],
  }
];

/**
 * Polygon Plugin for ElizaOS
 * 
 * A plugin that provides integration with Polygon (MATIC) blockchain,
 * allowing users to interact with both Ethereum (L1) and Polygon (L2) networks.
 * 
 * Features include:
 * - Standard RPC operations on both L1 and L2
 * - Account and balance management
 * - Block and transaction information 
 * - Token interactions (MATIC and ERC20)
 * - Validator interactions (staking, delegation)
 * - Bridge operations between L1 and L2
 */
class PolygonPlugin implements Plugin {
  name = 'polygon';
  description = 'Polygon (MATIC) blockchain integration';
  capabilities = {
    polygonRpc: 'Access to Polygon and Ethereum JSON-RPC nodes',
  };
  config?: PolygonPluginConfig;
  
  /**
   * Initialize the Polygon plugin
   */
  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    try {
      // Add default RPC URLs if not provided
      const configWithDefaults = {
        ...config,
        POLYGON_RPC_URL: config.POLYGON_RPC_URL || DEFAULT_RPC_URLS.POLYGON_RPC_URL,
        ETHEREUM_RPC_URL: config.ETHEREUM_RPC_URL || DEFAULT_RPC_URLS.ETHEREUM_RPC_URL,
      };
      
      // Parse and validate config
      const parsedConfig = configSchema.safeParse(configWithDefaults);
      if (!parsedConfig.success) {
        const errorMessage = parsedConfig.error.issues
          .map((issue) => issue.message)
          .join(', ');
        throw new Error(`Invalid config: ${errorMessage}`);
      }
      
      // Set config if valid
      this.config = parsedConfig.data;
      logger.info('Polygon plugin initialized successfully');
      logger.debug(`Using Ethereum RPC: ${this.config.ETHEREUM_RPC_URL.substring(0, 20)}... and Polygon RPC: ${this.config.POLYGON_RPC_URL.substring(0, 20)}...`);
    } catch (error) {
      logger.error('Error initializing Polygon plugin:', error);
      throw error;
    }
  }
  
  getProviders(): Provider[] {
    return [];
  }
  
  getActions(): Action[] {
    return polygonActions;
  }
  
  getServices(): (typeof Service)[] {
    const polygonServices: (typeof Service)[] = [
      PolygonRpcService, 
      GovernanceService,
      PolygonBridgeService
    ];
    return polygonServices;
  }
}

export default PolygonPlugin;
