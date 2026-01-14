# 🚀 Quick Start Guide

Get your Spartan Multi-Chain Mini App running in 5 minutes!

## Step 1: Prerequisites ✅

Make sure you have:
- **Node.js 22+** or **Bun 1.2+** installed
- **Git** for cloning (if needed)
- A **Farcaster account** with FID
- **ElizaOS** instance running

## Step 2: Install Dependencies 📦

```bash
cd multichain-miniapp
npm install
```

Or with Bun:
```bash
bun install
```

## Step 3: Configure Environment 🔧

1. Copy the example environment file:
```bash
cp env.example .env
```

2. Edit `.env` with your settings:

### Minimum Required Configuration:
```env
# Server
PORT=3001
HOSTNAME=localhost:3001

# ElizaOS
ELIZA_API_URL=http://localhost:3000

# Farcaster (get from https://dev.neynar.com)
FARCASTER_FID=your_fid_here
FARCASTER_NEYNAR_API_KEY=your_neynar_key
FARCASTER_SIGNER_UUID=your_signer_uuid

# Demo wallet mapping
WALLET_12345=YourSolanaAddress,0xYourEVMAddress
```

### Optional (for production):
```env
# Your actual private keys
SOLANA_PRIVATE_KEY=your_solana_key
EVM_PRIVATE_KEY=your_evm_key

# Custom RPC endpoints
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
EVM_PROVIDER_URL=https://eth.llamarpc.com

# LiFi API key for better rates
LIFI_API_KEY=your_lifi_key
```

## Step 4: Start the Servers 🚀

### Option A: Two Terminal Windows

**Terminal 1 - Backend API:**
```bash
npm start
```

**Terminal 2 - Frontend Dev Server:**
```bash
npm run dev
```

### Option B: One Command (requires tmux or similar)

```bash
# Install concurrently if needed
npm install -g concurrently

# Run both servers
concurrently "npm start" "npm run dev"
```

## Step 5: Open in Browser 🌐

Navigate to: **http://localhost:3000**

You should see the Spartan Multi-Chain interface!

## Step 6: Test Basic Features ✨

1. **Authentication**: The app will authenticate via Farcaster Quick Auth
2. **Portfolio**: View your multi-chain portfolio
3. **Swap**: Try getting a quote (won't execute without wallet setup)
4. **Bridge**: Explore cross-chain options
5. **Social**: View your Farcaster feed
6. **AI Chat**: Chat with Spartan AI

## Troubleshooting 🔧

### Port Already in Use

If port 3000 or 3001 is already in use:

```bash
# Change ports in .env
PORT=3002

# Or in vite.config.ts for frontend
server: { port: 3005 }
```

### Authentication Failed

1. Check your Farcaster credentials in `.env`
2. Verify Neynar API key is valid
3. Ensure HOSTNAME matches your deployment URL

### Cannot Connect to ElizaOS

1. Verify ElizaOS is running: `curl http://localhost:3000/health`
2. Check `ELIZA_API_URL` in `.env`
3. Ensure required plugins are loaded

### Build Errors

```bash
# Clear cache and reinstall
rm -rf node_modules dist
npm install
npm run build
```

## Next Steps 🎯

### For Development:
1. **Add your wallet addresses** to `.env` for actual trading
2. **Set up proper private keys** (use secure key management)
3. **Configure custom RPC endpoints** for better reliability
4. **Add your Farcaster credentials** for social features

### For Production:
1. **Get a LiFi API key** for better swap rates
2. **Set up proper domain** and update `HOSTNAME`
3. **Configure HTTPS** with SSL certificates
4. **Set up monitoring** for API and blockchain calls
5. **Deploy to cloud** (Vercel, Railway, AWS, etc.)

### For Testing:
1. Use testnet configurations first
2. Start with small amounts
3. Test each feature thoroughly
4. Monitor transaction logs

## Quick Commands Reference 📝

```bash
# Development
npm run dev          # Start frontend dev server
npm start           # Start backend API
npm run build       # Build for production
npm run preview     # Preview production build

# Testing
npm test            # Run tests
npm run type-check  # TypeScript checking

# Maintenance
npm run lint        # Check code style
npm run format      # Format code
```

## Getting Help 💬

- **Documentation**: See [README.md](./README.md)
- **Issues**: Check GitHub issues
- **Discord**: Join our community
- **Twitter**: @SpartanDeFi

## Success Checklist ✅

- [ ] Dependencies installed
- [ ] Environment configured
- [ ] Backend server running (port 3001)
- [ ] Frontend server running (port 3000)
- [ ] App loads in browser
- [ ] Authentication works
- [ ] Portfolio displays
- [ ] Can get swap quotes
- [ ] AI chat responds

---

**You're all set!** Start trading across chains with Spartan Multi-Chain! 🛡️

