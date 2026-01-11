# @elizaos/plugin-blockrun

Pay-per-request AI for ElizaOS agents via x402 micropayments on Base.

## Overview

This plugin enables ElizaOS agents to make LLM API calls using the [x402 protocol](https://x402.org), paying with USDC micropayments on Base chain. No API keys required - just a wallet with USDC.

**Supported Models:**
- OpenAI: gpt-4o, gpt-4o-mini
- Anthropic: claude-sonnet-4, claude-3.5-haiku
- Google: gemini-2.0-flash
- And more via BlockRun gateway

## Installation

```bash
pnpm add @elizaos/plugin-blockrun
```

## Configuration

Set your Base chain wallet private key:

```env
BASE_CHAIN_WALLET_KEY=0x...
```

Or in agent settings:

```typescript
const agent = new Agent({
  plugins: [blockrunPlugin],
  settings: {
    BASE_CHAIN_WALLET_KEY: '0x...',
  },
});
```

## Usage

### Plugin Registration

```typescript
import { blockrunPlugin } from '@elizaos/plugin-blockrun';

const agent = new Agent({
  plugins: [blockrunPlugin],
});
```

### Available Actions

#### BLOCKRUN_CHAT

Make a pay-per-request AI call:

```typescript
// The action is triggered when the agent needs to query an AI model
// Payments are handled automatically via x402
```

### Available Providers

#### BLOCKRUN_WALLET

Provides wallet context to the agent:

```typescript
// Returns wallet address and USDC balance on Base
// Useful for agents to understand their payment capacity
```

## How It Works

1. Agent makes an AI request via BLOCKRUN_CHAT action
2. BlockRun gateway returns 402 Payment Required with price
3. Plugin automatically signs USDC payment (EIP-712)
4. Request is retried with payment signature
5. AI response is returned to the agent

All payments use USDC on Base chain. Typical cost: $0.001-0.01 per request.

## Links

- [BlockRun](https://blockrun.ai) - Pay-per-request AI gateway
- [x402 Protocol](https://x402.org) - HTTP 402 micropayment standard
- [ElizaOS](https://elizaos.ai) - AI agent framework

## License

MIT
