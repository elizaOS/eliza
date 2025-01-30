import * as _ from "lodash";
import { BigNumber } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import { JsonRpcProvider, StaticJsonRpcProvider } from "@ethersproject/providers";
import { Interface } from "@ethersproject/abi";
import { formatEther, parseEther } from "@ethersproject/units";
import { isAddress } from "@ethersproject/address";
import { ethers } from "ethers";
import { UNISWAP_PAIR_ABI, UNISWAP_QUERY_ABI, UNISWAP_FACTORY_ABI, WETH_ABI} from "././abi";
import { FACTORY_ADDRESSES, UNISWAP_LOOKUP_CONTRACT_ADDRESS } from "./addresses";
import { CallDetails, MultipleCallData, TokenBalances } from "./EthMarket";
import { ETHER } from "./utils";
import { MarketType } from '../type';
import { EthMarket, CrossedMarketDetails, MarketsByToken, BuyCalls } from "./types";
require('dotenv').config();
import pLimit from 'p-limit';

const DEFAULT_WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL;
//const factoryAddress = UNISWAP_FACTORY_ADDRESS;

const WETH_ADDRESS = process.env.WETH_ADDRESS || DEFAULT_WETH_ADDRESS;

// batch count limit helpful for testing, loading entire set of uniswap markets takes a long time to load
const BATCH_COUNT_LIMIT = 100;
const UNISWAP_BATCH_SIZE = 1000;
const provider = new StaticJsonRpcProvider(ETHEREUM_RPC_URL);

// Not necessary, slightly speeds up loading initialization when we know tokens are bad
// Estimate gas will ensure we aren't submitting bad bundles, but bad tokens waste time
const blacklistTokens = [
  '0xD75EA151a61d06868E31F8988D28DFE5E9df57B4',
  //'0x06AF07097C9Eeb7fD685c692751D5C66dB49c215'
]

export interface ImpactAndFeeFuncs {
  getPriceImpact: (tokenAddress: string, tradeSize: BigNumber, reserve: BigNumber) => Promise<BigNumber>;
  getTradingFee: (tokenAddress: string) => Promise<BigNumber>;
}

export interface GroupedMarkets {
  marketsByToken: MarketsByToken;
  allMarketPairs: Array<UniswapV2EthPair>;
  getPriceImpact(tokenAddress: string, tradeSize: BigNumber): Promise<BigNumber>;
  getTradingFee(tokenAddress: string): Promise<BigNumber>;
}

export class UniswapV2EthPair implements EthMarket, MarketType {
  static filteredPairs: any;
  private static limit = pLimit(75); // Limit concurrent operations to 100
  private static BATCH_SIZE = 500; // Smaller batch size for better management
  tokens: any;
  _tokens: string[]; // Add this line
  tokenAddress: string; // Add this line
  protocol: string;
  provider: StaticJsonRpcProvider;
  static buyFromMarket(_buyFromMarket: any, _sellToMarket: EthMarket, _tokenAddress: string, _profit: number) {
    throw new Error("Method not implemented.");
  }
  static impactAndFeeFuncs(provider: StaticJsonRpcProvider, FACTORY_ADDRESSES: string[], impactAndFeeFuncs: any) {
    throw new Error("Method not implemented.");
  }
  static updateReservesFromResults(pairs: Array<UniswapV2EthPair>, results: Array<any>): void {
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const result = results[i];
      // Assuming result is an array of BigNumber representing reserves
      pair.setReservesViaOrderedBalances(result);
    }
  }
  reserve: BigNumber;
  async getTradingFee(): Promise<BigNumber> {
    // Uniswap V2 has a fixed trading fee of 0.3% (30 basis points)
    const tradingFee: BigNumber = BigNumber.from(30).div(10000);
    return tradingFee;
  }
  static uniswapInterface = new Contract(WETH_ADDRESS, UNISWAP_PAIR_ABI);
  private _tokenBalances: TokenBalances;

  constructor(marketAddress: string, tokens: Array<string>, protocol: string, tokenAddress: string, provider: StaticJsonRpcProvider) {
    this.marketAddress = marketAddress;
    this._tokens = tokens;
    this.protocol = protocol;
    this.tokenAddress = tokenAddress;
    this.reserve = BigNumber.from(0); // Initialize reserve in the constructor
    const initialBalances = tokens.map(() => BigNumber.from(0));
    this._tokenBalances = _.zipObject(tokens, initialBalances);
    this.provider = provider;
}
  marketAddress: string;

  private static async exponentialBackoff(attempt: number): Promise<void> {
    const delay = Math.min(Math.pow(2, attempt) * 1000, 10000); // Cap at 10 seconds
    await new Promise(resolve => setTimeout(resolve, delay));
  }
async getPriceImpact(tokenAddress: string, tradeSize: BigNumber): Promise<BigNumber> {
    const reserve = await this.getReserves(tokenAddress);
    const impact = tradeSize.mul(BigNumber.from(10000)).div(reserve.add(tradeSize));
    return impact; // Returns price impact as a basis point value (1/100 of a percent)
}
async getReserves(tokenAddress: string): Promise<BigNumber> {
  const pairContract = new Contract(this.marketAddress, UNISWAP_PAIR_ABI, provider);
  const [reserve0, reserve1] = await pairContract.getReserves();
  // Normalize addresses to lowercase for comparison
  const normalizedTokenAddress = tokenAddress.toLowerCase();
  const normalizedTokens = this._tokens.map(token => token.toLowerCase());
  return normalizedTokenAddress === normalizedTokens[0] ? reserve0 : reserve1;
}
  receiveDirectly(tokenAddress: string): boolean {
    return tokenAddress in this._tokenBalances;
  }

  async prepareReceive(tokenAddress: string, amountIn: BigNumber): Promise<Array<CallDetails>> {
    if (this._tokenBalances[tokenAddress] === undefined) {
      throw new Error(`Market does not operate on token ${tokenAddress}`)
    }
    if (! amountIn.gt(0)) {
      throw new Error(`Invalid amount: ${amountIn.toString()}`)
    }
    // No preparation necessary
    return []
  }
  // Example: Advanced error handling and potential gas optimization placeholder

  static async fetchWETHBalance(
    provider: StaticJsonRpcProvider,
    marketAddress: string,
    WETH_ADDRESS: string
  ): Promise<BigNumber> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const wethContract = new Contract(WETH_ADDRESS, WETH_ABI, provider);
        const balance = await wethContract.balanceOf(marketAddress);
        return BigNumber.from(balance);
      } catch (error: any) {
        if (attempt === 2) {
          console.error(
            `Failed to fetch WETH balance for address ${marketAddress}`,
            error.message
          );
          return BigNumber.from(0);
        }
        await this.exponentialBackoff(attempt);
      }
    }
    return BigNumber.from(0); // Typescript requires a return here even though it won't be reached
  }

  static ImpactAndFeeFuncs: ImpactAndFeeFuncs = {
    getPriceImpact: async (tokenAddress: string, tradeSize: BigNumber, reserve: BigNumber) => {
      if (!reserve || reserve.isZero()) {
        throw new Error("Reserve is zero");
      }
      const impact = tradeSize.mul(BigNumber.from(10000)).div(reserve.add(tradeSize));
      return impact; // Returns price impact as a basis point value (1/100 of a percent)
    },
    getTradingFee: async (tokenAddress: string): Promise<BigNumber> => {
      // compute trading fee here
      const tradingFee: BigNumber = BigNumber.from(30).div(10000);
      return tradingFee; // don't convert BigNumber to number, keep it as BigNumber
    },
  };
  static async getUniswapMarkets(provider: StaticJsonRpcProvider, factoryAddress: string): Promise<Array<UniswapV2EthPair>> {
    // Setup the contract to query Uniswap market pairs
    const uniswapQuery = new Contract(UNISWAP_LOOKUP_CONTRACT_ADDRESS, UNISWAP_QUERY_ABI, provider);

    // Initialize an array to hold the market pairs
    const marketPairs: UniswapV2EthPair[] = [];

    // Calculate the total number of batches to process based on the batch limit and size
    const allPairsLength = await new Contract(factoryAddress, UNISWAP_FACTORY_ABI, provider).allPairsLength();
    const totalBatches = Math.ceil(allPairsLength.toNumber() / UNISWAP_BATCH_SIZE);

    // Iterate over all pairs in batches, with consideration for the batch count limit
    for (let batch = 0; batch < Math.min(totalBatches, BATCH_COUNT_LIMIT); batch++) {
      const startIndex = batch * UNISWAP_BATCH_SIZE;
      const endIndex = Math.min(startIndex + UNISWAP_BATCH_SIZE, allPairsLength.toNumber());

      const batchPairs = await uniswapQuery.functions.getPairsByIndexRange(factoryAddress, startIndex, endIndex);
      // Validate the response format
      if (Array.isArray(batchPairs) && batchPairs.length > 0 && Array.isArray(batchPairs[0])) {
        batchPairs[0].forEach(pairArray => { // Adjusted to access the first element of batchPairs, which is the actual array of pairs
          if(Array.isArray(pairArray) && pairArray.length === 3) {
            const [token0, token1, pairAddress] = pairArray;

            //console.log(`Processing pair: Token0: ${token0}, Token1: ${token1}, PairAddress: ${pairAddress}`);

            // Validate each address individually
            if (!isAddress(token0) || !isAddress(token1) || !isAddress(pairAddress)) {
                console.error(`Invalid address detected. Token0: ${token0}, Token1: ${token1}, PairAddress: ${pairAddress}`);
                return;
            }
            // Exclude pairs involving blacklisted tokens
            if (!blacklistTokens.includes(token0) && !blacklistTokens.includes(token1)) {
                // Process valid pairs here
                const marketPair = new UniswapV2EthPair(pairAddress, [token0, token1], 'UniswapV2', token0, provider); // Example processing
                marketPairs.push(marketPair);
            } else {
                //console.log(`Skipping blacklisted pair. Token0: ${token0}, Token1: ${token1}`);
            }
          } else {
            // Handle unexpected format
            console.error('Unexpected pair data format:', pairArray);
          }
        });
      } else {
        throw new Error("Expected an array of pairs data");
      }

      // Break the loop if the last batch was smaller than the UNISWAP_BATCH_SIZE, indicating we've processed all available pairs
      if (batchPairs[0].length < UNISWAP_BATCH_SIZE) break;
    }

    // Return the array containing all the market pairs that were processed
    return marketPairs;
}

static async getUniswapMarketsByToken(
    provider: StaticJsonRpcProvider,
    factoryAddresses: string[],
    impactAndFeeFuncs: any,
    progressCallback?: (progress: number) => void
): Promise<{
    marketsByToken: { [token: string]: UniswapV2EthPair[] };
    allMarketPairs: UniswapV2EthPair[];
    getPriceImpact: (tokenAddress: string, tradeSize: BigNumber) => Promise<BigNumber>;
    getTradingFee: (tokenAddress: string) => Promise<BigNumber>;
}> {
    try {
        // Fetch all pairs from factory addresses
        const allPairs = await Promise.all(
            factoryAddresses.map(factoryAddress => UniswapV2EthPair.getUniswapMarkets(provider, factoryAddress))
        );
        const allPairsFlat: UniswapV2EthPair[] = _.flatten(allPairs);

        // Update reserves for all pairs
        await UniswapV2EthPair.updateReserves(provider, allPairsFlat, WETH_ADDRESS);

        // Validate and filter pairs based on WETH balance
        const allPairsWithBalance = await Promise.all(
          allPairsFlat.map(async (pair: UniswapV2EthPair) => {
            try {
              // Now we're calling getBalance on the instance (pair), not the class
              const balance = await pair.getBalance(WETH_ADDRESS);
              return balance.gt(ETHER) ? pair : null;
            } catch (error: any) {
              return null;
            }
          })
        );


        // Only retain valid pairs
        const filteredPairs: UniswapV2EthPair[] = allPairsWithBalance.filter(pair => pair !== null) as UniswapV2EthPair[];

        // Grouping markets by token
        const marketsByToken = _.groupBy(filteredPairs, pair =>
            pair._tokens[0] === WETH_ADDRESS ? pair._tokens[1] : pair._tokens[0]
        ) as { [token: string]: UniswapV2EthPair[] };

        // Logging market information
        console.log(`Grouped markets by token:`, marketsByToken);
        console.log(`Filtered pairs count:`, filteredPairs.length);

        // Add progress reporting
        let processedPairs = 0;
        const totalPairs = filteredPairs.length;

        // During processing
        processedPairs++;
        if (progressCallback) {
            progressCallback(processedPairs / totalPairs);
        }

        // Return structured market data along with impact and fee calculation methods
        return {
            marketsByToken,
            allMarketPairs: filteredPairs,
            getPriceImpact: async (tokenAddress: string, tradeSize: BigNumber) => {
                const pair = filteredPairs.find(pair => pair._tokens.includes(tokenAddress));
                if (!pair) {
                    throw new Error(`No pair found for token ${tokenAddress}`);
                }
                const reserve = await pair.getReserves(tokenAddress);
                return impactAndFeeFuncs.getPriceImpact(tokenAddress, tradeSize, reserve);
            },
            getTradingFee: impactAndFeeFuncs.getTradingFee,
        };
    } catch (error: any) {
        // Handling unexpected failures
        console.error('Error details:', error.message, error.stack);
        console.error('An error occurred while getting Uniswap Markets By Token:', error);
        // Fallback return structure in case of failure
        return {
            marketsByToken: {},
            allMarketPairs: [],
            getPriceImpact: async () => { throw new Error("Not implemented"); },
            getTradingFee: () => { throw new Error("Not implemented"); },
        };
    }
}
static async updateReserves(provider: StaticJsonRpcProvider, pairsInArbitrage: UniswapV2EthPair[], WETH_ADDRESS: string) {
  console.log(`Updating reserves for ${pairsInArbitrage.length} markets`);
  let filteredPairsInArbitrage = [];

  // Process in smaller batches
  for (let i = 0; i < pairsInArbitrage.length; i += this.BATCH_SIZE) {
    const batchPairs = pairsInArbitrage.slice(i, i + this.BATCH_SIZE);

    // Add delay between batches
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const promises = batchPairs.map(marketPair =>
      this.limit(async () => {
        try {
          const pairContract = new Contract(
            marketPair.marketAddress,
            UNISWAP_PAIR_ABI,
            provider
          );

          // Retry logic now using exponentialBackoff
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const [reserve0, reserve1] = await pairContract.getReserves();
              const totalReserves = reserve0.add(reserve1);
              const totalReservesInEth = formatEther(totalReserves);

              if (parseFloat(totalReservesInEth) < 3) {
                return null;
              }

              const wethBalance = await this.limit(async () =>
                this.fetchWETHBalance(provider, marketPair.marketAddress, WETH_ADDRESS)
              );

              if (!wethBalance.isZero()) {
                await marketPair.setReservesViaOrderedBalances([wethBalance]);
                return marketPair;
              }
              return null;
            } catch (error) {
              if (attempt === 2) throw error;
              await this.exponentialBackoff(attempt); // Using the helper method here
            }
          }
        } catch (error) {
          console.error(
            `Failed to update reserves for pair ${marketPair.marketAddress}:`,
            error
          );
          return null;
        }
      })
    );

    try {
      const results = await Promise.all(promises);
      const validResults = results.filter(pair => pair !== null);
      filteredPairsInArbitrage.push(...validResults);
    } catch (error) {
      console.error('Batch processing error:', error);
    }
  }

  console.log(`Filtered pairs for arbitrage calculation: ${filteredPairsInArbitrage.length}`);
  return filteredPairsInArbitrage;
}
// In UniswapV2EthPair getBalance method:

async getBalance(tokenAddress: string): Promise<BigNumber> {
  tokenAddress = tokenAddress.toLowerCase();

  if (tokenAddress === WETH_ADDRESS.toLowerCase()) {
    const wethBalance = await UniswapV2EthPair.fetchWETHBalance(this.provider, this.marketAddress, WETH_ADDRESS);
    return wethBalance;
  }

  const balance = this._tokenBalances[tokenAddress];
  if (balance === undefined) {
    console.warn(`Invalid or unrecognized token address: ${tokenAddress}`);
    return BigNumber.from(0);
  }
  return balance as BigNumber;  // Add type assertion if needed
}
  async setReservesViaOrderedBalances(balances: Array<BigNumber>): Promise<void> {
    await this.setReservesViaMatchingArray(this._tokens, balances) // Change this line
  }
  // Optimizing setReservesViaMatchingArray for clearer balance updating:

  async setReservesViaMatchingArray(tokens: Array<string>, balances: Array<BigNumber>): Promise<void> {
    const tokenBalances = _.zipObject(tokens, balances);
    if (!_.isEqual(this._tokenBalances, tokenBalances)) {
      this._tokenBalances = tokenBalances;
    }
  }

  async getTokensIn(tokenIn: string, tokenOut: string, amountOut: BigNumber): Promise<BigNumber> {
    const reserveIn = this._tokenBalances[tokenIn]
    const reserveOut = this._tokenBalances[tokenOut]
    return this.getAmountIn(reserveIn, reserveOut, amountOut);
  }

  async getTokensOut(tokenIn: string, tokenOut: string, amountIn: BigNumber): Promise<BigNumber> {
    const reserveIn = this._tokenBalances[tokenIn];
    const reserveOut = this._tokenBalances[tokenOut];
    return Promise.resolve(this.getAmountOut(reserveIn, reserveOut, amountIn));
  }

  getAmountIn(reserveIn: BigNumber, reserveOut: BigNumber, amountOut: BigNumber): BigNumber {
    const numerator: BigNumber = reserveIn.mul(amountOut).mul(1000);
    const denominator: BigNumber = reserveOut.sub(amountOut).mul(997);
    return numerator.div(denominator).add(1);
  }

  getAmountOut(reserveIn: BigNumber, reserveOut: BigNumber, amountIn: BigNumber): BigNumber {
    const amountInWithFee: BigNumber = amountIn.mul(997);
    const numerator = amountInWithFee.mul(reserveOut);
    const denominator = reserveIn.mul(1000).add(amountInWithFee);
    return numerator.div(denominator);
  }
  async sellTokensToNextMarket(tokenIn: string, amountIn: BigNumber, ethMarket: EthMarket): Promise<BuyCalls> {
    if (ethMarket.receiveDirectly(tokenIn) === true) {
      const exchangeCall = await this.sellTokens(tokenIn, amountIn, ethMarket.marketAddress);
      return {
        data: [exchangeCall],
        targets: [this.marketAddress]
      };
    }

    const exchangeCall = await this.sellTokens(tokenIn, amountIn, ethMarket.marketAddress);
    return {
      data: [exchangeCall],
      targets: [this.marketAddress]
    };
  }

  async sellTokens(tokenIn: string, amountIn: BigNumber, recipient: string): Promise<string> {
    let amount0Out = BigNumber.from(0);
    let amount1Out = BigNumber.from(0);
    let tokenOut: string;
    if (tokenIn === this._tokens[0]) {
      tokenOut = this._tokens[1];
      amount1Out = await this.getTokensOut(tokenIn, tokenOut, amountIn);
    } else if (tokenIn === this._tokens[1]) {
      tokenOut = this._tokens[0];
      amount0Out = await this.getTokensOut(tokenIn, tokenOut, amountIn);
    } else {
      throw new Error("Bad token input address");
    }
    const populatedTransaction = await UniswapV2EthPair.uniswapInterface.populateTransaction.swap(amount0Out, amount1Out, recipient, []);
    if (populatedTransaction === undefined || populatedTransaction.data === undefined) throw new Error("HI");
    return populatedTransaction.data;
  }



  // Example updated method for batch-updating reserves via Multicall2
  static async updateReservesWithMulticall(
    provider: StaticJsonRpcProvider,
    pairs: UniswapV2EthPair[]
  ): Promise<UniswapV2EthPair[]> {
    console.log('Attempting to update reserves in one or more multicall batches');
    const MULTICALL2_ADDRESS = "0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696";
    const MULTICALL2_ABI = [
     "function aggregate(tuple(address target, bytes callData)[] calls) public returns (uint256 blockNumber, bytes[] returnData)"
   ];

    const limit = pLimit(50); // Adjust concurrency to your preference
    const multicall2 = new Contract(MULTICALL2_ADDRESS, MULTICALL2_ABI, provider);

    // This chunk size helps control how many calls are sent per block of multicall
    const CHUNK_SIZE = 200;
    let updatedPairs: UniswapV2EthPair[] = [];

    // Break the pairs array into chunks to avoid block gas limit issues
    for (let i = 0; i < pairs.length; i += CHUNK_SIZE) {
      const chunk = pairs.slice(i, i + CHUNK_SIZE);

      // Build calls array for the chunk
      const calls = chunk.map(pair => {
        const callData = new Interface(UNISWAP_PAIR_ABI).encodeFunctionData("getReserves");
        return {
          target: pair.marketAddress,
          callData: callData
        };
      });

      // Execute multicall for this chunk
      try {
        const [, returnData] = await limit(() => multicall2.aggregate(calls));
        // Return data is an array of ABI-encoded results for each call

        chunk.forEach((pair, idx) => {
          try {
            const result = returnData[idx];
            if (result) {
              const [reserve0, reserve1] = new Interface(UNISWAP_PAIR_ABI).decodeFunctionResult(
                "getReserves",
                result
              ) as [BigNumber, BigNumber, number];

              // If reserves are below a threshold, skip them
              const totalReserve = reserve0.add(reserve1);
              if (totalReserve.gt(parseEther("3"))) {
                // For example if you have a method to set reserves or store them
                // pair.setReservesViaOrderedBalances(...)
                // or directly store into your pair class
              }
              updatedPairs.push(pair);
            }
          } catch (e) {
            console.error(`Decoding error for pair ${pair.marketAddress}`, e);
          }
        });
      } catch (e) {
        console.error(`Multicall chunk failed: ${e}`);
      }
    }

    console.log(`Finished multicall update. Updated pairs: ${updatedPairs.length}`);
    return updatedPairs;
  }
}
