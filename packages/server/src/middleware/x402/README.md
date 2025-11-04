# x402 Payment Middleware for ElizaOS

The x402 payment middleware enables micropayment protection for plugin routes in ElizaOS. This allows plugin developers to monetize their API endpoints using blockchain-based payments.

## Features

- 🔐 **Payment Protection**: Require payment before executing route handlers
- 🌐 **Multi-Chain Support**: Base, Polygon, Solana
- 💰 **Flexible Pricing**: Set prices in cents (USD)
- ✅ **EIP-712 Signatures**: Support for gasless USDC transfers via ERC-3009
- 🔄 **Multiple Payment Methods**: Direct blockchain proofs or facilitator-based payments
- 📊 **x402scan Compatible**: Full compliance with x402scan protocol

## Quick Start

### 1. Register Custom Payment Configs (Optional)

If you want to accept payments in custom tokens or on new networks, register them in your plugin's `init()` function:

```typescript
import type { Plugin } from '@elizaos/core';
import { registerX402Config } from '@elizaos/server';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  
  init: async (config, runtime) => {
    // Register custom token on existing network
    registerX402Config('base_ai16z', {
      network: 'BASE',
      assetNamespace: 'erc20',
      assetReference: '0x...', // AI16Z token contract address
      paymentAddress: process.env.BASE_PUBLIC_KEY!,
      symbol: 'AI16Z',
      chainId: '8453'
    });
    
    // Register new network entirely
    registerX402Config('arbitrum_usdc', {
      network: 'ARBITRUM',
      assetNamespace: 'erc20',
      assetReference: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC on Arbitrum
      paymentAddress: process.env.ARBITRUM_PUBLIC_KEY!,
      symbol: 'USDC',
      chainId: '42161'
    });
    
    // Agent-specific override (different wallet for this agent)
    registerX402Config('base_usdc', {
      network: 'BASE',
      assetNamespace: 'erc20',
      assetReference: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      paymentAddress: process.env.MY_AGENT_WALLET!, // Agent-specific wallet
      symbol: 'USDC',
      chainId: '8453'
    }, { agentId: runtime.agentId }); // Agent-specific config
  },
  
  routes: [/* ... */]
};
```

**Built-in configs** (available without registration):
- `base_usdc` - USDC on Base
- `solana_usdc` - USDC on Solana  
- `polygon_usdc` - USDC on Polygon

### 2. Define a Payment-Protected Route

In your plugin, add an `x402` property to any route you want to protect:

```typescript
import type { Route } from '@elizaos/core';
import type { PaymentEnabledRoute } from '@elizaos/server';

export const routes: PaymentEnabledRoute[] = [
  {
    type: 'GET',
    path: '/api/analytics/trending',
    public: true,
    
    // Payment configuration
    x402: {
      priceInCents: 10,  // $0.10
      paymentConfigs: ['base_usdc', 'solana_usdc']
    },
    
    // Optional: OpenAPI documentation
    description: 'Get trending tokens with payment protection',
    openapi: {
      parameters: [
        {
          name: 'timeframe',
          in: 'query',
          required: false,
          description: 'Time period for trending analysis',
          schema: {
            type: 'string',
            enum: ['1h', '6h', '24h', '7d', '30d']
          }
        }
      ]
    },
    
    handler: async (req, res, runtime) => {
      // Your handler logic here
      const { timeframe = '24h' } = req.query;
      
      res.json({
        success: true,
        data: {
          timeframe,
          tokens: []
        }
      });
    }
  }
];
```

### 2. Automatic Payment Protection

The x402 middleware is automatically applied to all plugin routes that have an `x402` property. **No additional setup required!**

When a request comes in without payment:
- Returns HTTP 402 Payment Required
- Includes payment options in x402scan-compliant format
- Shows accepted payment methods and networks

When payment is provided:
- Verifies the payment proof
- Executes your handler if payment is valid
- Returns error if payment is invalid

## Payment Configuration

### Available Payment Configs

**Built-in configs:**
```typescript
'base_usdc'      // USDC on Base (ERC-20)
'solana_usdc'    // USDC on Solana (SPL Token)
'polygon_usdc'   // USDC on Polygon (ERC-20)
```

**Custom configs:**
Register your own via `registerX402Config()` in plugin `init()`:

```typescript
import { registerX402Config } from '@elizaos/server';

// Custom token on existing network
registerX402Config('base_ai16z', {
  network: 'BASE',
  assetNamespace: 'erc20',
  assetReference: '0x...', // Token contract address
  paymentAddress: process.env.BASE_PUBLIC_KEY!,
  symbol: 'AI16Z',
  chainId: '8453'
});

// New network
registerX402Config('arbitrum_usdc', {
  network: 'ARBITRUM',
  assetNamespace: 'erc20',
  assetReference: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  paymentAddress: process.env.ARBITRUM_PUBLIC_KEY!,
  symbol: 'USDC',
  chainId: '42161'
});

// Then use in your routes:
x402: {
  priceInCents: 50,
  paymentConfigs: ['base_ai16z', 'arbitrum_usdc'] // Custom configs
}
```

### Price Configuration

Set `priceInCents` to define the cost in USD cents:

```typescript
x402: {
  priceInCents: 10,  // $0.10
  paymentConfigs: ['base_usdc']
}
```

## Payment Methods

### Method 1: Direct Blockchain Proof

Clients send a payment proof in the `X-Payment-Proof` header:

```bash
curl -H "X-Payment-Proof: <base64-encoded-proof>" \
  https://api.example.com/api/analytics/trending
```

**Supported Proof Formats:**

1. **EIP-712 Signature (Base/Polygon)**
```json
{
  "signature": "0x...",
  "authorization": {
    "from": "0x...",
    "to": "0x...",
    "value": "100000",
    "validAfter": "0",
    "validBefore": "1234567890",
    "nonce": "0x..."
  },
  "domain": {
    "name": "USD Coin",
    "version": "2",
    "chainId": 8453,
    "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  }
}
```

2. **Solana Transaction Signature**
```
<transaction-signature>
```

### Method 2: Facilitator Payment

Use a payment facilitator service and send the payment ID:

```bash
curl -H "X-Payment-Id: <payment-id>" \
  https://api.example.com/api/analytics/trending
```

## Environment Variables

Configure payment settings via environment variables:

```bash
# Payment Addresses (where payments are sent)
BASE_PUBLIC_KEY=0x...
SOLANA_PUBLIC_KEY=...
POLYGON_PUBLIC_KEY=0x...

# Payment Facilitator
X402_FACILITATOR_URL=https://x402.elizaos.ai/api/facilitator

# Base URL for x402scan listings
X402_BASE_URL=https://api.example.com

# RPC Endpoints (optional, uses public RPCs by default)
BASE_RPC_URL=https://mainnet.base.org
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
POLYGON_RPC_URL=https://polygon-rpc.com

# Debug
DEBUG_X402_PAYMENTS=true  # Enable detailed payment logs

# Gateway Trust (for x402 gateways)
X402_TRUSTED_GATEWAY_SIGNERS=0x...  # Comma-separated list of trusted signers
```

## Advanced Features

### Agent-Specific Payment Configs

You can override payment configs per agent (e.g., different wallets for different agents):

```typescript
import { registerX402Config } from '@elizaos/server';

init: async (config, runtime) => {
  // Global config - applies to all agents
  registerX402Config('base_usdc', {
    network: 'BASE',
    assetNamespace: 'erc20',
    assetReference: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    paymentAddress: '0xGLOBAL_WALLET...',
    symbol: 'USDC',
    chainId: '8453'
  });
  
  // Agent-specific override - only for this agent
  registerX402Config('base_usdc', {
    network: 'BASE',
    assetNamespace: 'erc20',
    assetReference: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    paymentAddress: process.env.AGENT_SPECIFIC_WALLET!, // Different wallet
    symbol: 'USDC',
    chainId: '8453'
  }, { agentId: runtime.agentId });
  
  // When this agent's routes use 'base_usdc', 
  // payments go to AGENT_SPECIFIC_WALLET instead of GLOBAL_WALLET
}
```

### Querying Available Configs

```typescript
import { listX402Configs } from '@elizaos/server';

// List all available configs
const allConfigs = listX402Configs();
// ['base_usdc', 'solana_usdc', 'polygon_usdc', 'base_ai16z', ...]

// List configs for specific agent (includes agent overrides)
const agentConfigs = listX402Configs(runtime.agentId);
// ['base_usdc', 'solana_usdc', ...] with agent-specific versions
```

### Request Validation

Add a validator to check request parameters BEFORE charging for payment:

```typescript
{
  type: 'POST',
  path: '/api/analytics/analyze',
  x402: {
    priceInCents: 50
  },
  validator: (req) => {
    const { tokenMint } = req.body || {};
    if (!tokenMint) {
      return {
        valid: false,
        error: {
          status: 400,
          message: 'tokenMint is required'
        }
      };
    }
    return { valid: true };
  },
  handler: async (req, res, runtime) => {
    // Handler only runs if validation passes AND payment is valid
  }
}
```

### OpenAPI Documentation

Add OpenAPI specs for better x402scan integration:

```typescript
{
  openapi: {
    parameters: [
      {
        name: 'wallet',
        in: 'path',
        required: true,
        description: 'Wallet address to query',
        schema: {
          type: 'string',
          pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        }
      }
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['tokenMint'],
            properties: {
              tokenMint: {
                type: 'string',
                description: 'Token mint address'
              }
            }
          }
        }
      }
    }
  }
}
```

## Example 402 Response

When no payment is provided, the middleware returns:

```json
{
  "x402Version": 1,
  "error": "Payment Required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "10",
      "resource": "https://api.example.com/api/analytics/trending",
      "description": "Get trending tokens",
      "mimeType": "application/json",
      "payTo": "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
      "maxTimeoutSeconds": 300,
      "asset": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "outputSchema": {
        "input": {
          "type": "http",
          "method": "GET",
          "headerFields": {
            "X-Payment-Proof": {
              "type": "string",
              "required": true,
              "description": "Payment proof token"
            }
          }
        },
        "output": {
          "type": "object",
          "description": "API response data"
        }
      }
    }
  ]
}
```

## How Payment Verification Works

1. **Request arrives** without payment credentials
2. **402 Response** is sent with payment options
3. **Client makes payment** on-chain or via facilitator
4. **Client retries** with `X-Payment-Proof` or `X-Payment-Id` header
5. **Middleware verifies** payment proof:
   - For blockchain proofs: Verifies signature cryptographically
   - For facilitator: Calls facilitator API to verify payment ID
6. **Handler executes** if payment is valid
7. **Response sent** to client

## Security Considerations

### Production Safety
- **Private Keys**: Never store private keys in code. Use environment variables.
- **Signature Verification**: All signatures are cryptographically verified. No bypass options.
- **Replay Protection**: Each payment can only be used once. Nonces prevent replay attacks.
- **Gateway Trust**: Only add trusted signers to `X402_TRUSTED_GATEWAY_SIGNERS`.

### Input Validation
- ✅ All payment proofs are sanitized and validated before processing
- ✅ Payment IDs limited to alphanumeric + hyphens/underscores (max 128 chars)
- ✅ Payment proofs limited to 10KB to prevent DoS
- ✅ Solana signatures validated for base58 format (87-88 chars)
- ✅ All amounts, recipients, and timestamps validated

### Type Safety
- ✅ No `any` types - full TypeScript type safety
- ✅ Strict interfaces for all payment data structures
- ✅ Type guards for runtime validation
- ✅ Compile-time error prevention

### Security Features
- **Full Type Safety**: No `any` types, strict TypeScript interfaces throughout
- **Input Sanitization**: All payment proofs validated and sanitized before processing
- **Transaction Verification**: Full on-chain verification for EVM transactions
- **Test Coverage**: 48 comprehensive tests validating all security aspects

## Testing

### Run Test Suite
```bash
cd packages/server
bun test src/middleware/x402/__tests__/
```

**51 comprehensive tests** covering:
- Input sanitization
- Security bypass restrictions  
- EIP-712 validation
- Amount/recipient verification
- Config registry
- Error handling

### Debug Logging
Enable debug logging to see payment verification details:

```bash
DEBUG_X402_PAYMENTS=true bun run start
```

### Development Testing
For development testing, use test wallets with small amounts:

```bash
# Use testnet or small amounts for development
BASE_PUBLIC_KEY=0xYourTestWallet
SOLANA_PUBLIC_KEY=YourTestWallet
DEBUG_X402_PAYMENTS=true bun run start
```

## Integration with x402scan

Routes with x402 protection are automatically compatible with x402scan indexing services. The middleware generates compliant 402 responses that x402scan can parse and index.

## Troubleshooting

### Payment verification fails
- Check payment address matches your configured address
- Verify the payment amount is sufficient
- Ensure signature is from the correct signer
- Check RPC endpoint is working

### 402 response missing payment options
- Verify `x402.priceInCents` is set and > 0
- Check `paymentConfigs` array is not empty
- Ensure payment config names are valid

### Route not protected
- Confirm `x402` property is present on route
- Check route is registered with plugin
- Verify server build completed successfully

## Support

For issues or questions:
- GitHub Issues: https://github.com/elizaos/eliza/issues
- Discord: https://discord.gg/elizaos

