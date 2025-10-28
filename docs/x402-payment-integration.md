# x402 Payment Integration

The ElizaOS server supports optional payment requirements for API endpoints using the [x402 protocol](https://docs.cdp.coinbase.com/x402/). This enables you to charge for access to your agent's capabilities using cryptocurrency.

## Overview

The x402 middleware adds payment requirements to API routes. When enabled:

1. Unpaid requests receive a `402 Payment Required` response with payment instructions
2. Clients complete the payment and include proof in the `X-PAYMENT` header
3. The middleware verifies the payment and allows the request through

## Authentication Modes

The x402 middleware works alongside existing API key authentication:

| Configuration                 | Behavior                                          |
| ----------------------------- | ------------------------------------------------- |
| **Both enabled**              | Requires BOTH `X-API-KEY` AND `X-PAYMENT` headers |
| **Only API key** (x402=false) | Requires only `X-API-KEY` header                  |
| **Only x402** (no API token)  | Requires only `X-PAYMENT` header                  |
| **Neither enabled**           | No authentication required                        |

## Configuration

All x402 settings are configured via environment variables:

### Required (when enabled)

- **`X402_WALLET_ADDRESS`**: Your EVM-compatible wallet address to receive payments
  - Example: `0x1234567890123456789012345678901234567890`
  - Must start with `0x`

### Optional

- **`X402_ENABLED`**: Enable/disable payment middleware (default: `false`)
  - Set to `"true"` to enable
- **`X402_PRICE`**: Default price in USDC (default: `"$0.01"`)
  - Example: `"$0.001"` for one-tenth of a cent
  - Example: `"$1.00"` for one dollar
- **`X402_NETWORK`**: Blockchain network (default: `"base-sepolia"`)
  - Testnet: `"base-sepolia"` or `"solana-devnet"`
  - Mainnet: `"base"` or `"solana"`
  - Other supported networks: `"polygon"`, `"avalanche"`, `"sei"`, etc.
- **`X402_FACILITATOR_URL`**: Facilitator service URL (default: `"https://x402.org/facilitator"`)
  - Only used for testnet (when `X402_USE_MAINNET` is `false`)
- **`X402_USE_MAINNET`**: Use CDP facilitator for mainnet (default: `false`)
  - Set to `"true"` for production/mainnet
  - Requires `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`

### Mainnet-only (required when `X402_USE_MAINNET=true`)

- **`CDP_API_KEY_ID`**: Your Coinbase Developer Platform API key ID
- **`CDP_API_KEY_SECRET`**: Your Coinbase Developer Platform API key secret

Get your CDP API keys at [cdp.coinbase.com](https://cdp.coinbase.com)

### Endpoint Metadata (Optional - for Bazaar Discovery)

These allow you to customize the endpoint metadata exposed to x402 Bazaar for service discovery:

- **`X402_JOBS_ENDPOINT_DESCRIPTION`**: Custom description for the `/jobs` endpoint
  - Example: `"Premium AI agent with specialized knowledge in finance"`
  - If not set, uses sensible default
- **`X402_JOBS_INPUT_SCHEMA`**: JSON string defining the input schema
  - Must be a valid JSON schema object
  - Example: `'{"type":"object","properties":{"userId":{"type":"string","format":"uuid"},"content":{"type":"string"}},"required":["userId","content"]}'`
  - If not set, uses default schema with all job parameters
- **`X402_JOBS_OUTPUT_SCHEMA`**: JSON string defining the output schema
  - Must be a valid JSON schema object
  - Example: `'{"type":"object","properties":{"jobId":{"type":"string"},"status":{"type":"string"}}}'`
  - If not set, uses default schema with job response structure

**Note**: These are primarily for customizing how your endpoint appears in x402 discovery services like Bazaar. Most users can leave these unset to use the sensible defaults.

## Example Configurations

### Testnet (Development)

```env
# Enable x402 for testing
X402_ENABLED=true
X402_WALLET_ADDRESS=0x1234567890123456789012345678901234567890
X402_PRICE=$0.001
X402_NETWORK=base-sepolia
# X402_FACILITATOR_URL defaults to https://x402.org/facilitator
```

### Mainnet (Production)

```env
# Enable x402 for production
X402_ENABLED=true
X402_WALLET_ADDRESS=0x1234567890123456789012345678901234567890
X402_PRICE=$0.10
X402_NETWORK=base
X402_USE_MAINNET=true

# CDP credentials for mainnet facilitator
CDP_API_KEY_ID=your-api-key-id
CDP_API_KEY_SECRET=your-api-key-secret
```

### Both API Key and x402 (Dual Auth)

```env
# Require both API key AND payment
ELIZA_SERVER_AUTH_TOKEN=your-secret-api-key
X402_ENABLED=true
X402_WALLET_ADDRESS=0x1234567890123456789012345678901234567890
X402_PRICE=$0.01
X402_NETWORK=base-sepolia
```

### Custom Endpoint Metadata for Bazaar Discovery

```env
# Enable x402 with custom metadata
X402_ENABLED=true
X402_WALLET_ADDRESS=0x1234567890123456789012345678901234567890
X402_PRICE=$0.05
X402_NETWORK=base

# Customize how your endpoint appears in Bazaar
X402_JOBS_ENDPOINT_DESCRIPTION="Premium AI agent specializing in financial analysis and market insights"

# Custom simplified input schema (optional - most users can skip this)
X402_JOBS_INPUT_SCHEMA='{"type":"object","properties":{"content":{"type":"string","description":"Your question or request"}},"required":["content"]}'

# Custom output schema (optional - most users can skip this)
X402_JOBS_OUTPUT_SCHEMA='{"type":"object","properties":{"response":{"type":"string","description":"AI agent response"}}}'
```

**Note**: The input/output schemas are advanced options. The defaults work well for most use cases.

## Protected Endpoints

Currently, the following endpoints support x402 payments:

### POST `/api/messaging/jobs`

Create a one-off job to send a message to an AI agent.

- **Default Price**: Configured via `X402_PRICE` (default: `$0.01`)
- **Description**: Send a message to an AI agent and receive a response
- **Metadata**: Full JSON schemas provided for x402 Bazaar discovery

## Testing Your Integration

### 1. Start with Testnet

Always test on testnet first:

```bash
# Set up testnet configuration
echo "X402_ENABLED=true" >> .env
echo "X402_WALLET_ADDRESS=0xYourWalletAddress" >> .env
echo "X402_PRICE=\$0.001" >> .env
echo "X402_NETWORK=base-sepolia" >> .env

# Start the server
bun run start
```

### 2. Make an Unpaid Request

```bash
curl -X POST http://localhost:3000/api/messaging/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "content": "Hello, agent!"
  }'
```

You should receive a `402 Payment Required` response with payment instructions.

### 3. Complete Payment

Use a compatible client SDK or wallet to:

1. Parse the payment instructions
2. Sign and submit the payment transaction
3. Include the payment proof in the `X-PAYMENT` header
4. Retry the request

See the [x402 Quickstart for Buyers](https://docs.cdp.coinbase.com/x402/quickstart-for-buyers) for client-side implementation.

## Disabling x402

To disable payment requirements:

```bash
# Remove from .env or set to false
X402_ENABLED=false
```

Or simply don't set `X402_ENABLED` (defaults to disabled).

## API Key Bypass

**Important**: If you have `ELIZA_SERVER_AUTH_TOKEN` configured and a valid `X-API-KEY` header is provided in the request, **payment verification is skipped entirely**.

This means:

- Users with a valid API key don't need to pay
- x402 payment is only required for requests without a valid API key
- You can offer both paid (public) and free (API key holders) access

### Example Flow

1. **With valid API key** → Request proceeds without payment

```bash
curl -H "X-API-KEY: your-api-key" http://localhost:3000/api/messaging/jobs
# ✓ Skips payment, processes immediately
```

2. **Without API key** → Payment required

```bash
curl http://localhost:3000/api/messaging/jobs
# 402 Payment Required
```

This allows you to:

- Give free access to trusted partners via API keys
- Charge the general public via x402
- Monetize your AI agent while maintaining B2B relationships

## Security Considerations

1. **Wallet Security**: Keep your wallet's private key secure and separate from the server
2. **API Keys**: Never commit CDP API keys or ELIZA_SERVER_AUTH_TOKEN to version control
3. **Rate Limiting**: x402 works alongside existing rate limiting
4. **Authentication Priority**: API key authentication takes precedence over payment verification

## Resources

- [x402 Protocol Documentation](https://docs.cdp.coinbase.com/x402/)
- [x402 Quickstart for Sellers](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers)
- [x402 Quickstart for Buyers](https://docs.cdp.coinbase.com/x402/quickstart-for-buyers)
- [Coinbase Developer Platform](https://cdp.coinbase.com)
- [x402 Bazaar Discovery](https://docs.cdp.coinbase.com/x402/bazaar)
