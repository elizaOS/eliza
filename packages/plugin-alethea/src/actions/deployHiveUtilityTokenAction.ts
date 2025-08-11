import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  composePromptFromState,
  ModelType,
  parseJSONObjectFromText,
} from '@elizaos/core';
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ContractFactory,
  formatUnits,
  parseUnits,
} from 'ethers';
import { deployHiveUtilityTokenTemplate } from '../templates';
import { WHITELABEL_ERC20_ABI } from '../abis';
import { WHITELABEL_ERC20_BYTECODE } from '../abis/WhitelabelERC20Bytecode';

interface DeployHiveUtilityTokenParams {
  hiveId: string;
  tokenName: string;
  tokenSymbol: string;
  initialSupply: string;
}

export const deployHiveUtilityTokenAction: Action = {
  name: 'ALETHEA_DEPLOY_HIVE_UTILITY_TOKEN',
  similes: [
    'CREATE_HIVE_TOKEN',
    'DEPLOY_TOKEN_FOR_HIVE',
    'CREATE_HIVE_UTILITY_TOKEN',
    'LAUNCH_HIVE_TOKEN',
    'DEPLOY_ERC20_FOR_HIVE',
  ].map((s) => `ALETHEA_${s}`),
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const requiredEnvVars = ['ALETHEA_RPC_URL', 'PRIVATE_KEY'];
    const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

    if (missingVars.length > 0) {
      logger.error(`Missing required environment variables: ${missingVars.join(', ')}`);
      return false;
    }
    return true;
  },
  description: 'Deploy a utility token for a Hive',
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      logger.info('Starting Hive utility token deployment...');

      // Extract parameters using LLM
      const context = composePromptFromState({
        state,
        template: deployHiveUtilityTokenTemplate,
      });
      const response = await runtime.useModel(ModelType.TEXT_SMALL, context);

      if (!response) {
        throw new Error('Failed to get response from LLM');
      }

      const params = parseJSONObjectFromText(response) as DeployHiveUtilityTokenParams;

      // Validate parameters
      if (!params.hiveId || !params.tokenName || !params.tokenSymbol || !params.initialSupply) {
        throw new Error('Missing required parameters for token deployment');
      }

      // Connect to blockchain
      const provider = new JsonRpcProvider(process.env.ALETHEA_RPC_URL);
      const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

      logger.info(`Deploying utility token for Hive: ${params.hiveId}`);
      logger.info(`Token Name: ${params.tokenName}`);
      logger.info(`Token Symbol: ${params.tokenSymbol}`);
      logger.info(`Initial Supply: ${params.initialSupply}`);

      // Create contract factory
      const factory = new ContractFactory(WHITELABEL_ERC20_ABI, WHITELABEL_ERC20_BYTECODE, wallet);

      // Deploy contract
      const initialSupplyWei = parseUnits(params.initialSupply, 18);
      const contract = await factory.deploy(
        params.tokenName,
        params.tokenSymbol,
        wallet.address, // Initial holder
        initialSupplyWei
      );

      await contract.waitForDeployment();
      const contractAddress = await contract.getAddress();

      logger.info(`Utility token deployed successfully at: ${contractAddress}`);

      // Get transaction hash
      const deployTx = contract.deploymentTransaction();
      const txHash = deployTx?.hash;

      const result = {
        success: true,
        contractAddress: contractAddress,
        transactionHash: txHash,
        hiveId: params.hiveId,
        tokenName: params.tokenName,
        tokenSymbol: params.tokenSymbol,
        initialSupply: params.initialSupply,
        message: `Successfully deployed ${params.tokenName} (${params.tokenSymbol}) utility token for Hive ${params.hiveId}`,
      };

      if (callback) {
        callback({
          text: result.message,
          content: result,
        });
      }

      return true;
    } catch (error) {
      logger.error('Error in deploy hive utility token action:', error);

      const errorResult = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to deploy Hive utility token',
      };

      if (callback) {
        callback({
          text: errorResult.message,
          content: errorResult,
        });
      }

      return false;
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Deploy a utility token for Hive 0x789ghi with name "Hive Utility Token" symbol "HUT" and 2000000 initial supply via Alethea',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll deploy a utility token for your Hive via Alethea. This will create an ERC-20 token that can be used for Hive operations and governance.",
          action: 'ALETHEA_DEPLOY_HIVE_UTILITY_TOKEN',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Create a token called "Community Token" with symbol "COM" for hive 0x999xyz, initial supply 1500000 via Alethea',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll create the Community Token (COM) for your Hive via Alethea. This token will enable various utilities and governance features within your Hive.",
          action: 'ALETHEA_DEPLOY_HIVE_UTILITY_TOKEN',
        },
      },
    ],
  ],
};
