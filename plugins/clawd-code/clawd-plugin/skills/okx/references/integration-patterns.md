# Integration Patterns — Helius x OKX

## What This Covers

End-to-end patterns for combining OKX's DEX aggregation, token intelligence, and market data with Helius's Solana infrastructure. These patterns show how the two systems connect at the transaction, data, and monitoring layers.

**OKX** handles DEX aggregation (500+ liquidity sources), token discovery, market data, smart money signals, and meme token analysis via the `onchainos` CLI. For detailed OKX command reference and parameters, see the OKX skill library (`onchainos-skills`).

**Helius** handles Solana infrastructure — transaction submission (Sender), fee optimization (Priority Fees), asset queries (DAS), real-time on-chain monitoring (WebSockets), shred-level streaming (LaserStream), and wallet intelligence (Wallet API). For detailed Helius tool reference, use the Helius MCP server tools.

---

## Pattern 1: OKX Swap via Helius Sender

The most critical integration. OKX's swap command returns transaction data. Sign it locally and submit via Helius Sender for optimal block inclusion.

### Flow

1. Resolve token addresses (if needed) via `onchainos token search`
2. Get a quote from `onchainos swap quote`
3. Run safety checks (honeypot, price impact, tax)
4. Present quote to user and get confirmation
5. Execute `onchainos swap swap` to get transaction data
6. Sign the transaction locally
7. Submit via Helius Sender endpoint
8. Confirm via Helius WebSocket or polling

### TypeScript Example

```typescript
import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js';
import { execFileSync } from 'child_process';

const SENDER_URL = 'https://sender.helius-rpc.com/fast';

async function swapViaOkxAndSender(
  keypair: Keypair,
  fromMint: string,
  toMint: string,
  amountLamports: string,
  slippage: string = '1'
): Promise<string> {
  // 1. Get quote first to check safety
  const quoteOutput = execFileSync('onchainos', [
    'swap', 'quote',
    '--from', fromMint, '--to', toMint,
    '--amount', amountLamports, '--chain', 'solana',
  ], { encoding: 'utf-8' });
  const quote = JSON.parse(quoteOutput);

  // 2. Safety checks
  if (quote.fromToken?.isHoneyPot || quote.toToken?.isHoneyPot) {
    throw new Error('Honeypot detected — aborting swap');
  }
  const priceImpact = parseFloat(quote.priceImpactPercent || '0');
  if (priceImpact > 10) {
    throw new Error(`Price impact too high: ${priceImpact}% — consider reducing amount`);
  }

  // 3. Execute swap to get transaction data
  const swapOutput = execFileSync('onchainos', [
    'swap', 'swap',
    '--from', fromMint, '--to', toMint,
    '--amount', amountLamports, '--chain', 'solana',
    '--wallet', keypair.publicKey.toBase58(), '--slippage', slippage,
  ], { encoding: 'utf-8' });
  const swapResult = JSON.parse(swapOutput);

  // 4. Deserialize and sign the transaction
  const txData = swapResult.tx.data;
  const txBuffer = Buffer.from(txData, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([keypair]);

  // 5. Submit via Helius Sender
  const response = await fetch(SENDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: 'sendTransaction',
      params: [
        Buffer.from(transaction.serialize()).toString('base64'),
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 }
      ]
    })
  });

  const result = await response.json();
  if (result.error) throw new Error(`Sender error: ${result.error.message}`);
  return result.result; // transaction signature
}
```

### Key Points

- **Helius Sender** dual-routes to validators AND Jito for maximum block inclusion probability
- OKX swap transactions may already include priority fees — check before adding duplicate compute budget instructions
- Always use `skipPreflight: true` and `maxRetries: 0` with Sender
- For additional priority fee control, use `getPriorityFeeEstimate` MCP tool
- Use Sender's HTTPS endpoint (`sender.helius-rpc.com/fast`) for browser apps, regional HTTP endpoints for backends

---

## Pattern 2: Token Discovery with Helius DAS Enrichment

Combine OKX's token intelligence with Helius DAS for comprehensive token analysis.

### Flow

1. Use OKX to discover tokens (trending, hot tokens, signals)
2. Enrich with Helius DAS for on-chain metadata verification
3. Cross-reference OKX risk data with Helius wallet intelligence

### TypeScript Example

```typescript
import { execFileSync } from 'child_process';

async function enrichedTokenDiscovery(heliusApiKey: string) {
  // 1. Get trending tokens from OKX
  const trendingOutput = execFileSync('onchainos', [
    'token', 'trending', '--chains', 'solana', '--sort-by', '5', '--time-frame', '4',
  ], { encoding: 'utf-8' });
  const trending = JSON.parse(trendingOutput);

  // 2. Enrich top tokens with Helius DAS metadata
  const topMints = trending.slice(0, 10).map((t: any) => t.address);

  const dasResponse = await fetch(
    `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAssetBatch',
        params: { ids: topMints }
      })
    }
  );
  const { result: assets } = await dasResponse.json();

  // 3. Combine OKX market data with Helius on-chain data
  return trending.slice(0, 10).map((token: any, i: number) => ({
    // OKX data
    symbol: token.symbol,
    address: token.address,
    price: token.price,
    volume24h: token.volume,
    marketCap: token.marketCap,
    priceChange24h: token.change,
    // Helius DAS data
    name: assets[i]?.content?.metadata?.name,
    image: assets[i]?.content?.links?.image,
    verified: assets[i]?.content?.metadata?.symbol === token.symbol,
    tokenProgram: assets[i]?.token_info?.token_program,
  }));
}
```

---

## Pattern 3: Smart Money Copy-Trading Pipeline

Track smart money signals from OKX and execute trades via Helius Sender.

### Architecture

```
OKX Signals ──> Signal Analysis ──> OKX Risk Check ──> User Confirmation
                                                              │
                                                     OKX Swap Quote
                                                              │
                                                     Helius Sender ──> Confirmation
```

### Flow

1. Poll OKX signals for high-conviction buys
2. Filter: multiple wallet types, low sold ratio, sufficient liquidity
3. Run due diligence: `token advanced-info`, `memepump token-dev-info`
4. Present analysis to user with risk assessment
5. On approval: `swap quote` → safety checks → `swap swap` → Helius Sender
6. Monitor confirmation via Helius WebSocket

### Key Considerations

- NEVER auto-execute trades from signals — always present analysis and get user confirmation
- Check `soldRatioPercent` — if high, smart money has already exited
- Verify liquidity is sufficient for the intended trade size
- Use `getPriorityFeeEstimate` for competitive fee levels during time-sensitive entries
- Monitor the position via Helius `getWalletBalances` after entry

---

## Pattern 4: Meme Token Scanner with On-Chain Verification

Combine OKX trenches analysis with Helius DAS and wallet intelligence for comprehensive meme token evaluation.

### Architecture

```
OKX Trenches ──> Dev Reputation ──> Bundle Analysis
       │                                    │
       ├── OKX Token Discovery ──> Risk Tags
       │                                    │
       └── Helius DAS ──> On-Chain Verify   │
           Helius Wallet API ──> Dev Wallet Investigation
```

### TypeScript Example

```typescript
async function memeTokenDueDiligence(
  mintAddress: string,
  heliusApiKey: string
) {
  // 1. OKX: Dev reputation
  const devInfo = JSON.parse(execFileSync('onchainos', [
    'memepump', 'token-dev-info', '--address', mintAddress, '--chain', 'solana',
  ], { encoding: 'utf-8' }));

  // 2. OKX: Bundle/sniper analysis
  const bundleInfo = JSON.parse(execFileSync('onchainos', [
    'memepump', 'token-bundle-info', '--address', mintAddress, '--chain', 'solana',
  ], { encoding: 'utf-8' }));

  // 3. OKX: Advanced risk tags
  const riskInfo = JSON.parse(execFileSync('onchainos', [
    'token', 'advanced-info', '--address', mintAddress, '--chain', 'solana',
  ], { encoding: 'utf-8' }));

  // 4. Helius: On-chain metadata verification
  const assetRes = await fetch(
    `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAsset',
        params: { id: mintAddress }
      })
    }
  );
  const { result: asset } = await assetRes.json();

  // 5. Helius: Investigate dev wallet
  const devWallet = devInfo.devAddress;
  const fundingRes = await fetch(
    `https://api.helius.xyz/v1/wallet/${devWallet}/funded-by?api-key=${heliusApiKey}`
  );
  const funding = fundingRes.ok ? await fundingRes.json() : null;

  return {
    token: {
      name: asset?.content?.metadata?.name,
      symbol: asset?.content?.metadata?.symbol,
      mint: mintAddress,
    },
    risk: {
      level: riskInfo.riskControlLevel,
      honeypot: riskInfo.tags?.includes('honeypot'),
      lpBurnedPercent: riskInfo.lpBurnedPercent,
      top10HoldPercent: riskInfo.top10HoldPercent,
      devHoldPercent: riskInfo.devHoldingPercent,
    },
    developer: {
      address: devInfo.devAddress,
      totalTokens: devInfo.totalTokens,
      rugPullCount: devInfo.rugPullCount,
      goldenGemCount: devInfo.goldenGemCount,
      fundedBy: funding?.funderName || funding?.funder || 'unknown',
    },
    manipulation: {
      totalBundlers: bundleInfo.totalBundlers,
      bundlerAthPercent: bundleInfo.bundlerAthPercent,
    },
  };
}
```

---

## Pattern 5: Portfolio Dashboard with Multi-Source Data

Combine Helius wallet intelligence with OKX market data for a comprehensive portfolio view.

### Architecture

```
Helius Wallet API ──> Holdings + USD Values
Helius DAS API ────> Token Metadata + Images
OKX Market Data ───> Price Charts + OHLC
OKX Portfolio PnL ─> Trading Performance
Helius parseTransactions ──> Trade History
```

### Flow

1. **Holdings**: Helius `getWalletBalances` for Solana portfolio with USD values
2. **Token metadata**: Helius DAS `getAssetsByOwner` with `showFungible: true` for icons and details
3. **Price charts**: OKX `market kline` for candlestick data on selected tokens
4. **PnL analysis**: OKX `portfolio-overview` for realized/unrealized PnL and win rate
5. **Trade history**: Helius `parseTransactions` for human-readable transaction log
6. **Identity**: Helius `getWalletIdentity` to check if wallet is a known entity — accepts an address or SNS/ANS domain

### Multi-Chain Extension

For wallets with cross-chain activity:
- Solana holdings: Helius `getWalletBalances` (detailed, with identity)
- EVM holdings: OKX `portfolio all-balances --chains ethereum,base,bsc`
- Total value: OKX `portfolio total-value --chains solana,ethereum,base`

---

## Pattern 6: Trading Bot with LaserStream Signals

Build an automated trading system using Helius LaserStream for shred-level on-chain signals and OKX for execution.

### Architecture

```
LaserStream (gRPC) ──> Signal Detection ──> OKX Swap Quote ──> Helius Sender
       │                      │
       │  shred-level         │  market signals
       │  account data        │  trigger trades
       │                      │
       └──> Fill detection    └──> Risk check via OKX token advanced-info
```

### TypeScript Example

```typescript
import { subscribe, CommitmentLevel } from 'helius-laserstream';
import { execFileSync } from 'child_process';

const config = {
  apiKey: process.env.HELIUS_API_KEY,
  endpoint: 'https://laserstream-mainnet-ewr.helius-rpc.com',
};

// Monitor token program for large transfers (potential alpha signals)
const request = {
  transactions: {
    client: 'okx-trading-bot',
    accountInclude: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
    vote: false,
    failed: false,
  },
  commitment: CommitmentLevel.CONFIRMED,
};

await subscribe(
  config,
  request,
  async (data) => {
    const signal = analyzeTransaction(data);
    if (!signal) return;

    // Risk check via OKX before trading
    const riskInfo = JSON.parse(execFileSync('onchainos', [
      'token', 'advanced-info', '--address', signal.tokenMint, '--chain', 'solana',
    ], { encoding: 'utf-8' }));

    if (riskInfo.tags?.includes('honeypot')) return;
    if (parseFloat(riskInfo.devHoldingPercent) > 50) return;

    // Execute via OKX swap + Helius Sender (Pattern 1)
    await swapViaOkxAndSender(
      keypair, signal.inputMint, signal.outputMint, signal.amount
    );
  },
  (error) => console.error('LaserStream error:', error)
);
```

### LaserStream vs OKX Market Data

| | LaserStream | OKX Market Data |
|---|---|---|
| Data | Raw on-chain (transactions, accounts) | Market-level (prices, OHLC, PnL) |
| Latency | Shred-level (lowest possible) | API polling |
| Use case | On-chain event detection, HFT, bots | Price analysis, charting, portfolio |
| Plan required | Business+ ($499+/mo) | OKX API key |

**Use both together**: LaserStream for on-chain signals and fill detection, OKX market data for price context and risk analysis.

---

## Common Mistakes Across All Patterns

- Submitting OKX swap transactions to raw RPC instead of Helius Sender
- Not using `skipPreflight: true` with Sender (transactions get rejected)
- Auto-executing trades from OKX signals without user confirmation
- Using native SOL address (`111...1`) where wSOL is needed and vice versa
- Not running safety checks (honeypot, price impact) before confirming swaps
- Using LaserStream for simple features that Enhanced WebSockets can handle (unnecessary cost)
- Forgetting to convert between atomic units (CLI) and human-readable units (display)
- Not verifying OKX CLI binary integrity (SHA256 checksums) before first use
