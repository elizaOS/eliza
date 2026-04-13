# LP Manager Example

An autonomous liquidity position (LP) management agent for DeFi. This agent monitors LP positions across multiple DEXes on Solana and EVM chains, automatically rebalancing when profitable opportunities are detected.

## Features

- **Multi-Chain Support**: Manages positions on Solana (Raydium, Orca, Meteora) and EVM chains (Uniswap V3, PancakeSwap V3, Aerodrome)
- **Autonomous Monitoring**: Polls positions every 5 minutes (configurable) for yield optimization opportunities
- **Smart Rebalancing**: Only rebalances when net gain exceeds threshold after accounting for gas, slippage, and swap fees
- **Rebalancable Position Tracking**: Each position is marked as rebalancable or locked, with reasons for locked positions
- **Concentrated Liquidity**: Monitors price ranges and alerts when positions drift out of range
- **High APR Detection**: Identifies sustainable high-APR opportunities with good volume backing (not just inflated reward APRs)
- **Opportunity Scoring**: Each opportunity is scored (0-100) based on net gain, volume/TVL ratio, APR sustainability, and cost efficiency
- **Risk Management**: Configurable thresholds for position size, pool TVL, and impermanent loss risk
- **Interactive CLI**: Real-time status updates and manual controls

## Supported DEXes

### Solana
- **Raydium**: CLMM and standard pools
- **Orca**: Whirlpools (concentrated liquidity)
- **Meteora**: DLMM (Dynamic Liquidity Market Maker)

### EVM
- **Uniswap V3**: Ethereum, Base, Arbitrum, Polygon, Optimism
- **PancakeSwap V3**: BSC, Ethereum, Arbitrum, Base
- **Aerodrome**: Base chain

## Quick Start

### 1. Install Dependencies

```bash
cd examples/lp-manager/typescript
bun install
```

### 2. Configure Environment

Create a `.env` file in the typescript directory:

```bash
# User identifier (optional, auto-generated if not set)
LP_USER_ID=my-lp-agent

# Solana Configuration
SOLANA_PRIVATE_KEY=your_base58_private_key
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# EVM Configuration (set the chains you want to use)
EVM_PRIVATE_KEY=0x_your_hex_private_key
ETHEREUM_RPC_URL=https://eth-mainnet.example.com
BASE_RPC_URL=https://mainnet.base.org
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
BSC_RPC_URL=https://bsc-dataseed.binance.org

# Monitoring Configuration
LP_CHECK_INTERVAL_MS=300000          # 5 minutes (default)
LP_MIN_GAIN_THRESHOLD_PERCENT=1.0    # Minimum 1% net gain to rebalance
LP_MAX_SLIPPAGE_BPS=50               # 0.5% max slippage
LP_AUTO_REBALANCE_ENABLED=true       # Enable automatic rebalancing

# Risk Management
LP_MAX_POSITION_SIZE_USD=10000       # Maximum position size
LP_MIN_POOL_TVL_USD=100000           # Minimum pool TVL to consider
LP_MAX_IL_RISK_PERCENT=10            # Maximum impermanent loss risk

# DEX Preferences (comma-separated, optional)
LP_SOLANA_DEXES=raydium,orca,meteora
LP_EVM_DEXES=uniswap,pancakeswap,aerodrome
```

### 3. Run the Agent

```bash
# Development mode (with hot reload)
bun run dev

# Production mode
bun run start
```

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `LP_USER_ID` | Auto-generated | Unique identifier for the agent |
| `LP_CHECK_INTERVAL_MS` | 300000 (5 min) | How often to check positions |
| `LP_MIN_GAIN_THRESHOLD_PERCENT` | 1.0 | Minimum net gain % to trigger rebalance |
| `LP_MAX_SLIPPAGE_BPS` | 50 | Maximum slippage in basis points |
| `LP_AUTO_REBALANCE_ENABLED` | true | Enable automatic rebalancing |
| `LP_CONCENTRATED_REPOSITION_THRESHOLD` | 0.1 | Reposition when price is 10% from range edge |
| `LP_MAX_POSITION_SIZE_USD` | 10000 | Maximum USD value per position |
| `LP_MIN_POOL_TVL_USD` | 100000 | Minimum pool TVL to consider |
| `LP_MAX_IL_RISK_PERCENT` | 10 | Maximum impermanent loss risk % |

## Interactive Commands

When running in a terminal, the following commands are available:

| Command | Description |
|---------|-------------|
| `status` or `s` | Display current status summary |
| `check` or `c` | Trigger an immediate monitoring cycle |
| `help` or `h` | Show available commands |
| `quit` or `q` | Stop the agent gracefully |

## Position Management

### Rebalancable vs Locked Positions

Each LP position is analyzed and marked as either **rebalancable** (🔄) or **locked** (🔒):

**Rebalancable positions** can be automatically moved to better pools when opportunities arise.

**Locked positions** are excluded from automatic rebalancing. A position is locked if:
- It's in a vesting period or has lock constraints
- Position value is below minimum threshold ($10)
- Created less than 1 hour ago (to avoid churn)
- User has explicitly marked it as non-rebalancable

### Opportunity Scoring

Each opportunity is scored from 0-100 based on:

| Factor | Max Points | Criteria |
|--------|-----------|----------|
| Net Gain | 40 | 1% = 10 points, caps at 4% |
| Volume/TVL | 20 | 10-50% daily turnover is ideal |
| APR Sustainability | 20 | Lower, stable APRs score higher |
| TVL Health | 10 | Larger pools = better liquidity |
| Cost Efficiency | 10 | Lower cost relative to position |

Opportunities are also classified by APR quality:
- 🟢 **Sustainable**: Good volume backing, reasonable APR
- **Moderate**: May have some reward component
- 🔴 **Unsustainable**: Very high APR likely from temporary incentives

High-APR opportunities (⭐) are those with 20%+ APR that are sustainable.

## How It Works

### 1. Position Discovery

The agent tracks LP positions by:
- Scanning on-chain position NFTs (Solana concentrated liquidity)
- Querying NFT position managers (EVM Uniswap V3 style)
- Tracking LP token balances (traditional pools)

### 2. Opportunity Analysis

Every monitoring cycle, the agent:
1. Fetches current position yields and status
2. Queries all available pools across DEXes
3. Calculates potential gains from rebalancing
4. Estimates costs (gas, slippage, swap fees)
5. Filters by net gain threshold and risk parameters

### 3. Rebalancing Execution

When a profitable opportunity is found:
1. Withdraw from current position
2. Swap tokens if needed (to match target pool)
3. Deposit to new pool
4. Update position tracking

### 4. Concentrated Liquidity Monitoring

For concentrated liquidity positions (Raydium CLMM, Orca Whirlpools, Uniswap V3):
- Tracks current price relative to position range
- Warns when price approaches range boundaries
- Can automatically reposition when out of range

## Architecture

```
examples/lp-manager/typescript/
├── src/
│   ├── agent.ts              # Main agent entry point
│   ├── character.ts          # Agent personality and settings
│   ├── index.ts              # Module exports
│   ├── types.ts              # TypeScript type definitions
│   └── services/
│       └── LpMonitoringService.ts  # Autonomous monitoring service
├── package.json
└── tsconfig.json
```

## Example Output

```
╔════════════════════════════════════════════════════════════╗
║                    LP MANAGER AGENT                        ║
║    Autonomous Liquidity Position Management for DeFi      ║
╚════════════════════════════════════════════════════════════╝

[LpManagerAgent] Starting LP Manager Agent...
[LpManagerAgent] User ID: lp-agent-1736784000000
[LpManagerAgent] Runtime initialized
[LpManagerAgent] LP Manager services ready
[LpManagerAgent] Vault public key: 7xK2...3mNp
[LpManagerAgent] User profile ensured
[LpMonitoringService] Starting autonomous monitoring
[LpMonitoringService] Check interval: 300000ms (5 minutes)

============================================================
LP MANAGER AGENT STATUS
============================================================
Running: true
Monitoring: true
User ID: lp-agent-1736784000000
Last Check: 2026-01-13T12:00:00.000Z
Next Check: 2026-01-13T12:05:00.000Z

POSITIONS:
  raydium:SOL-USDC-clmm
    SOL/USDC - $5,240.00 @ 24.30% APR (in range)
  uniswap:ETH-USDC-0.3
    ETH/USDC - $3,100.00 @ 18.70% APR (in range)

OPPORTUNITIES:
  ✓ raydium:SOL-USDC-clmm → meteora:SOL-USDC-dlmm
    APR: 24.30% → 32.10% (net +7.80%)
    Cost: $4.20, Risk: 15
    Reason: Net gain 7.80% exceeds threshold, risk acceptable

SUMMARY:
  Total Value: $8,340.00
  Average APR: 21.50%
  Positions: 2
  Actionable Opportunities: 1
============================================================
```

## Security Considerations

- **Private Keys**: Never commit private keys to version control. Use environment variables or secure key management.
- **RPC Endpoints**: Use authenticated RPC endpoints in production for reliability.
- **Auto-Rebalancing**: Start with `LP_AUTO_REBALANCE_ENABLED=false` to observe opportunities before enabling automatic execution.
- **Slippage Protection**: The agent respects `LP_MAX_SLIPPAGE_BPS` to prevent losses from price movement during transactions.

## Extending the Agent

### Custom Strategies

You can extend the agent by modifying `LpMonitoringService.ts`:

```typescript
// Add custom opportunity evaluation logic
private evaluateOpportunity(opportunity: OptimizationOpportunity): OpportunityAnalysis {
  // Your custom logic here
}
```

### Additional DEXes

The agent uses `@elizaos/plugin-lp-manager` which can be extended to support additional DEXes. See the plugin documentation for details.

## Troubleshooting

### No positions found
- Verify your wallet has LP positions on supported DEXes
- Ensure the correct private key is configured
- Check that positions are tracked in the user profile

### Services not available
- Wait for plugin initialization (up to 30 seconds)
- Verify RPC endpoints are accessible
- Check logs for specific service errors

### Rebalancing not executing
- Verify `LP_AUTO_REBALANCE_ENABLED=true`
- Check that opportunities meet the minimum gain threshold
- Review the `reason` field in opportunity analysis

## License

MIT - See LICENSE file in repository root.
