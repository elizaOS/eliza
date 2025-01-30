import { WebSocket } from 'ws';
import { BigNumber } from 'ethers/lib/ethers';
import { Arbitrage } from './Arbitrage';
import { UniswapV2EthPair } from './UniswapV2EthPair';
import * as dotenv from "dotenv";
dotenv.config();


export interface SubscriptionConfig {
    DEX_ADDRESSES: string[];
    TRANSFER_TOPIC: string;
    SWAP_TOPIC: string;
}

export class EnhancedWebSocketManager {
    private arbitrage: Arbitrage;
    private markets: { [token: string]: UniswapV2EthPair[] };
    ws: any;
    config: SubscriptionConfig;
    subscriptions: any;
    pendingTxs: any;
  start: any;

    constructor(
        websocketUrl: string,
        config: SubscriptionConfig,
        arbitrage: Arbitrage,
        initialMarkets: { [token: string]: UniswapV2EthPair[] }
    ) {
        this.ws = new WebSocket(websocketUrl);
        this.config = config;
        this.arbitrage = arbitrage;
        this.markets = initialMarkets;
        this.subscriptions = new Map(); // Add this line
        this.pendingTxs = new Set();
        this.setupWebSocket();
    }

    private setupWebSocket() {
        this.ws.on('open', () => {
            console.log('WebSocket connection established');
            this.subscribeToAll();
        });

        this.ws.on('message', (data: string) => {
            const message = JSON.parse(data);
            this.handleMessage(message);
        });

        this.ws.on('close', () => {
            console.log('WebSocket connection closed');
            this.reconnect();
        });

        this.ws.on('error', (error: any) => {
            console.error('WebSocket error:', error);
        });
    }

    private async subscribeToAll() {
        // Subscribe to pending transactions specific to DEX addresses
        await this.subscribeToPendingTransactions();

        // Subscribe to new blocks
        await this.subscribeToNewHeads();

        // Subscribe to DEX-specific logs (transfers and swaps)
        await this.subscribeToLogs();
    }

    private async subscribeToPendingTransactions() {
        const subscribeMsg = {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_subscribe",
            params: [
                "alchemy_pendingTransactions",
                {
                    toAddress: this.config.DEX_ADDRESSES,
                    hashesOnly: false
                }
            ]
        };

        this.ws.send(JSON.stringify(subscribeMsg));
    }

    private async subscribeToNewHeads() {
        const subscribeMsg = {
            jsonrpc: "2.0",
            id: 2,
            method: "eth_subscribe",
            params: ["newHeads"]
        };

        this.ws.send(JSON.stringify(subscribeMsg));
    }

    private async subscribeToLogs() {
        const subscribeMsg = {
            jsonrpc: "2.0",
            id: 3,
            method: "eth_subscribe",
            params: [
                "logs",
                {
                    address: this.config.DEX_ADDRESSES,
                    topics: [
                        [this.config.TRANSFER_TOPIC, this.config.SWAP_TOPIC]
                    ]
                }
            ]
        };

        this.ws.send(JSON.stringify(subscribeMsg));
    }

    private async handleMessage(message: any) {
        // Handle subscription confirmations
        if (message.id) {
            this.subscriptions.set(message.id.toString(), message.result);
            return;
        }

        // Handle subscription messages
        if (message.method === "eth_subscription") {
            const { subscription, result } = message.params;

            switch(subscription) {
                case this.subscriptions.get("1"): // Pending Transactions
                    await this.handlePendingTransaction(result);
                    break;

                case this.subscriptions.get("2"): // New Heads
                    await this.handleNewBlock(result);
                    break;

                case this.subscriptions.get("3"): // Logs
                    await this.handleLog(result);
                    break;
            }
        }
    }

    private async handlePendingTransaction(tx: any) {
        if (this.pendingTxs.has(tx.hash)) return;

        this.pendingTxs.add(tx.hash);

        // Check if this is a DEX interaction
        if (this.config.DEX_ADDRESSES.includes(tx.to?.toLowerCase())) {
            await this.analyzePotentialArbitrage(tx);
        }
    }

    private async handleNewBlock(block: any) {
        // Clear pending transactions from previous block
        this.pendingTxs.clear();

        // Trigger price updates and arbitrage checks
        await this.checkArbitrageOpportunities(block.number);
    }

    private async handleLog(log: any) {
        const isSwap = log.topics[0] === this.config.SWAP_TOPIC;
        const isTransfer = log.topics[0] === this.config.TRANSFER_TOPIC;

        if (isSwap) {
            await this.handleSwapEvent(log);
        } else if (isTransfer) {
            await this.handleTransferEvent(log);
        }
    }

    private async analyzePotentialArbitrage(tx: any) {
        try {
            const decodedInput = this.decodeTransactionInput(tx.input, tx);

            if (this.isSwapTransaction(decodedInput)) {
                // Special handling for ETH swaps
                if (decodedInput.swapType === 'ETH_FOR_TOKENS') {
                    console.log(`Detected ETH swap: ${tx.value} ETH for ${decodedInput.tokenOut}`);

                    // Calculate potential arbitrage opportunity with actual ETH value
                    const opportunity = await this.calculateArbitrageOpportunity(
                        tx.to,
                        decodedInput.tokenIn,  // WETH address
                        decodedInput.tokenOut,
                        decodedInput.amountIn  // Actual ETH value from tx
                    );

                    if (opportunity.profit.gt(0)) {
                        await this.executeArbitrage(opportunity);
                    }
                } else {
                    // Calculate potential arbitrage opportunity
                    const opportunity = await this.calculateArbitrageOpportunity(
                        tx.to,
                        decodedInput.tokenIn,
                        decodedInput.tokenOut,
                        decodedInput.amountIn
                    );

                    if (opportunity.profit.gt(0)) {
                        await this.executeArbitrage(opportunity);
                    }
                }
            }
        } catch (error) {
            console.error('Error analyzing potential arbitrage:', error);
        }
    }

    private async checkArbitrageOpportunities(blockNumber: string) {
        // Implement your cross-DEX arbitrage checking logic here
        console.log(`Checking arbitrage opportunities for block ${blockNumber}`);
    }

    private decodeTransactionInput(input: string, tx?: any): any {
        try {
            // Common DEX function signatures
            const SWAP_EXACT_TOKENS = '0x38ed1739';
            const SWAP_TOKENS_EXACT = '0x8803dbee';
            const SWAP_ETH_FOR_TOKENS = '0x7ff36ab5';  // swapExactETHForTokens

            // Remove '0x' prefix
            const cleanInput = input.slice(2);
            const functionSignature = cleanInput.slice(0, 8);

            switch (functionSignature) {
                case SWAP_ETH_FOR_TOKENS:
                    // Format: swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)
                    return {
                        isSwap: true,
                        swapType: 'ETH_FOR_TOKENS',
                        tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH address
                        tokenOut: '0x' + cleanInput.slice(34, 74),  // First token in path
                        amountIn: BigNumber.from(tx?.value || '0'), // ETH value from tx
                        amountOutMin: BigNumber.from('0x' + cleanInput.slice(10, 74)), // minimum amount of tokens to receive
                        deadline: BigNumber.from('0x' + cleanInput.slice(138, 202))  // transaction deadline
                    };
                case SWAP_EXACT_TOKENS:
                case SWAP_TOKENS_EXACT:
                    return {
                        isSwap: true,
                        tokenIn: '0x' + cleanInput.slice(34, 74),  // First token address parameter
                        tokenOut: '0x' + cleanInput.slice(98, 138), // Second token address parameter
                        amountIn: BigNumber.from('0x' + cleanInput.slice(138, 178)) // Amount parameter
                    };
                default:
                    return { isSwap: false };
            }
        } catch (error) {
            console.error('Error decoding transaction input:', error);
            return { isSwap: false };
        }
    }

    private isSwapTransaction(decodedInput: any): boolean {
        return decodedInput.isSwap === true;
    }

    private async calculateArbitrageOpportunity(dex: string, tokenIn: string, tokenOut: string, amountIn: BigNumber) {
        try {
            // Get prices from different DEXes
            const prices = await Promise.all(this.config.DEX_ADDRESSES.map(async (dexAddress) => {
                if (dexAddress.toLowerCase() === dex.toLowerCase()) return null;

                // Get quote from other DEX
                const quote = await this.arbitrage.getOutputAmount(
                    dexAddress,
                    tokenIn,
                    tokenOut,
                    amountIn
                );

                return {
                    dexAddress,
                    outputAmount: quote
                };
            }));

            // Find best arbitrage opportunity
            let bestProfit = BigNumber.from(0);
            let bestRoute = null;

            for (const price of prices) {
                if (!price) continue;

                // Calculate potential profit
                const profit = price.outputAmount.sub(amountIn);

                if (profit.gt(bestProfit)) {
                    bestProfit = profit;
                    bestRoute = {
                        sourceRouter: dex,
                        targetRouter: price.dexAddress,
                        tokenIn,
                        tokenOut,
                        amountIn,
                        expectedOutput: price.outputAmount
                    };
                }
            }

            return {
                profit: bestProfit,
                route: bestRoute
            };
        } catch (error) {
            console.error('Error calculating arbitrage opportunity:', error);
            return { profit: BigNumber.from(0), route: null };
        }
    }

    private async executeArbitrage(opportunity: any) {
        if (!opportunity.route) return;

        try {
            // Check if profit meets minimum threshold (e.g., covers gas)
            const minProfitThreshold = BigNumber.from(process.env.MIN_PROFIT_THRESHOLD || '0');
            if (opportunity.profit.lt(minProfitThreshold)) {
                console.log('Profit too low to execute arbitrage');
                return;
            }

            // Execute the arbitrage transaction
            const tx = await this.arbitrage.executeArbitrage(
                opportunity.route.sourceRouter,
                opportunity.route.targetRouter,
                opportunity.route.tokenIn,
                opportunity.route.tokenOut,
                opportunity.route.amountIn
            );

            console.log(`Arbitrage executed: ${tx.hash}`);

            // Wait for confirmation
            const receipt = await tx.wait();
            console.log(`Arbitrage confirmed in block ${receipt.blockNumber}`);
        } catch (error) {
            console.error('Error executing arbitrage:', error);
        }
    }

    private async handleSwapEvent(log: any) {
        try {
            const dexAddress = log.address;
            // Update market state for this DEX
            if (!this.markets[dexAddress]) {
                this.markets[dexAddress] = [];
            }
            // Track latest swap
            const marketInfo = {
                lastUpdate: Date.now(),
                lastSwap: log
            };
            // Update first entry or add new one
            if (this.markets[dexAddress].length > 0) {
                Object.assign(this.markets[dexAddress][0], marketInfo);
            } else {
                this.markets[dexAddress].push(marketInfo as unknown as UniswapV2EthPair);
            }

            // Extract relevant data from the swap event
            const topics = log.topics;
            const data = log.data;

            // Update local price state
            await this.arbitrage.updatePrices(dexAddress);

            // Check for arbitrage opportunities
            const tokens = await this.arbitrage.getTokenPair(dexAddress);
            if (!tokens) return;

            const amount = BigNumber.from('1000000000000000000'); // 1 token as base amount
            const opportunity = await this.calculateArbitrageOpportunity(
                dexAddress,
                tokens.token0,
                tokens.token1,
                amount
            );

            if (opportunity.profit.gt(0)) {
                await this.executeArbitrage(opportunity);
            }
        } catch (error) {
            console.error('Error handling swap event:', error);
        }
    }

    private async handleTransferEvent(log: any) {
        try {
            // Extract transfer details
            const from = '0x' + log.topics[1].slice(26);
            const to = '0x' + log.topics[2].slice(26);
            const amount = BigNumber.from(log.data);

            // If transfer involves a DEX, update prices
            if (this.config.DEX_ADDRESSES.includes(from.toLowerCase()) ||
                this.config.DEX_ADDRESSES.includes(to.toLowerCase())) {
                const dexAddress = this.config.DEX_ADDRESSES.find(
                    addr => addr.toLowerCase() === from.toLowerCase() ||
                           addr.toLowerCase() === to.toLowerCase()
                );

                if (dexAddress) {
                    await this.arbitrage.updatePrices(dexAddress);
                }
            }
        } catch (error) {
            console.error('Error handling transfer event:', error);
        }
    }

    private reconnect() {
        setTimeout(() => {
            console.log('Attempting to reconnect...');
            this.ws = new WebSocket(this.ws.url);
            this.setupWebSocket();
        }, 5000); // Wait 5 seconds before reconnecting
    }
}

// Example usage
const config: SubscriptionConfig = {
    DEX_ADDRESSES: [
        '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
        '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'  // Sushiswap Router
    ],
    TRANSFER_TOPIC: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    SWAP_TOPIC: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
};