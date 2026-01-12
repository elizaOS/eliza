# MCP + A2A Service Starter

Create monetized AI agent services that can be discovered and used by both AI assistants (via MCP) and autonomous agents (via A2A).

## Features

- **MCP (Model Context Protocol)**: Expose tools and resources to AI assistants like Claude, ChatGPT, etc.
- **A2A (Agent-to-Agent)**: Enable discovery and interaction with autonomous agents
- **x402 Micropayments**: Monetize your service with crypto micropayments
- **ERC-8004 Registration**: Auto-register to the agent identity registry for discoverability
- **Cloud Deployment**: Deploy to elizaOS cloud with a single command

## Quick Start

```bash
# Create a new service
elizaos create --type service my-service

# Enter the directory
cd my-service

# Configure your service
cp env.example .env
# Edit .env with your settings

# Start development server
bun run dev

# Test your service
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/agent-card.json
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service information |
| `GET /health` | Health check |
| `GET /.well-known/agent-card.json` | A2A agent discovery |
| `POST /a2a` | A2A message endpoint |
| `POST /mcp/initialize` | MCP initialization |
| `POST /mcp/tools/list` | List MCP tools |
| `POST /mcp/tools/call` | Call MCP tool |
| `POST /mcp/resources/list` | List MCP resources |
| `POST /mcp/resources/read` | Read MCP resource |

## Adding Skills/Tools

### A2A Skills

Edit `src/a2a-server.ts` and add your skills to `getSkills()`:

```typescript
{
  id: 'my-skill',
  name: 'My Custom Skill',
  description: 'Does something awesome',
  tags: ['action', 'custom'],
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input value' },
    },
    required: ['input'],
  },
}
```

Then implement the handler in `executeSkill()`.

### MCP Tools

Edit `src/mcp-server.ts` and add your tools to `getTools()`:

```typescript
{
  name: 'my_tool',
  description: 'Does something awesome',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input value' },
    },
    required: ['input'],
  },
  tags: ['action'],
}
```

Then implement the handler in `callTool()`.

## Monetization with x402

To add paid features, set `requiresPayment: true` on your skill/tool and check for payment:

```typescript
case 'premium-action': {
  const cost = parseEther('0.001'); // 0.001 ETH
  
  if (!paymentHeader) {
    return {
      message: 'Payment required',
      data: { cost: formatEther(cost) },
      requiresPayment: createPaymentRequirement(
        '/a2a/premium-action',
        cost,
        'Premium action fee',
        {
          recipientAddress: config.paymentRecipient as `0x${string}`,
          network: 'base-sepolia',
          serviceName: config.serviceName,
        }
      ),
    };
  }
  
  // Payment verified - execute the action
  return {
    message: 'Premium action completed',
    data: { result: 'success' },
  };
}
```

## ERC-8004 Registration

Your service can auto-register to the ERC-8004 agent identity registry:

```bash
# Set AUTO_REGISTER=true in .env, or run manually:
bun run register
```

This makes your service discoverable by:
- The elizaOS miniapp marketplace
- Other autonomous agents
- Search and directory services

### Visibility Management

After registration, you can control your service's visibility:

```bash
# Make service public (discoverable in marketplace)
bun run publish

# Make service private (hidden from listings, still accessible via URL)
bun run unpublish

# Check current status
bun run status

# Or use the full management script
bun run manage --help
```

### Update Endpoints

When your service URL changes (e.g., after deployment), update the on-chain endpoints:

```bash
# Set SERVICE_URL in .env first, then:
bun run manage set-endpoints
```

### Set Marketplace Category

Categorize your service for better discoverability:

```bash
bun run manage set-category ai    # Options: ai, compute, storage, game, api, defi
```

### Configure x402 Payments

```bash
bun run manage enable-x402   # Enable payments
bun run manage disable-x402  # Disable payments
```

## Deployment

### Deploy to elizaOS Cloud

The service is fully configured for elizaOS cloud deployment:

```bash
# Login to elizaOS (if not already)
elizaos login

# Deploy to cloud
elizaos deploy

# Or with custom options
elizaos deploy --name my-service --port 3000
```

The deployment process:
1. Builds Docker image using the included Dockerfile
2. Pushes to elizaOS ECR registry
3. Deploys to AWS ECS with auto-scaling
4. Sets up load balancer with health checks at `/health`
5. Returns a public URL for your service
6. **Auto-registers to ERC-8004** with correct cloud URLs (if `PRIVATE_KEY` is set)

After deployment, your service will be automatically discoverable by AI assistants and agents.

**Required environment variables for cloud deployment:**
- `ELIZAOS_API_KEY` - Your elizaOS cloud API key (from elizaos.ai dashboard)
- `PRIVATE_KEY` - (Optional) For auto-registration to ERC-8004

### Deploy with Docker Locally

```bash
# Build the image
docker build -t my-service .

# Run locally
docker run -p 3000:3000 -e PORT=3000 my-service

# Or with docker-compose
docker compose up --build
```

### Health Check

The service exposes these health endpoints (required for cloud deployment):
- `GET /health` - Full health status with uptime
- `GET /healthz` - Simple health check
- `GET /ready` - Readiness probe

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `SERVICE_NAME` | Display name for your service | "My Service" |
| `SERVICE_DESCRIPTION` | Description shown in discovery | - |
| `PORT` | HTTP port | 3000 |
| `JEJU_NETWORK` | Network: localnet/testnet/mainnet | testnet |
| `PAYMENT_RECIPIENT` | Wallet address for x402 payments | - |
| `PRIVATE_KEY` | Key for ERC-8004 registration | - |
| `X402_ENABLED` | Enable x402 payments | true |
| `ERC8004_ENABLED` | Enable ERC-8004 registration | true |
| `AUTO_REGISTER` | Auto-register on startup | false |
| `AGENT_ID` | Agent ID after registration (e.g., 84532:123) | - |
| `SERVICE_PUBLIC` | Whether service is publicly discoverable | true |
| `SERVICE_CATEGORY` | Marketplace category | "service" |
| `SERVICE_URL` | Public URL for endpoints | - |

## Testing

```bash
# Run tests
bun test

# Test A2A endpoint
curl -X POST http://localhost:3000/a2a \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"message/send","params":{"message":{"messageId":"1","parts":[{"kind":"text","text":"What can you do?"}]}},"id":1}'

# Test MCP endpoint
curl -X POST http://localhost:3000/mcp/tools/call \
  -H "Content-Type: application/json" \
  -d '{"name":"echo","arguments":{"message":"Hello!"}}'
```

## License

MIT
