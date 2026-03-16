# @elizaos/plugin-lp-manager

Advanced liquidity pool management plugin for Eliza OS that provides comprehensive DeFi automation, yield optimization, and portfolio management across Solana DEXs.

## Overview

The LP Manager plugin transforms Eliza OS agents into sophisticated DeFi yield managers, enabling automated liquidity provision, real-time yield optimization, and intelligent portfolio rebalancing across multiple Solana DEXs. It bridges the complexity of DeFi with natural language interactions, making advanced LP strategies accessible through conversational AI.

## Features

### 🚀 Core Capabilities

- **Multi-DEX Integration**: Seamlessly manage liquidity across Raydium, Orca, and Meteora
- **Natural Language LP Management**: Execute complex DeFi strategies through simple conversations
- **Automated Yield Optimization**: AI-driven rebalancing to maximize returns
- **Real-Time Portfolio Tracking**: Monitor positions, yields, and impermanent loss
- **Risk Management**: Configurable safety parameters and slippage protection

### 💰 Liquidity Management

- **Smart Deposit Routing**: Automatically find and deposit into the highest-yielding pools
- **Flexible Position Management**: 
  - Deposit specific amounts (e.g., "LP 10 USDC")
  - Use percentage-based allocation (e.g., "LP 50% of my SOL")
  - All-in strategies (e.g., "LP all my SOL and USDC")
- **Multi-Asset Support**: Handle any token pair across supported DEXs
- **Proportional Calculations**: Automatic ratio calculations for balanced liquidity provision

### 🔄 Automated Rebalancing

- **Yield Opportunity Detection**: Continuously monitor for better APR opportunities
- **Configurable Triggers**:
  - Minimum gain thresholds (e.g., 5% improvement required)
  - Maximum slippage tolerance (e.g., 1% max slippage)
  - Preferred DEX selection
- **Cost-Benefit Analysis**: Factor in gas fees and slippage before rebalancing
- **Automated Execution**: Hands-free portfolio optimization

### 📊 Analytics & Monitoring

- **Performance Tracking**:
  - Total yield earned
  - Impermanent loss calculations
  - HODL vs LP comparison
- **Position Overview**:
  - Current pool allocations
  - Underlying token amounts
  - Real-time valuations
- **Historical Analysis**: Track performance over time

### 🔐 Security & Vault Management

- **Secure Vault System**: Isolated key management per user
- **Encrypted Storage**: Private keys never exposed
- **Permission Controls**: Granular access management
- **Export Capabilities**: Secure key export with user confirmation

## Architecture

### Services

- **VaultService**: Secure key management and wallet operations
- **UserLpProfileService**: User preferences and profile management
- **DexInteractionService**: Multi-DEX integration layer
- **YieldOptimizationService**: Yield analysis and rebalancing logic
- **NotificationService**: Real-time alerts and updates

### Actions

- **LpManagementAgentAction**: Natural language intent processing and execution

### Tasks

- **LpAutoRebalanceTask**: Background yield optimization and rebalancing

## Installation

```bash
npm install @elizaos/plugin-lp-manager
```

## Configuration

### Environment Variables

```typescript
// Optional: Configure RPC and API keys
SOLANA_RPC_URL=your_rpc_url
BIRDEYE_API_KEY=your_api_key  // For enhanced price data

// Optional: Set default preferences
DEFAULT_SLIPPAGE=1.0  // Default 1%
DEFAULT_MIN_GAIN=3.0  // Default 3% minimum gain for rebalancing
```

### Plugin Setup

```typescript
import { lpManagerPlugin } from '@elizaos/plugin-lp-manager';
import { raydiumPlugin } from '@elizaos/plugin-raydium';
import { orcaPlugin } from '@elizaos/plugin-orca';
import { meteoraPlugin } from '@elizaos/plugin-meteora';

// Initialize with DEX plugins
const runtime = await initializeRuntime({
  plugins: [
    lpManagerPlugin,
    raydiumPlugin,
    orcaPlugin, 
    meteoraPlugin
  ],
});
```

## Usage Examples

### Getting Started

**User**: "Hey! I keep hearing about providing liquidity to earn yield. Can you help me get started?"

**Agent**: "I'd be happy to help you get started with liquidity provision. First, I'll create a secure vault for your LP management. Then I can show you the best pools for your tokens. What tokens do you have available?"

### Onboarding & Vault Creation

**User**: "Yes, I want to start LP management. Set me up with a vault please!"

**Agent**: "I'll set up your secure LP management vault now. This will keep your assets safe while managing liquidity pools. Your vault has been created with auto-rebalancing disabled by default. Would you like me to show you the current best-performing pools?"

### Finding Opportunities

**User**: "Show me the best APR pools for SOL pairs"

**Agent**: "Here are the top SOL pair pools:
- SOL/USDC: 24.5% APR on Raydium
- SOL/USDT: 22.1% APR on Orca  
- SOL/RAY: 18.2% APR on Raydium
Would you like to add liquidity to any of these?"

### Making Deposits

**User**: "I want to LP all my SOL and USDC. Find me the best pool!"

**Agent**: "I'll find the optimal SOL/USDC pool for you. Currently, Raydium is offering 24.5% APR with deep liquidity. Shall I proceed with depositing your tokens there?"

**User**: "Just LP 10 USDC for now. What SOL amount do I need?"

**Agent**: "Based on current prices, you'll need approximately 0.067 SOL to pair with 10 USDC. The pool maintains a 50/50 value ratio. Shall I proceed with this deposit?"

### Managing Positions

**User**: "Show me all my LP positions and current yield"

**Agent**: "Your current LP positions:
- SOL/USDC on Raydium: $240.05 (0.25 SOL + 40 USDC)
  - Current APR: 24.5%
  - Daily earnings: $0.16
  - Impermanent loss: -$2.30
Overall, you're earning $0.16/day across all positions."

### Auto-Rebalancing Setup

**User**: "Enable auto-rebalancing with 3% minimum gain, prefer Orca and Raydium, max slippage 0.5%"

**Agent**: "I've configured your auto-rebalancing preferences:
- Minimum gain threshold: 3%
- Preferred DEXs: Orca, Raydium
- Maximum slippage: 0.5%
The system will now automatically move your liquidity when better opportunities arise."

### Withdrawals

**User**: "SOL is pumping! I want to withdraw 30% of my LP position"

**Agent**: "I'll help you withdraw 30% of your SOL LP position to capture those gains. This will remove approximately 0.075 SOL and 12 USDC from your position. Proceed?"

## Advanced Features

### Yield Optimization

The plugin continuously monitors all available pools and can automatically rebalance positions when:
- A higher-yielding pool is found that exceeds your minimum gain threshold
- Slippage remains within acceptable limits
- Gas costs are justified by the yield improvement

### Risk Management

- **Impermanent Loss Tracking**: Real-time IL calculations and warnings
- **Diversification Strategies**: Spread liquidity across multiple pools
- **Stable Pool Options**: Focus on correlated assets to minimize IL
- **Emergency Withdrawals**: Quick exit functionality for market volatility

### Cost Analysis

**User**: "I see a pool with 2% higher APR. Is it worth the gas to move?"

**Agent**: "Let me calculate that for you. With your position size of $240, a 2% APR increase would earn an extra $0.096/month. Gas costs are approximately $0.50, so you'd break even in 5.2 days. Worth it if you plan to hold for at least a week."

## Testing

The plugin includes comprehensive test suites:

### Unit Tests
```bash
npm test
```

### E2E Scenario Tests
```bash
npm run test:e2e
```

Covers 15+ real-world scenarios including:
- New user onboarding
- Various deposit strategies
- Yield optimization flows
- Risk management scenarios
- Emergency procedures

## Supported DEXs

- **Raydium**: Full support including concentrated liquidity
- **Orca**: Whirlpool positions and traditional pools
- **Meteora**: Dynamic pools and LB pairs

## Safety & Security

### Best Practices

1. **Vault Security**
   - Private keys are encrypted and isolated per user
   - No direct key exposure in logs or responses
   - Confirmation required for sensitive operations

2. **Transaction Safety**
   - All transactions simulated before execution
   - Slippage protection on every trade
   - Automatic reversion on failure

3. **Risk Parameters**
   - Configure maximum position sizes
   - Set minimum liquidity thresholds
   - Enable/disable auto-rebalancing

## Troubleshooting

### Common Issues

**"No LP services found"**
- Ensure DEX plugins are installed and initialized
- Check that services are properly registered

**"Insufficient balance"**
- Verify token balances before deposits
- Account for gas fees in calculations

**"Pool not found"**
- Confirm token addresses are correct
- Check if pool exists on specified DEX

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup

```bash
# Clone the repository
git clone https://github.com/elizaos/eliza

# Install dependencies
cd packages/plugin-lp-manager
npm install

# Run tests
npm test

# Build
npm run build
```

## Concentrated Liquidity (Coming Soon)

The plugin now includes foundation support for concentrated liquidity positions, allowing users to:

### Range Management
**User**: "Create a concentrated position for SOL/USDC with a 20% range"

**Agent**: "I'll help you create a concentrated liquidity position. With SOL at $150, a 20% range would be $120-$180. This gives you higher capital efficiency but requires monitoring. Ready to proceed?"

### Position Monitoring
**User**: "Show my concentrated positions"

**Agent**: "Here are your concentrated positions:
- SOL/USDC: $120-$180 range
  - Current price: $155 ✅ IN RANGE
  - Utilization: 85%
  - Fees earned: $12.50 today"

### Automated Rebalancing
**User**: "My position is out of range, can you rebalance it?"

**Agent**: "Your SOL/USDC position is indeed out of range. Current price: $185. I can rebalance to a new range of $170-$210. This will cost approximately $0.50 in gas. Proceed?"

## Future Roadmap

- [x] Concentrated liquidity range management (Foundation implemented)
- [ ] Full concentrated liquidity integration with DEXs
- [ ] Multi-chain support (Ethereum, BSC, etc.)
- [ ] Advanced IL hedging strategies
- [ ] Leveraged LP positions
- [ ] Governance token farming optimization
- [ ] Cross-protocol yield aggregation

## Credits

Built with love by the Eliza community. Special thanks to:

- The Solana DeFi ecosystem
- Raydium, Orca, and Meteora teams
- All contributors and testers

## License

MIT - see LICENSE file for details
