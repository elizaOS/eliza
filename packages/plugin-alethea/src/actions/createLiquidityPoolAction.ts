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
import { Contract, JsonRpcProvider, Wallet, MaxUint256, formatUnits, parseUnits } from 'ethers';
import { createLiquidityPoolTemplate } from '../templates';
import {
  UNISWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POSITION_MANAGER_ABI,
  UNISWAP_V3_POOL_ABI,
  ALI_TOKEN_ERC20_ABI,
} from '../abis';
import { UNISWAP_V3_ADDRESSES, UNISWAP_V3_FEE_TIERS } from '../constants';

interface CreateLiquidityPoolParams {
  tokenA: string;
  tokenB: string;
  amountA: string;
  amountB: string;
  feeTier?: number;
}

export const createLiquidityPoolAction: Action = {
  name: 'ALETHEA_CREATE_LIQUIDITY_POOL',
  similes: ['CREATE_POOL', 'ADD_LIQUIDITY', 'SETUP_LIQUIDITY_POOL', 'BOOTSTRAP_LIQUIDITY'].map(
    (s) => `ALETHEA_${s}`
  ),
  description: "Create a liquidity pool for a Hive's utility token on Uniswap V3.",
  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[createLiquidityPoolAction] Handler called.');
    let params: CreateLiquidityPoolParams | undefined;

    try {
      const prompt = composePromptFromState({
        state,
        template: createLiquidityPoolTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsed = parseJSONObjectFromText(modelResponse);

      if (typeof parsed !== 'object' || parsed === null) {
        logger.error(
          `[createLiquidityPoolAction] Failed to parse model response: ${modelResponse}`
        );
        throw new Error('Could not parse parameters from model response.');
      }

      const paramsJson = parsed as CreateLiquidityPoolParams | { error: string };

      if ('error' in paramsJson) {
        logger.warn(`[createLiquidityPoolAction] Model responded with error: ${paramsJson.error}`);
        throw new Error(paramsJson.error);
      }
      params = paramsJson;

      let { tokenA, tokenB, amountA, amountB } = params;
      let { feeTier } = params;

      // Resolve common token symbols to their addresses on the Base network
      const tokenSymbolMap: { [key: string]: string } = {
        WETH: UNISWAP_V3_ADDRESSES.WETH,
        USDC: UNISWAP_V3_ADDRESSES.USDC,
      };

      const upperCaseTokenB = tokenB.toUpperCase();
      if (tokenSymbolMap[upperCaseTokenB]) {
        logger.info(
          `[createLiquidityPoolAction] Resolving token symbol "${tokenB}" to address ${tokenSymbolMap[upperCaseTokenB]}`
        );
        tokenB = tokenSymbolMap[upperCaseTokenB];
      }

      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');
      const privateKey = runtime.getSetting('PRIVATE_KEY');

      // Validation
      if (!tokenA || !tokenB || !amountA || !amountB) {
        throw new Error('TokenA, tokenB, amountA, and amountB are all required.');
      }
      if (!rpcUrl || !privateKey) {
        throw new Error('ALETHEA_RPC_URL and PRIVATE_KEY are required in agent settings.');
      }

      // Default fee tier if not provided or invalid
      if (!feeTier || typeof feeTier !== 'number') {
        feeTier = UNISWAP_V3_FEE_TIERS.MEDIUM; // 0.3%
        logger.info(
          `[createLiquidityPoolAction] No valid fee tier provided. Using default fee tier: ${feeTier}`
        );
      }

      // Validate addresses
      if (!tokenA.startsWith('0x') || tokenA.length !== 42) {
        throw new Error(`Invalid tokenA address: ${tokenA}`);
      }
      if (!tokenB.startsWith('0x') || tokenB.length !== 42) {
        throw new Error(`Invalid tokenB address: ${tokenB}`);
      }

      // Convert amounts to wei
      const amountAInWei = parseUnits(amountA, 18); // Assuming 18 decimals for tokenA
      const amountBInWei = parseUnits(amountB, 18); // Assuming 18 decimals for tokenB

      if (amountAInWei <= 0n || amountBInWei <= 0n) {
        throw new Error('Token amounts must be positive.');
      }

      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const walletAddress = await wallet.getAddress();

      const factoryContract = new Contract(
        UNISWAP_V3_ADDRESSES.FACTORY,
        UNISWAP_V3_FACTORY_ABI,
        wallet
      );
      const positionManagerContract = new Contract(
        UNISWAP_V3_ADDRESSES.POSITION_MANAGER,
        UNISWAP_V3_POSITION_MANAGER_ABI,
        wallet
      );
      const tokenAContract = new Contract(tokenA, ALI_TOKEN_ERC20_ABI, wallet);
      const tokenBContract = new Contract(tokenB, ALI_TOKEN_ERC20_ABI, wallet);

      logger.info(
        `[createLiquidityPoolAction] Creating liquidity pool for ${tokenA} / ${tokenB} with fee tier ${feeTier}...`
      );

      // Check if pool already exists
      let poolAddress: string;
      try {
        poolAddress = await factoryContract.getPool(tokenA, tokenB, feeTier);
        if (poolAddress !== '0x0000000000000000000000000000000000000000') {
          logger.info(`[createLiquidityPoolAction] Pool already exists at: ${poolAddress}`);
        } else {
          // Create new pool
          logger.info(`[createLiquidityPoolAction] Pool does not exist. Creating new pool...`);
          const createPoolTx = await factoryContract.createPool(tokenA, tokenB, feeTier);
          logger.info(
            `[createLiquidityPoolAction] Pool creation transaction submitted: ${createPoolTx.hash}`
          );
          const createPoolReceipt = await createPoolTx.wait();

          if (!createPoolReceipt || createPoolReceipt.status !== 1) {
            throw new Error(`Pool creation failed. Hash: ${createPoolTx.hash}`);
          }

          // Get the newly created pool address
          poolAddress = await factoryContract.getPool(tokenA, tokenB, feeTier);
          logger.info(`[createLiquidityPoolAction] New pool created at: ${poolAddress}`);
        }
      } catch (error) {
        throw new Error(
          `Failed to check or create pool: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }

      // Initialize pool if needed (set initial price)
      const poolContract = new Contract(poolAddress, UNISWAP_V3_POOL_ABI, wallet);
      try {
        const slot0 = await poolContract.slot0();
        if (slot0.sqrtPriceX96 === 0n) {
          // Pool needs initialization - calculate sqrtPriceX96 based on amounts
          // This is a simplified calculation - in production, you'd want more sophisticated pricing
          const sqrtPriceX96 = BigInt(
            Math.floor(Math.sqrt(Number(amountBInWei) / Number(amountAInWei)) * 2 ** 96)
          );
          logger.info(
            `[createLiquidityPoolAction] Initializing pool with sqrtPriceX96: ${sqrtPriceX96}`
          );
          const initTx = await poolContract.initialize(sqrtPriceX96);
          await initTx.wait();
        }
      } catch (error) {
        logger.warn(
          `[createLiquidityPoolAction] Pool initialization error (may already be initialized): ${error}`
        );
      }

      // Check token balances
      const balanceA = await tokenAContract.balanceOf(walletAddress);
      const balanceB = await tokenBContract.balanceOf(walletAddress);

      if (balanceA < amountAInWei) {
        throw new Error(
          `Insufficient tokenA balance. Required: ${formatUnits(amountAInWei, 18)}, Available: ${formatUnits(balanceA, 18)}`
        );
      }
      if (balanceB < amountBInWei) {
        throw new Error(
          `Insufficient tokenB balance. Required: ${formatUnits(amountBInWei, 18)}, Available: ${formatUnits(balanceB, 18)}`
        );
      }

      // Approve tokens for position manager
      logger.info(`[createLiquidityPoolAction] Approving tokens for position manager...`);

      const allowanceA = await tokenAContract.allowance(
        walletAddress,
        UNISWAP_V3_ADDRESSES.POSITION_MANAGER
      );
      if (allowanceA < amountAInWei) {
        const approveATx = await tokenAContract.approve(
          UNISWAP_V3_ADDRESSES.POSITION_MANAGER,
          MaxUint256
        );
        await approveATx.wait();
        logger.info(`[createLiquidityPoolAction] TokenA approved.`);
      }

      const allowanceB = await tokenBContract.allowance(
        walletAddress,
        UNISWAP_V3_ADDRESSES.POSITION_MANAGER
      );
      if (allowanceB < amountBInWei) {
        const approveBTx = await tokenBContract.approve(
          UNISWAP_V3_ADDRESSES.POSITION_MANAGER,
          MaxUint256
        );
        await approveBTx.wait();
        logger.info(`[createLiquidityPoolAction] TokenB approved.`);
      }

      // Sort tokens (Uniswap requires token0 < token1)
      const [token0, token1] =
        tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
      const [amount0, amount1] =
        tokenA.toLowerCase() < tokenB.toLowerCase()
          ? [amountAInWei, amountBInWei]
          : [amountBInWei, amountAInWei];

      // Add liquidity
      logger.info(`[createLiquidityPoolAction] Adding liquidity to the pool...`);
      const mintParams = {
        token0: token0,
        token1: token1,
        fee: feeTier,
        tickLower: -887272, // Full range position (minimum tick)
        tickUpper: 887272, // Full range position (maximum tick)
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: (amount0 * 95n) / 100n, // 5% slippage tolerance
        amount1Min: (amount1 * 95n) / 100n, // 5% slippage tolerance
        recipient: walletAddress,
        deadline: Math.floor(Date.now() / 1000) + 300, // 5 minutes from now
      };

      const mintTx = await positionManagerContract.mint(mintParams);
      logger.info(
        `[createLiquidityPoolAction] Liquidity addition transaction submitted: ${mintTx.hash}`
      );
      const mintReceipt = await mintTx.wait();

      if (!mintReceipt || mintReceipt.status !== 1) {
        throw new Error(`Liquidity addition failed. Hash: ${mintTx.hash}`);
      }
      logger.info(`[createLiquidityPoolAction] Liquidity addition confirmed.`);

      const responseText =
        `✅ **Successfully Created Liquidity Pool**\n\n` +
        `**Pool Address:** ${poolAddress}\n` +
        `**Token A:** ${tokenA}\n` +
        `**Token B:** ${tokenB}\n` +
        `**Amount A:** ${formatUnits(amountAInWei, 18)}\n` +
        `**Amount B:** ${formatUnits(amountBInWei, 18)}\n` +
        `**Fee Tier:** ${feeTier / 10000}%\n` +
        `**Transaction Hash:** ${mintTx.hash}\n\n` +
        `🔗 **View Transaction:** https://basescan.org/tx/${mintTx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          poolAddress,
          tokenA,
          tokenB,
          amountA: amountAInWei.toString(),
          amountB: amountBInWei.toString(),
          amountAFormatted: formatUnits(amountAInWei, 18),
          amountBFormatted: formatUnits(amountBInWei, 18),
          feeTier,
          txHash: mintTx.hash,
          blockNumber: mintReceipt.blockNumber,
          gasUsed: mintReceipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[createLiquidityPoolAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during liquidity pool creation.';
      const errorContent: Content = {
        text: `❌ **Error creating liquidity pool**: ${errorMessage}`,
        data: {
          error: errorMessage,
          tokenA: params?.tokenA,
          tokenB: params?.tokenB,
          amountA: params?.amountA,
          amountB: params?.amountB,
          feeTier: params?.feeTier,
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: "Create a liquidity pool on Uniswap V3 for my Hive's token 0xTokenA with 1000 tokens, and WETH with 1 WETH via Alethea. Use the medium fee tier.",
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, creating a new Uniswap V3 liquidity pool for 0xTokenA and WETH via Alethea. I will add 1000 of your token and 1 WETH to the pool with a 0.3% fee tier.',
          actions: ['ALETHEA_CREATE_LIQUIDITY_POOL'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Bootstrap liquidity for my new token 0xNewToken against 500 USDC via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Understood. I am setting up a new liquidity pool for 0xNewToken and USDC via Alethea, using a default fee tier. Please specify amounts for both tokens.',
          // Note: This example intentionally omits the action call to show a conversational follow-up
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'I need to create a liquidity pool for my token 0xMyToken and USDC, with 10000 of my token and 1000 USDC via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'I will create a liquidity pool for 0xMyToken and USDC with 10000 and 1000 tokens respectively, via Alethea.',
          actions: ['ALETHEA_CREATE_LIQUIDITY_POOL'],
        },
      },
    ],
  ],
};
