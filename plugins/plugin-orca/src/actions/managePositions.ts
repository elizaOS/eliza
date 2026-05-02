import {
  actions,
  elizaLogger,
  composeContext,
  HandlerCallback,
  AgentRuntime,
  ModelTypes,
  Memory,
  parseJSONObjectFromText,
  settings,
  State,
} from '@elizaos/core';
import {
  Connection as SolanaRpc,
  Keypair as KeyPairSigner,
  Connection as Rpc,
  Connection as SolanaRpcApi,
  PublicKey,
  Connection,
} from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { fetchPosition, fetchWhirlpool, getPositionAddress } from '@orca-so/whirlpools-client';
import { sqrtPriceToPrice } from '@orca-so/whirlpools-core';
import { sendTransaction } from '../utils/sendTransaction';
import {
  closePositionInstructions,
  IncreaseLiquidityQuoteParam,
  openPositionInstructions,
  setDefaultFunder,
  setDefaultSlippageToleranceBps,
} from '@orca-so/whirlpools';
import { loadWallet } from '../utils/loadWallet';

interface FetchedPosition {
  whirlpoolAddress: string;
  positionMint: string;
  inRange: boolean;
  distanceCenterPositionFromPoolPriceBps: number;
  positionWidthBps: number;
}

interface NewPriceBounds {
  newLowerPrice: number;
  newUpperPrice: number;
}

interface ManagePositionsInput {
  repositionThresholdBps: number;
  intervalSeconds: number;
  slippageToleranceBps: number;
}

export const managePositions: typeof actions = {
  name: 'manage_positions',
  similes: ['AUTOMATE_REBALANCING', 'AUTOMATE_POSITIONS', 'START_MANAGING_POSITIONS'],
  description:
    'Automatically manage positions by rebalancing them when they drift too far from the pool price',

  validate: async (runtime: AgentRuntime, message: Memory): Promise<boolean> => {
    const config = await extractAndValidateConfiguration(message.content.text, runtime);
    if (!config) {
      elizaLogger.warn('Validation failed: No valid configuration provided.');
      return false;
    }
    return true;
  },

  handler: async (
    runtime: AgentRuntime,
    message: Memory,
    state: State,
    params: { [key: string]: unknown },
    callback?: HandlerCallback
  ) => {
    elizaLogger.log('Start managing positions');
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    } else {
      state = await runtime.updateRecentMessageState(state);
    }
    const { repositionThresholdBps, slippageToleranceBps }: ManagePositionsInput =
      await extractAndValidateConfiguration(message.content.text, runtime);
    const fetchedPositions = await extractFetchedPositions(state.providers, runtime);
    elizaLogger.log(
      `Validated configuration: repositionThresholdBps=${repositionThresholdBps}, slippageTolerance=${slippageToleranceBps}`
    );
    elizaLogger.log('Fetched positions:', fetchedPositions);

    const { signer: wallet } = await loadWallet(runtime, true);
    const rpc = createSolanaRpc(settings.SOLANA_RPC_URL!);
    setDefaultSlippageToleranceBps(slippageToleranceBps);
    setDefaultFunder(wallet);

    await handleRepositioning(fetchedPositions, repositionThresholdBps, rpc, wallet);

    return true;
  },
  examples: [],
};

async function extractFetchedPositions(
  text: string,
  runtime: AgentRuntime
): Promise<FetchedPosition[]> {
  const prompt = `Given this message: "${text}", extract the available data and return a JSON object with the following structure:
        [
            {
                "whirlpoolAddress": string,
                "positionMint": string,
                "inRange": boolean,
                "distanceCenterPositionFromPoolPriceBps": number,
                "positionWidthBps": number
            },
        ]
    `;

  const content = await composeContext({
    state: runtime.state,
    template: prompt,
    modelClass: ModelTypes.LARGE,
  });

  const fetchedPositions = parseJSONObjectFromText(content) as FetchedPosition[];
  return fetchedPositions;
}

function validateManagePositionsInput(obj: Record<string, any>): ManagePositionsInput {
  if (
    typeof obj.repositionThresholdBps !== 'number' ||
    !Number.isInteger(obj.repositionThresholdBps) ||
    typeof obj.intervalSeconds !== 'number' ||
    !Number.isInteger(obj.intervalSeconds) ||
    typeof obj.slippageToleranceBps !== 'number' ||
    !Number.isInteger(obj.slippageToleranceBps)
  ) {
    throw new Error('Invalid input: Object does not match the ManagePositionsInput type.');
  }
  return obj as ManagePositionsInput;
}

export async function extractAndValidateConfiguration(
  text: string,
  runtime: AgentRuntime
): Promise<ManagePositionsInput | null> {
  elizaLogger.log('Extracting and validating configuration from text:', text);

  const prompt = `Given this message: "${text}". Extract the reposition threshold value, time interval, and slippage tolerance.
        The threshold value and the slippage tolerance can be given in percentages or bps. You will always respond with the reposition threshold in bps.
        Very important: Add null values for each field that is not present in the message.
        Return the response as a JSON object with the following structure:
        {
            "repositionThresholdBps": number (integer value),
            "intervalSeconds": number (integer value),
            "slippageToleranceBps": number (integer value)
        }
    `;

  const content = await composeContext({
    state: runtime.state,
    template: prompt,
    modelClass: ModelTypes.SMALL,
  });

  try {
    const configuration = parseJSONObjectFromText(content);
    return validateManagePositionsInput(configuration);
  } catch (error) {
    elizaLogger.warn('Invalid configuration detected:', error);
    return null;
  }
}

function calculatePriceBounds(
  sqrtPrice: bigint,
  decimalsA: number,
  decimalsB: number,
  positionWidthBps: number
): NewPriceBounds {
  const currentPrice = sqrtPriceToPrice(sqrtPrice, decimalsA, decimalsB);
  const newLowerPrice = currentPrice * (1 - positionWidthBps / 10000);
  const newUpperPrice = currentPrice * (1 + positionWidthBps / 10000);

  return { newLowerPrice, newUpperPrice };
}

async function handleRepositioning(
  fetchedPositions: FetchedPosition[],
  repositionThresholdBps: number,
  rpc: Connection,
  wallet: KeyPairSigner
) {
  return await Promise.all(
    fetchedPositions.map(async (position) => {
      const { inRange, distanceCenterPositionFromPoolPriceBps } = position;
      if (!inRange || distanceCenterPositionFromPoolPriceBps > repositionThresholdBps) {
        const positionMintAddress = address(position.positionMint);
        const positionAddress = (await getPositionAddress(positionMintAddress))[0];
        let positionData = await fetchPosition(rpc, positionAddress);
        const whirlpoolAddress = positionData.data.whirlpool;
        let whirlpool = await fetchWhirlpool(rpc, whirlpoolAddress);
        const mintA = await getMint(rpc, whirlpool.data.tokenMintA);
        const mintB = await getMint(rpc, whirlpool.data.tokenMintB);
        const newPriceBounds: NewPriceBounds = calculatePriceBounds(
          whirlpool.data.sqrtPrice,
          mintA.decimals,
          mintB.decimals,
          position.positionWidthBps
        );
        let newLowerPrice = newPriceBounds.newLowerPrice;
        let newUpperPrice = newPriceBounds.newUpperPrice;

        elizaLogger.log(`Repositioning position: ${positionMintAddress}`);

        let closeSuccess = false;
        let closeTxId;
        while (!closeSuccess) {
          try {
            const { instructions: closeInstructions, quote } = await closePositionInstructions(
              rpc,
              positionMintAddress
            );
            closeTxId = await sendTransaction(rpc, closeInstructions, wallet);
            closeSuccess = closeTxId ? true : false;

            // Prepare for open position
            const increaseLiquidityQuoteParam: IncreaseLiquidityQuoteParam = {
              liquidity: quote.liquidityDelta,
            };
            whirlpool = await fetchWhirlpool(rpc, whirlpoolAddress);
            const newPriceBounds: NewPriceBounds = calculatePriceBounds(
              whirlpool.data.sqrtPrice,
              mintA.decimals,
              mintB.decimals,
              position.positionWidthBps
            );
            newLowerPrice = newPriceBounds.newLowerPrice;
            newUpperPrice = newPriceBounds.newUpperPrice;
            let openSuccess = false;
            let openTxId;
            while (!openSuccess) {
              try {
                const { instructions: openInstructions, positionMint: newPositionMint } =
                  await openPositionInstructions(
                    rpc,
                    whirlpoolAddress,
                    increaseLiquidityQuoteParam,
                    newLowerPrice,
                    newUpperPrice
                  );
                openTxId = await sendTransaction(rpc, openInstructions, wallet);
                openSuccess = openTxId ? true : false;

                elizaLogger.log(`Successfully reopened position with mint: ${newPositionMint}`);
                return { positionMintAddress, closeTxId, openTxId };
              } catch (openError) {
                elizaLogger.warn(
                  `Open position failed for ${positionMintAddress}, retrying. Error: ${openError}`
                );
                whirlpool = await fetchWhirlpool(rpc, whirlpoolAddress);
                const newPriceBounds: NewPriceBounds = calculatePriceBounds(
                  whirlpool.data.sqrtPrice,
                  mintA.decimals,
                  mintB.decimals,
                  position.positionWidthBps
                );
                newLowerPrice = newPriceBounds.newLowerPrice;
                newUpperPrice = newPriceBounds.newUpperPrice;
              }
            }
          } catch (closeError) {
            elizaLogger.warn(
              `Close position failed for ${positionMintAddress}, retrying after fetching new prices. Error: ${closeError}`
            );
            whirlpool = await fetchWhirlpool(rpc, whirlpoolAddress);
            const newPriceBounds: NewPriceBounds = calculatePriceBounds(
              whirlpool.data.sqrtPrice,
              mintA.decimals,
              mintB.decimals,
              position.positionWidthBps
            );
            newLowerPrice = newPriceBounds.newLowerPrice;
            newUpperPrice = newPriceBounds.newUpperPrice;
          }
        }
      } else {
        elizaLogger.log(`Position ${address(position.positionMint)} is in range, skipping.`);
        return null;
      }
    })
  );
}

const createSolanaRpc = (url: string) => new SolanaRpc(url);

const address = (addressString: string) => new PublicKey(addressString);
