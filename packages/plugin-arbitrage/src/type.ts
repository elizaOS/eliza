import { BigNumber } from "@ethersproject/bignumber";
import { IAgentRuntime, Memory, Provider } from "@elizaos/core";

// Core Arbitrage Types
export interface CrossedMarketDetails {
    marketPairs: MarketPair[];
    profit: BigNumber;
    volume: BigNumber;
    tokenAddress: string;
    buyFromMarket: EthMarket;
    sellToMarket: EthMarket;
}

export interface MarketPair {
    buyFromMarket: EthMarket;
    sellToMarket: EthMarket;
}

// Market Management Types
export type MarketsByToken = {
    [tokenAddress: string]: Array<EthMarket>;
}

export interface MarketType {
    marketAddress: string;
    getReserves(tokenAddress: string): Promise<BigNumber>;
    getPriceImpact(tokenAddress: string, tradeSize: BigNumber): Promise<BigNumber>;
    getTradingFee(tokenAddress: string): Promise<BigNumber>;
}

// Trading Operation Types
export interface BuyCalls {
    targets: string[];
    data: string[];
}

export interface EthMarket extends MarketType {
    tokenAddress: string;
    marketAddress: string;
    tokens: string[];
    protocol: any;
    getBalance(address: string): Promise<BigNumber>;
    sellTokensToNextMarket(WETH_ADDRESS: string, volume: BigNumber, sellToMarket: EthMarket): Promise<BuyCalls>;
    getTokensOut(WETH_ADDRESS: string, tokenAddress: string, volume: BigNumber): Promise<BigNumber>;
    sellTokens(tokenAddress: string, amount: BigNumber, address: string): Promise<string>;
    receiveDirectly(tokenAddress: string): boolean;
}

// Eliza Plugin Integration Types
export interface ArbitrageAction {
    name: string;
    handler: (runtime: IAgentRuntime, message: Memory) => Promise<void>;
    validate: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
}

export interface ArbitrageProvider extends Provider {
    get: (runtime: IAgentRuntime, message: Memory) => Promise<ArbitrageState>;
}

export interface ArbitrageState {
    opportunities: number;
    totalProfit: string;
    lastUpdate: string;
    markets: MarketsByToken;
}

// WebSocket Types
export interface SubscriptionConfig {
    DEX_ADDRESSES: string[];
    TRANSFER_TOPIC: string;
    SWAP_TOPIC: string;
}

export interface ArbitrageOpportunity {
    profit: BigNumber;
    route: {
        sourceRouter: string;
        targetRouter: string;
        tokenIn: string;
        tokenOut: string;
        amountIn: BigNumber;
        expectedOutput: BigNumber;
    } | null;
}

// Runtime Configuration Types
export interface ArbitrageConfig {
    minProfitThreshold: BigNumber;
    maxTradeSize: BigNumber;
    gasLimit: number;
    minerRewardPercentage: number;
}

// Error Types
export interface ArbitrageError extends Error {
    type: 'EXECUTION' | 'VALIDATION' | 'CONFIGURATION';
    details?: any;
}

// Event Types for WebSocket
export interface SwapEvent {
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
    blockNumber: number;
}

export interface TransferEvent {
    from: string;
    to: string;
    value: BigNumber;
    tokenAddress: string;
}

// Add this to your existing types
export interface ExtendedAgentRuntime extends IAgentRuntime {
    wallet: any; // Replace 'any' with proper wallet type
    flashbotsProvider: any; // Replace 'any' with proper provider type
    bundleExecutorContract: any;
    marketsByToken: MarketsByToken;
    currentBlock: number;
}