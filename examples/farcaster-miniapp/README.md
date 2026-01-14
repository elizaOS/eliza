# Spartan Multi-Chain DeFi - Farcaster Mini App

A comprehensive multi-chain social trading platform built as a Farcaster Mini App. Trade seamlessly across Solana and multiple EVM chains (Ethereum, Base, Arbitrum, Optimism) with AI-powered insights and social features.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Solana](https://img.shields.io/badge/Solana-Support-brightgreen)
![EVM](https://img.shields.io/badge/EVM-Multi--Chain-orange)
![Farcaster](https://img.shields.io/badge/Farcaster-Mini_App-purple)

## ✨ Features

### 🌐 Multi-Chain Support
- **Solana**: Native SOL, USDC, USDT, BONK, JUP and more
- **Ethereum**: ETH, USDC, USDT, DAI
- **Base**: ETH, USDC, DAI
- **Arbitrum**: ETH, USDC, USDT, DAI
- **Optimism**: ETH, USDC, USDT, DAI

### 💼 Portfolio Management
- View balances across all supported chains
- Real-time portfolio valuation in USD
- Token holdings with price information
- Chain-specific filtering
- Unified dashboard view

### 🔄 Token Swaps
- **Solana**: Jupiter aggregator integration
- **EVM Chains**: LiFi integration for best rates
- Real-time price quotes
- Slippage protection
- Gas estimation

### 🌉 Cross-Chain Bridging
- Bridge assets between Solana and EVM chains
- Bridge between different EVM chains
- Powered by LiFi
- Estimated time and fees display
- Transaction tracking

### 📱 Social Features
- Post trading updates to Farcaster
- View your Farcaster feed
- Engage with the community
- Share insights and strategies

### 🤖 AI Assistant
- Spartan AI for trading advice
- Multi-chain strategy recommendations
- Market analysis and insights
- Natural language interaction
- Confidence scores and suggestions

## 🚀 Quick Start

### Prerequisites
- Node.js 22+ or Bun 1.2+
- ElizaOS instance running with required plugins
- Farcaster account with FID

### Installation

1. **Clone and navigate:**
   ```bash
   cd multichain-miniapp
   ```

2. **Install dependencies:**
   ```bash
   npm install
   # or
   bun install
   ```

3. **Configure environment:**
   ```bash
   cp env.example .env
   # Edit .env with your configuration
   ```

4. **Start development servers:**
   ```bash
   # Terminal 1: Backend API
   npm start

   # Terminal 2: Frontend dev server
   npm run dev
   ```

5. **Open in browser:**
   ```
   http://localhost:3000
   ```

## 🔧 Configuration

### Required Environment Variables

```env
# Server Configuration
PORT=3001
HOSTNAME=localhost:3001

# ElizaOS API
ELIZA_API_URL=http://localhost:3000

# Solana Configuration
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PRIVATE_KEY=your_solana_private_key

# EVM Configuration
EVM_PRIVATE_KEY=your_evm_private_key
EVM_PROVIDER_URL=https://eth.llamarpc.com
ETHEREUM_PROVIDER_BASE=https://mainnet.base.org
ETHEREUM_PROVIDER_ARBITRUM=https://arb1.arbitrum.io/rpc
ETHEREUM_PROVIDER_OPTIMISM=https://mainnet.optimism.io

# LiFi Integration (optional)
LIFI_API_KEY=your_lifi_api_key

# Farcaster Integration
FARCASTER_FID=your_farcaster_fid
FARCASTER_NEYNAR_API_KEY=your_neynar_api_key
FARCASTER_SIGNER_UUID=your_signer_uuid

# Wallet Mappings
WALLET_<FID>=solana_address,evm_address
```

### ElizaOS Setup

Ensure your ElizaOS instance has these plugins:

```typescript
import { jupiterPlugin } from '@elizaos/plugin-jupiter'
import { evmPlugin } from '@elizaos/plugin-evm'
import { farcasterPlugin } from '@elizaos/plugin-farcaster'

const character = {
  name: 'SpartanAgent',
  plugins: [
    jupiterPlugin,
    evmPlugin,
    farcasterPlugin,
  ],
  settings: {
    chains: {
      evm: ['base', 'arbitrum', 'optimism', 'ethereum']
    }
  }
}
```

## 📖 Usage

### For Users

1. **Open the Mini App** from a Farcaster cast or direct link
2. **Authentication** happens automatically via Farcaster Quick Auth
3. **Navigate** between tabs:
   - 💼 **Portfolio**: View your multi-chain holdings
   - 🔄 **Swap**: Trade tokens on any chain
   - 🌉 **Bridge**: Move assets between chains
   - 📱 **Social**: Share and view trading updates
   - 🤖 **AI Chat**: Get trading advice from Spartan AI

### Portfolio Tab
- View total portfolio value across all chains
- Filter by specific chain
- See native balances and token holdings
- Refresh to get latest prices

### Swap Tab
- Select source chain
- Choose input and output tokens
- Enter amount
- Get instant quote
- Execute swap with one click

### Bridge Tab
- Select source and destination chains
- Choose tokens to bridge
- Get bridge quote with fees and time
- Execute cross-chain transfer

### Social Tab
- Post trading insights to Farcaster
- View your feed
- Engage with community casts
- Share portfolio performance

### AI Chat Tab
- Ask questions about trading strategies
- Get market analysis
- Receive personalized recommendations
- Multi-chain strategy advice

## 🏗️ Architecture

### Frontend (React + TypeScript)
```
src/
├── components/          # React components
│   ├── Header.tsx
│   ├── LoadingScreen.tsx
│   ├── ChainSelector.tsx
│   ├── ChainBadge.tsx
│   ├── MultiChainPortfolio.tsx
│   ├── TokenSwap.tsx
│   ├── Bridge.tsx
│   ├── SocialFeed.tsx
│   └── SpartanChat.tsx
├── lib/                # Utilities
│   ├── api.ts         # API client
│   ├── chains.ts      # Chain configs
│   └── utils.ts       # Helper functions
└── types/             # TypeScript types
    └── index.ts
```

### Backend (Express)
- REST API with Quick Auth middleware
- ElizaOS agent integration
- Multi-chain support via plugins
- LiFi integration for swaps and bridges
- Farcaster social features

### Data Flow
```
User → Mini App → Quick Auth → Backend API → ElizaOS → Blockchain
                     ↓
                 JWT Token
```

## 🛠️ Development

### Build for Production
```bash
npm run build
```

### Preview Production Build
```bash
npm run preview
```

### Type Checking
```bash
tsc --noEmit
```

## 📦 Deployment

### Vercel
1. Connect your repository to Vercel
2. Set environment variables in Vercel dashboard
3. Deploy

### Railway
1. Create new Railway project
2. Connect repository
3. Configure environment variables
4. Deploy

### Self-Hosted
1. Build the frontend: `npm run build`
2. Serve static files from `dist/`
3. Run backend: `npm start`
4. Configure reverse proxy (nginx/caddy)

## 🔐 Security

- Private keys stored securely in environment variables
- JWT authentication via Farcaster Quick Auth
- CORS configured for specific origins
- Input validation on all endpoints
- HTTPS required in production

## 🤝 Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🙏 Acknowledgments

- **Farcaster** - Decentralized social protocol
- **ElizaOS** - AI agent framework
- **Jupiter** - Solana DEX aggregator
- **LiFi** - Cross-chain bridge and swap aggregator
- **Neynar** - Farcaster API infrastructure

## 🔗 Resources

- [Farcaster Mini Apps Documentation](https://miniapps.farcaster.xyz)
- [ElizaOS Documentation](https://elizaos.ai/docs)
- [Jupiter API Docs](https://docs.jup.ag)
- [LiFi Documentation](https://docs.li.fi)

## 📞 Support

For issues or questions:
- GitHub Issues
- Discord Community
- Twitter: @SpartanDeFi

---

**Built with** ❤️ **using ElizaOS, React, and Farcaster**

🛡️ **Spartan Multi-Chain** - Trade Everywhere, Win Anywhere

