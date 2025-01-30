import { BigNumber } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import { Provider, TransactionResponse } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { DEFAULT_THRESHOLDS, MarketThresholds } from '../config/thresholds';
import { WETH_ADDRESS } from "./addresses";
import { EthMarket } from "./EthMarket";
import { CrossedMarketDetails, MarketsByToken, MarketType } from "./types";
import { ETHER } from "./utils";
import { elizaLogger } from "@elizaos/core";

export interface BundleEntry {
  to: string;
  gas: number;
  gas_price: string;
  value: number;
  input: string;
  from: string;
  signedTransaction: string;
  signer: string;
}

export class Arbitrage {
    private bundleEntries: { bundle: BundleEntry[], blockNumber: number }[] = [];
    private thresholds: MarketThresholds = DEFAULT_THRESHOLDS;
    private MAX_RETRIES = 3;
    private RETRY_DELAY = 1000; // 1 second

    constructor(
        private wallet: Wallet,
        private flashbotsProvider: FlashbotsBundleProvider,
        private bundleExecutorContract: Contract
    ) {}

    async evaluateMarkets(marketsByToken: MarketsByToken): Promise<CrossedMarketDetails[]> {
        elizaLogger.log("Starting market evaluation...");
        const opportunities: CrossedMarketDetails[] = [];

        for (const [tokenAddress, markets] of Object.entries(marketsByToken)) {
            // Filter out markets with insufficient liquidity
            const validMarkets = await this.filterValidMarkets(markets, tokenAddress);
            
            // Compare each market pair for arbitrage opportunities
            for (let i = 0; i < validMarkets.length; i++) {
                for (let j = i + 1; j < validMarkets.length; j++) {
                    const opportunity = await this.checkArbitrageOpportunity(
                        validMarkets[i],
                        validMarkets[j],
                        tokenAddress
                    );
                    if (opportunity) {
                        opportunities.push(opportunity);
                    }
                }
            }
        }

        // Sort opportunities by profit
        return opportunities.sort((a, b) => b.profit.sub(a.profit).toNumber());
    }

    private async filterValidMarkets(markets: EthMarket[], tokenAddress: string): Promise<EthMarket[]> {
        const validMarkets: EthMarket[] = [];
        for (const market of markets) {
            try {
                const reserves = await market.getReserves(tokenAddress);
                if (reserves.gt(this.thresholds.minProfitThreshold)) {
                    validMarkets.push(market);
                }
            } catch (error) {
                console.error(`Error checking market ${market.marketAddress}:`, error);
            }
        }
        return validMarkets;
    }

    private async checkArbitrageOpportunity(
        market1: EthMarket,
        market2: EthMarket,
        tokenAddress: string
    ): Promise<CrossedMarketDetails | null> {
        try {
            // Get prices from both markets
            const price1 = await market1.getTokensOut(WETH_ADDRESS, tokenAddress, ETHER);
            const price2 = await market2.getTokensOut(WETH_ADDRESS, tokenAddress, ETHER);

            // Calculate potential profit
            const [buyMarket, sellMarket] = price1.gt(price2) 
                ? [market2, market1] 
                : [market1, market2];
            
            const profit = price1.gt(price2) 
                ? price1.sub(price2) 
                : price2.sub(price1);

            if (profit.gt(this.thresholds.minProfitThreshold)) {
                // Calculate optimal trade volume
                const volume = await this.calculateOptimalVolume(buyMarket, sellMarket, tokenAddress, profit);
                
                return {
                    marketPairs: [{
                        buyFromMarket: buyMarket,
                        sellToMarket: sellMarket
                    }],
                    profit,
                    volume,
                    tokenAddress,
                    buyFromMarket: buyMarket,
                    sellToMarket: sellMarket
                };
            }
        } catch (error) {
            console.error("Error checking arbitrage opportunity:", error);
        }
        return null;
    }

    async takeCrossedMarkets(
        markets: CrossedMarketDetails[], 
        currentBlock: number, 
        maxAttempts: number
    ): Promise<void> {
        for (const market of markets) {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const transaction = await this.executeArbitrageTrade(market, currentBlock);
                    if (transaction) {
                        elizaLogger.log(`Successful arbitrage execution: ${transaction.hash}`);
                        // Wait for confirmation
                        await transaction.wait(1);
                        break;
                    }
                } catch (error) {
                    console.error(`Attempt ${attempt} failed:`, error);
                    if (attempt === maxAttempts) {
                        console.error("Max attempts reached for market", market);
                    } else {
                        await new Promise(r => setTimeout(r, this.RETRY_DELAY));
                    }
                }
            }
        }
    }

    private async executeArbitrageTrade(
        market: CrossedMarketDetails,
        blockNumber: number
    ): Promise<TransactionResponse | null> {
        // Prepare the trade calls
        const buyCalls = await market.buyFromMarket.sellTokensToNextMarket(
            WETH_ADDRESS,
            market.volume,
            market.sellToMarket
        );

        // Calculate intermediate amounts
        const intermediateAmount = await market.buyFromMarket.getTokensOut(
            WETH_ADDRESS,
            market.tokenAddress,
            market.volume
        );

        // Prepare sell call
        const sellCallData = await market.sellToMarket.sellTokens(
            market.tokenAddress,
            intermediateAmount,
            this.bundleExecutorContract.address
        );

        // Combine all calls
        const targets = [...buyCalls.targets, market.sellToMarket.marketAddress];
        const payloads = [...buyCalls.data, sellCallData];

        // Calculate miner reward (90% of profit)
        const minerReward = market.profit.mul(90).div(100);

        // Create and simulate bundle
        const bundle = await this.createBundle(
            market.volume,
            minerReward,
            targets,
            payloads,
            blockNumber
        );

        // Execute if simulation successful
        return this.executeBundleWithRetry(bundle, blockNumber);
    }

    private async createBundle(
        volume: BigNumber,
        minerReward: BigNumber,
        targets: string[],
        payloads: string[],
        blockNumber: number
    ): Promise<BundleEntry[]> {
        // Estimate gas
        const gasEstimate = await this.estimateGasWithBuffer(
            volume,
            minerReward,
            targets,
            payloads
        );

        // Get optimal gas price
        const gasPrice = await this.getOptimalGasPrice(blockNumber);

        // Create transaction
        const transaction = await this.bundleExecutorContract.populateTransaction.uniswapWeth(
            volume,
            minerReward,
            targets,
            payloads,
            { gasLimit: gasEstimate, gasPrice }
        );

        // Sign transaction
        const signedTx = await this.wallet.signTransaction(transaction);
        
        // Create bundle entry
        const bundleEntry = await this.createBundleEntry(signedTx);
        
        return [bundleEntry];
    }

    private async estimateGasWithBuffer(
        volume: BigNumber,
        minerReward: BigNumber,
        targets: string[],
        payloads: string[]
    ): Promise<BigNumber> {
        const estimate = await this.bundleExecutorContract.estimateGas.uniswapWeth(
            volume,
            minerReward,
            targets,
            payloads
        );
        return estimate.mul(120).div(100); // Add 20% buffer
    }

    private async getOptimalGasPrice(blockNumber: number): Promise<BigNumber> {
        const { currentGasPrice, avgGasPrice } = await getGasPriceInfo(this.wallet.provider as Provider);
        const basePrice = currentGasPrice.gt(avgGasPrice) ? currentGasPrice : avgGasPrice;
        return basePrice.mul(110).div(100); // Add 10% to be competitive
    }

    private async executeBundleWithRetry(
        bundle: BundleEntry[], 
        blockNumber: number
    ): Promise<TransactionResponse | null> {
        for (let i = 0; i < this.MAX_RETRIES; i++) {
            try {
                // Simulate first
                await this.simulateBundle(bundle, blockNumber);
                
                // If simulation successful, submit
                const response = await this.flashbotsProvider.sendBundle(
                    bundle.map(entry => ({
                        signedTransaction: entry.signedTransaction,
                        signer: this.wallet,
                        transaction: {
                            to: entry.to,
                            gasLimit: entry.gas,
                            gasPrice: entry.gas_price,
                            value: entry.value,
                            data: entry.input
                        }
                    })),
                    blockNumber + 1
                );

                if ('error' in response) {
                    throw new Error(response.error.message);
                }

                return response as unknown as TransactionResponse;
            } catch (error) {
                console.error(`Bundle execution attempt ${i + 1} failed:`, error);
                if (i === this.MAX_RETRIES - 1) throw error;
                await new Promise(r => setTimeout(r, this.RETRY_DELAY));
            }
        }
        return null;
    }

    private async createBundleEntry(signedTx: string): Promise<BundleEntry> {
        const tx = await this.wallet.provider.getTransaction(signedTx);
        if (!tx?.to || !tx?.gasPrice || !tx?.value) {
            throw new Error("Invalid transaction");
        }

        return {
            to: tx.to,
            gas: tx.gasLimit.toNumber(),
            gas_price: tx.gasPrice.toString(),
            value: tx.value.toNumber(),
            input: tx.data,
            from: this.wallet.address,
            signedTransaction: signedTx,
            signer: this.wallet.address
        };
    }

    private async simulateBundle(bundle: BundleEntry[], blockNumber: number): Promise<void> {
        const stringBundle = bundle.map(entry => entry.signedTransaction);
        const simulation = await this.flashbotsProvider.simulate(stringBundle, blockNumber);

        if ('error' in simulation) {
            throw new Error(`Simulation failed: ${simulation.error.message}`);
        }

        // Verify profitability
        const { bundleGasPrice, coinbaseDiff, totalGasUsed } = simulation;
        const cost = bundleGasPrice.mul(totalGasUsed);
        const profit = coinbaseDiff.sub(cost);

        if (profit.lte(this.thresholds.minProfitThreshold)) {
            throw new Error("Bundle not profitable enough");
        }
    }

    async submitBundleWithAdjustedGasPrice(bundle: BundleEntry[], blockNumber: number, blocksApi: any): Promise<void> {
        elizaLogger.log(`Submitting bundle with adjusted gas price for block ${blockNumber}`);
        
        try {
            // Get current gas prices
            const { currentGasPrice, avgGasPrice } = await getGasPriceInfo(this.wallet.provider as Provider);
            
            // Monitor competing bundles
            const competingBundlesGasPrices = await monitorCompetingBundlesGasPrices(blocksApi);
            let competingBundleGasPrice = BigNumber.from(0);
            
            // Find highest competing gas price
            for (const price of competingBundlesGasPrices) {
                const currentPrice = BigNumber.from(price);
                if (currentPrice.gt(competingBundleGasPrice)) {
                    competingBundleGasPrice = currentPrice;
                }
            }

            // Calculate adjusted gas price
            const adjustedGasPrice = await this.adjustGasPriceForTransaction(
                currentGasPrice,
                avgGasPrice,
                competingBundleGasPrice
            );

            // Validate adjusted gas price
            if (adjustedGasPrice.lte(currentGasPrice)) {
                throw new Error("Adjusted gas price is not competitive");
            }

            // Validate bundle gas
            const isValidBundleGas = await checkBundleGas(adjustedGasPrice);
            if (!isValidBundleGas) {
                throw new Error("Invalid bundle gas");
            }

            // Set submission window
            const currentTimestamp = Math.floor(Date.now() / 1000);
            const maxTimestamp = currentTimestamp + 60; // 1 minute window

            // Submit bundle
            const targetBlockNumber = blockNumber + 1;
            const bundleSubmission = await this.flashbotsProvider.sendBundle(
                bundle.map(entry => ({
                    signedTransaction: entry.signedTransaction,
                    signer: this.wallet,
                    transaction: {
                        to: entry.to,
                        gasLimit: entry.gas,
                        gasPrice: entry.gas_price,
                        value: entry.value,
                        data: entry.input
                    }
                })),
                targetBlockNumber,
                {
                    minTimestamp: currentTimestamp,
                    maxTimestamp: maxTimestamp
                }
            );

            // Check submission result
            if ('error' in bundleSubmission) {
                throw new Error(`Bundle submission failed: ${bundleSubmission.error.message}`);
            }

            elizaLogger.log("Bundle submitted successfully:", {
                blockNumber: targetBlockNumber,
                adjustedGasPrice: adjustedGasPrice.toString(),
                bundleHash: bundleSubmission.bundleHash
            });

        } catch (error) {
            console.error("Failed to submit bundle with adjusted gas price:", error);
            throw error;
        }
    }

    private async adjustGasPriceForTransaction(
        currentGasPrice: BigNumber,
        avgGasPrice: BigNumber,
        competingBundleGasPrice: BigNumber
    ): Promise<BigNumber> {
        elizaLogger.log("Calculating adjusted gas price", {
            current: currentGasPrice.toString(),
            average: avgGasPrice.toString(),
            competing: competingBundleGasPrice.toString()
        });

        // Find highest gas price
        let adjustedGasPrice = currentGasPrice;
        if (avgGasPrice.gt(adjustedGasPrice)) {
            adjustedGasPrice = avgGasPrice;
        }
        if (competingBundleGasPrice.gt(adjustedGasPrice)) {
            adjustedGasPrice = competingBundleGasPrice;
        }

        // Add premium to ensure priority (10% increase)
        const premium = adjustedGasPrice.mul(10).div(100);
        adjustedGasPrice = adjustedGasPrice.add(premium);

        elizaLogger.log("Adjusted gas price:", adjustedGasPrice.toString());
        return adjustedGasPrice;
    }

    private async calculateOptimalVolume(
        buyFromMarket: MarketType,
        sellToMarket: MarketType,
        tokenAddress: string,
        profit: BigNumber
    ): Promise<BigNumber> {
        elizaLogger.log("Entering calculateOptimalVolume");

        // Determine the available liquidity in both markets
        const availableLiquidityBuy = await buyFromMarket.getReserves(tokenAddress);
        const availableLiquiditySell = await sellToMarket.getReserves(tokenAddress);

        // Set a maximum trade size limit to manage risk
        const maxTradeSize = BigNumber.from(100000); // Adjust as needed

        // Calculate price impacts and trading fees
        const priceImpactBuy = await buyFromMarket.getPriceImpact(tokenAddress, maxTradeSize);
        const priceImpactSell = await sellToMarket.getPriceImpact(tokenAddress, maxTradeSize);

        const tradingFeeBuy = await buyFromMarket.getTradingFee(tokenAddress);
        const tradingFeeSell = await sellToMarket.getTradingFee(tokenAddress);

        // Binary Search Initialization
        let left = BigNumber.from(1);
        let right = maxTradeSize;
        let optimalVolume = BigNumber.from(0);
        let maxExpectedProfit = BigNumber.from(0);

        while (left.lt(right)) {
            const mid = left.add(right).div(2);

            // Calculate expected profit at mid
            const expectedProfit = profit
                .mul(mid)
                .sub(priceImpactBuy.mul(mid))
                .sub(priceImpactSell.mul(mid))
                .sub(tradingFeeBuy.mul(mid))
                .sub(tradingFeeSell.mul(mid));

            if (expectedProfit.gt(maxExpectedProfit) && expectedProfit.gte(this.thresholds.minProfitThreshold)) {
                maxExpectedProfit = expectedProfit;
                optimalVolume = mid;
                left = mid.add(1);
            } else {
                right = mid.sub(1);
            }
        }

        // Ensure that the optimal volume does not exceed available liquidity
        optimalVolume = BigNumber.from(Math.min(
            optimalVolume.toNumber(),
            availableLiquidityBuy.toNumber(),
            availableLiquiditySell.toNumber()
        ));

        elizaLogger.log(`calculateOptimalVolume: optimalVolume = ${optimalVolume}`);
        return optimalVolume;
    }
}

// Helper functions
async function checkBundleGas(bundleGas: BigNumber): Promise<boolean> {
    const isValid = bundleGas.gte(42000);
    elizaLogger.log(`checkBundleGas: bundleGas = ${bundleGas}, isValid = ${isValid}`);
    return isValid;
}

export async function monitorCompetingBundlesGasPrices(blocksApi: { getRecentBlocks: () => any; }): Promise<Array<BigNumber>> {
    elizaLogger.log("Entering monitorCompetingBundlesGasPrices");
    const recentBlocks = await blocksApi.getRecentBlocks();
    const competingBundlesGasPrices = recentBlocks.map((block: { bundleGasPrice: any; }) => block.bundleGasPrice);
    elizaLogger.log(`monitorCompetingBundlesGasPrices: competingBundlesGasPrices = ${competingBundlesGasPrices}`);
    return competingBundlesGasPrices;
}

export async function getGasPriceInfo(provider: Provider): Promise<{ 
    currentGasPrice: BigNumber, 
    avgGasPrice: BigNumber 
}> {
    const feeData = await provider.getFeeData();
    const currentGasPrice = feeData.gasPrice || BigNumber.from(0);
    
    // Get average from last few blocks
    const block = await provider.getBlock("latest");
    const prices: BigNumber[] = [];
    for (let i = 0; i < 5; i++) {
        const historicalBlock = await provider.getBlock(block.number - i);
        if (historicalBlock.baseFeePerGas) {
            prices.push(historicalBlock.baseFeePerGas);
        }
    }
    
    const avgGasPrice = prices.length > 0 
        ? prices.reduce((a, b) => a.add(b)).div(prices.length)
        : currentGasPrice;

    return { currentGasPrice, avgGasPrice };
}

export async function calculateOptimalVolume(
    buyFromMarket: MarketType,
    sellToMarket: MarketType,
    tokenAddress: string,
    profit: BigNumber
): Promise<BigNumber> {
    const buyLiquidity = await buyFromMarket.getReserves(tokenAddress);
    const sellLiquidity = await sellToMarket.getReserves(tokenAddress);
    
    // Start with 1% of the smaller liquidity pool
    let optimalVolume = buyLiquidity.lt(sellLiquidity) 
        ? buyLiquidity.div(100)
        : sellLiquidity.div(100);

    // Adjust based on price impact
    const buyImpact = await buyFromMarket.getPriceImpact(tokenAddress, optimalVolume);
    const sellImpact = await sellToMarket.getPriceImpact(tokenAddress, optimalVolume);
    
    // If price impact is too high, reduce volume
    if (buyImpact.add(sellImpact).gt(BigNumber.from(300))) { // 3% total impact
        optimalVolume = optimalVolume.mul(80).div(100); // Reduce by 20%
    }

    return optimalVolume;
}