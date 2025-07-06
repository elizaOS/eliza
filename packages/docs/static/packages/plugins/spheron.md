# Spheron Protocol Plugin for Eliza

## Purpose

This plugin integrates the Spheron Protocol SDK into the Eliza ecosystem, providing functionality for managing deployments, escrow operations, and lease management.

## Key Features

- **Escrow Operations**: Manage token deposits, withdrawals, and balance checks
- **Deployment Management**: Create, update, and manage deployments using ICL YAML

## Installation

```bash
bun install @elizaos/plugin-spheron
```

## Configuration

The plugin requires the following environment variables:

```env
PRIVATE_KEY=your_private_key
PROVIDER_PROXY_URL=your_provider_proxy_url
WALLET_ADDRESS=your_wallet_address
```

## Integration

Import and register the plugin with Eliza:

```typescript
import { spheronPlugin } from '@elizaos/plugin-spheron';
eliza.registerPlugin(spheronPlugin);
```

## Example Usage

### Escrow Operations:

```typescript
// Deposit tokens
await runtime.executeAction('ESCROW_OPERATION', {
  token: 'USDT',
  amount: 100,
  operation: 'deposit',
});
```

### Deployment Operations:

```typescript
// Create deployment
await runtime.executeAction('DEPLOYMENT_OPERATION', {
  operation: 'create',
  template: 'jupyter-notebook',
  customizations: {
    cpu: false,
    resources: {
      cpu: '4',
      memory: '8Gi',
      storage: '10Gi',
      gpu: '1',
      gpu_model: 'rtx4090',
    },
    duration: '1h',
    token: 'USDT',
  },
});
```
