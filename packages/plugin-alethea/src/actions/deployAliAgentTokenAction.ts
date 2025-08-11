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
  type TemplateType,
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
import { deployAliAgentTokenTemplate } from '../templates';
import { WHITELABEL_ERC20_ABI } from '../abis';
import { WHITELABEL_ERC20_BYTECODE } from '../abis/WhitelabelERC20Bytecode';

interface DeployAliAgentTokenParams {
  agentId: string;
  tokenName: string;
  tokenSymbol: string;
  initialSupply: string;
}

export const deployAliAgentTokenAction: Action = {
  name: 'ALETHEA_DEPLOY_ALI_AGENT_TOKEN',
  similes: [
    'CREATE_ALI_AGENT_TOKEN',
    'DEPLOY_TOKEN_FOR_ALI_AGENT',
    'CREATE_UTILITY_TOKEN',
    'LAUNCH_ALI_AGENT_TOKEN',
    'DEPLOY_ERC20_FOR_AGENT',
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
  description: 'Deploy a utility token for an ALI Agent',
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      logger.info('Starting ALI Agent token deployment...');

      // Extract parameters using LLM
      const prompt = composePromptFromState({
        state,
        template: deployAliAgentTokenTemplate,
      });
      const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });

      if (!response) {
        throw new Error('Failed to get response from LLM');
      }

      const params = parseJSONObjectFromText(response) as DeployAliAgentTokenParams;

      // Validate parameters
      if (!params.agentId || !params.tokenName || !params.tokenSymbol || !params.initialSupply) {
        throw new Error('Missing required parameters for token deployment');
      }

      // Connect to blockchain
      const provider = new JsonRpcProvider(process.env.ALETHEA_RPC_URL);
      const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

      const balance = await provider.getBalance(wallet.address);
      logger.info(`Deployer wallet address: ${wallet.address}`);
      logger.info(`Deployer wallet balance: ${formatUnits(balance, 18)} ETH`);

      // Check network to ensure it's Base Network
      const network = await provider.getNetwork();
      logger.info(`Connected to network: ${network.name}, chainId: ${network.chainId}`);

      // Base Network chainId is 8453
      if (network.chainId !== 8453n) {
        logger.warn(
          `Warning: Expected Base Network (chainId: 8453), but connected to chainId: ${network.chainId}`
        );
      }

      if (balance === 0n) {
        const message =
          'The deployer wallet has no balance to pay for gas fees. Please add funds to the wallet.';
        logger.error(message);
        if (callback) {
          callback({ text: message, content: { success: false, error: message } });
        }
        return false;
      }

      logger.info(`Deploying token for ALI Agent: ${params.agentId}`);
      logger.info(`Token Name: ${params.tokenName}`);
      logger.info(`Token Symbol: ${params.tokenSymbol}`);
      logger.info(`Initial Supply: ${params.initialSupply}`);

      // Convert the initial supply to wei
      const initialSupplyWei = parseUnits(params.initialSupply, 18);

      // Create contract factory with ABI and bytecode
      const factory = new ContractFactory(WHITELABEL_ERC20_ABI, WHITELABEL_ERC20_BYTECODE, wallet);

      // Deploy contract with constructor arguments
      const contract = await factory.deploy(
        params.tokenName,
        params.tokenSymbol,
        wallet.address, // Initial holder
        initialSupplyWei
      );

      await contract.waitForDeployment();
      const contractAddress = await contract.getAddress();

      logger.info(`Token deployed successfully at: ${contractAddress}`);

      logger.info('Enabling token features by calling updateFeatures(65535)...');
      const updateTx = await (contract as any).updateFeatures(65535);
      await updateTx.wait();
      logger.info('Token features enabled successfully.');

      // Get transaction hash
      const deployTx = contract.deploymentTransaction();
      const txHash = deployTx?.hash;

      const result = {
        success: true,
        contractAddress: contractAddress,
        transactionHash: txHash,
        agentId: params.agentId,
        tokenName: params.tokenName,
        tokenSymbol: params.tokenSymbol,
        initialSupply: params.initialSupply,
        message: `Successfully deployed ${params.tokenName} (${params.tokenSymbol}) token for ALI Agent ${params.agentId}`,
      };

      if (callback) {
        callback({
          text: result.message,
          content: result,
        });
      }

      return true;
    } catch (error) {
      logger.error('Error in deploy ALI agent token action:', error);

      const errorResult = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to deploy ALI Agent token',
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
          text: 'Deploy a utility token for ALI Agent 0x123abc with name "MyAgent Token" symbol "MAT" and 1000000 initial supply via Alethea',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll deploy a utility token for your ALI Agent via Alethea. This will create an ERC-20 token that can be used within the Alethea ecosystem.",
          action: 'ALETHEA_DEPLOY_ALI_AGENT_TOKEN',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Create a token called "Dragon Token" with symbol "DRG" for agent 0x456def, initial supply 500000 via Alethea',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll create the Dragon Token (DRG) for your ALI Agent via Alethea. This token can be used for various utilities within the Alethea ecosystem.",
          action: 'ALETHEA_DEPLOY_ALI_AGENT_TOKEN',
        },
      },
    ],
  ],
};
