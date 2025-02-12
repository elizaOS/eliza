---
sidebar_position: 16
---

# 📈 Autonomous Trading

## Overview

Eliza's autonomous trading system enables automated token trading on the Solana blockchain. The system integrates with Jupiter aggregator for efficient swaps, implements smart order routing, and includes risk management features.

## Core Components

### Token Provider

Manages token information and market data:

```typescript
class TokenProvider {
    constructor(
        private tokenAddress: string,
        private walletProvider: WalletProvider,
    ) {
        this.cache = new NodeCache({ stdTTL: 300 }); // 5 minutes cache
    }

    async fetchPrices(): Promise<Prices> {
        const { SOL, BTC, ETH } = TOKEN_ADDRESSES;
        // Fetch current prices
        return {
            solana: { usd: "0" },
            bitcoin: { usd: "0" },
            ethereum: { usd: "0" },
        };
    }

    async getProcessedTokenData(): Promise<ProcessedTokenData> {
        return {
            security: await this.fetchTokenSecurity(),
            tradeData: await this.fetchTokenTradeData(),
            holderDistributionTrend: await this.analyzeHolderDistribution(),
            highValueHolders: await this.filterHighValueHolders(),
            recentTrades: await this.checkRecentTrades(),
            dexScreenerData: await this.fetchDexScreenerData(),
        };
    }
}
```

### Swap Execution

Implementation of token swaps using Jupiter:

```typescript
async function swapToken(
    connection: Connection,
    walletPublicKey: PublicKey,
    inputTokenCA: string,
    outputTokenCA: string,
    amount: number,
): Promise<any> {
    // Get token decimals
    const decimals = await getTokenDecimals(connection, inputTokenCA);
    const adjustedAmount = amount * 10 ** decimals;

    // Fetch quote
    const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}` +
            `&outputMint=${outputTokenCA}` +
            `&amount=${adjustedAmount}` +
            `&slippageBps=50`,
    );

    // Execute swap
    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        body: JSON.stringify({
            quoteResponse: await quoteResponse.json(),
            userPublicKey: walletPublicKey.toString(),
            wrapAndUnwrapSol: true,
        }),
    });

    return swapResponse.json();
}
```

## Position Management

### Order Book System

```typescript
interface Order {
    userId: string;
    ticker: string;
    contractAddress: string;
    timestamp: string;
    buyAmount: number;
    price: number;
}

class OrderBookProvider {
    async addOrder(order: Order): Promise<void> {
        let orderBook = await this.readOrderBook();
        orderBook.push(order);
        await this.writeOrderBook(orderBook);
    }

    async calculateProfitLoss(userId: string): Promise<number> {
        const orders = await this.getUserOrders(userId);
        return orders.reduce((total, order) => {
            const currentPrice = this.getCurrentPrice(order.ticker);
            const pl = (currentPrice - order.price) * order.buyAmount;
            return total + pl;
        }, 0);
    }
}
```

### Position Sizing

```typescript
async function calculatePositionSize(
    tokenData: ProcessedTokenData,
    riskLevel: "LOW" | "MEDIUM" | "HIGH",
): Promise<CalculatedBuyAmounts> {
    const { liquidity, marketCap } = tokenData.dexScreenerData.pairs[0];

    // Impact percentages based on liquidity
    const impactPercentages = {
        LOW: 0.01, // 1% of liquidity
        MEDIUM: 0.05, // 5% of liquidity
        HIGH: 0.1, // 10% of liquidity
    };

    return {
        none: 0,
        low: liquidity.usd * impactPercentages.LOW,
        medium: liquidity.usd * impactPercentages.MEDIUM,
        high: liquidity.usd * impactPercentages.HIGH,
    };
}
```

## Risk Management

### Token Validation

```typescript
async function validateToken(token: TokenPerformance): Promise<boolean> {
    const security = await fetchTokenSecurity(token.tokenAddress);

    // Red flags check
    if (
        security.rugPull ||
        security.isScam ||
        token.rapidDump ||
        token.suspiciousVolume ||
        token.liquidity.usd < 1000 || // Minimum $1000 liquidity
        token.marketCap < 100000 // Minimum $100k market cap
    ) {
        return false;
    }

    // Holder distribution check
    const holderData = await fetchHolderList(token.tokenAddress);
    const topHolderPercent = calculateTopHolderPercentage(holderData);
    if (topHolderPercent > 0.5) {
        // >50% held by top holders
        return false;
    }

    return true;
}
```

### Trade Management

```typescript
interface TradeManager {
    async executeTrade(params: {
        inputToken: string,
        outputToken: string,
        amount: number,
        slippage: number
    }): Promise<string>;

    async monitorPosition(params: {
        tokenAddress: string,
        entryPrice: number,
        stopLoss: number,
        takeProfit: number
    }): Promise<void>;

    async closePosition(params: {
        tokenAddress: string,
        amount: number
    }): Promise<string>;
}
```

## Market Analysis

### Price Data Collection

```typescript
async function collectMarketData(
    tokenAddress: string,
): Promise<TokenTradeData> {
    return {
        price: await fetchCurrentPrice(tokenAddress),
        volume_24h: await fetch24HourVolume(tokenAddress),
        price_change_24h: await fetch24HourPriceChange(tokenAddress),
        liquidity: await fetchLiquidity(tokenAddress),
        holder_data: await fetchHolderData(tokenAddress),
        trade_history: await fetchTradeHistory(tokenAddress),
    };
}
```

### Technical Analysis

```typescript
function analyzeMarketConditions(tradeData: TokenTradeData): MarketAnalysis {
    return {
        trend: analyzePriceTrend(tradeData.price_history),
        volume_profile: analyzeVolumeProfile(tradeData.volume_history),
        liquidity_depth: analyzeLiquidityDepth(tradeData.liquidity),
        holder_behavior: analyzeHolderBehavior(tradeData.holder_data),
    };
}
```

## Trade Execution

### Swap Implementation

```typescript
async function executeSwap(
    runtime: IAgentRuntime,
    input: {
        tokenIn: string;
        tokenOut: string;
        amountIn: number;
        slippage: number;
    },
): Promise<string> {
    // Prepare transaction
    const { swapTransaction: transaction } = await getSwapTransaction(input);

    // Sign transaction
    const keypair = getKeypairFromPrivateKey(
        runtime.getSetting("SOLANA_PRIVATE_KEY") ??
            runtime.getSetting("WALLET_PRIVATE_KEY"),
    );
    transaction.sign([keypair]);

    // Execute swap
    const signature = await connection.sendTransaction(transaction);

    // Confirm transaction
    await connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    return signature;
}
```

### DAO Integration

```typescript
async function executeSwapForDAO(
    runtime: IAgentRuntime,
    params: {
        inputToken: string;
        outputToken: string;
        amount: number;
    },
): Promise<string> {
    const authority = getAuthorityKeypair(runtime);
    const [statePDA, walletPDA] = await derivePDAs(authority);

    // Prepare instruction data
    const instructionData = prepareSwapInstruction(params);

    // Execute swap through DAO
    return invokeSwapDao(
        connection,
        authority,
        statePDA,
        walletPDA,
        instructionData,
    );
}
```

## Monitoring & Safety

### Health Checks

```typescript
async function performHealthChecks(): Promise<HealthStatus> {
    return {
        connection: await checkConnectionStatus(),
        wallet: await checkWalletBalance(),
        orders: await checkOpenOrders(),
        positions: await checkPositions(),
    };
}
```

### Safety Limits

```typescript
const SAFETY_LIMITS = {
    MAX_POSITION_SIZE: 0.1, // 10% of portfolio
    MAX_SLIPPAGE: 0.05, // 5% slippage
    MIN_LIQUIDITY: 1000, // $1000 minimum liquidity
    MAX_PRICE_IMPACT: 0.03, // 3% price impact
    STOP_LOSS: 0.15, // 15% stop loss
};
```

## Error Handling

### Transaction Errors

```typescript
async function handleTransactionError(
    error: Error,
    transaction: Transaction,
): Promise<void> {
    if (error.message.includes("insufficient funds")) {
        await handleInsufficientFunds();
    } else if (error.message.includes("slippage tolerance exceeded")) {
        await handleSlippageError(transaction);
    } else {
        await logTransactionError(error, transaction);
    }
}
```

### Recovery Procedures

```typescript
async function recoverFromError(
    error: Error,
    context: TradingContext,
): Promise<void> {
    // Stop all active trades
    await stopActiveTrades();

    // Close risky positions
    await closeRiskyPositions();

    // Reset system state
    await resetTradingState();

    // Notify administrators
    await notifyAdministrators(error, context);
}
```
