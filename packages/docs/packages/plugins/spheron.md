# Spheron Protocol Plugin for Eliza

This plugin integrates the Spheron Protocol SDK into the Eliza ecosystem, providing functionality for managing deployments, escrow operations, and lease management.

## Features

- **Escrow Operations**: Manage token deposits, withdrawals, and balance checks
- **Deployment Management**: Create, update, and manage deployments using ICL YAML

## Installation

```bash
npm install @elizaos/plugin-spheron
```

## Configuration

The plugin requires the following environment variables:

```env
PRIVATE_KEY=your_private_key
PROVIDER_PROXY_URL=your_provider_proxy_url
WALLET_ADDRESS=your_wallet_address
```

## Usage

1. Import and register the plugin:

```typescript
import { spheronPlugin } from "@elizaos/plugin-spheron";

// Register with Eliza
eliza.registerPlugin(spheronPlugin);
```

2. Available Actions:

- `ESCROW_OPERATION`: Handle token deposits and withdrawals
- `DEPLOYMENT_OPERATION`: Manage service deployments

## Examples

### Escrow Operations

```typescript
// Deposit tokens
await runtime.executeAction("ESCROW_OPERATION", {
    token: "USDT",
    amount: 100,
    operation: "deposit",
});

// Withdraw tokens
await runtime.executeAction("ESCROW_OPERATION", {
    token: "USDC",
    amount: 50,
    operation: "withdraw",
});
```

### Deployment Operations

```typescript
// Create deployment
await runtime.executeAction("DEPLOYMENT_OPERATION", {
    operation: "create",
    template: "jupyter-notebook",
    customizations: {
        cpu: false,
        resources: {
            cpu: "4",
            memory: "8Gi",
            storage: "10Gi",
            gpu: "1",
            gpu_model: "rtx4090",
        },
        duration: "1h",
        token: "USDT",
    },
});

// Update deployment
await runtime.executeAction("DEPLOYMENT_OPERATION", {
    operation: "update",
    leaseId: "your_lease_id",
    template: "jupyter-notebook",
    customizations: {
        cpu: false,
        resources: {
            cpu: "4",
            memory: "8Gi",
            storage: "10Gi",
            gpu: "1",
            gpu_model: "rtx4090",
        },
        duration: "1h",
        token: "USDT",
    },
});

// Close deployment
await runtime.executeAction("DEPLOYMENT_OPERATION", {
    operation: "close",
    leaseId: "your_lease_id",
});
```

## Supported Templates

- jupyter-notebook: Jupyter Notebook with or without Pytorch
- vscode: VSCode with or without Pytorch
- ollama: Ollama WebUI and API
- heurist-miner: Heurist Miner for mining heurist network

## How it Works

1. You can ask the eliza to deploy a template like `jupyter-notebook`, `vscode`, `ollama`, or `heurist-miner` for you with just natural language.
2. You can also customize the deployment with natural language.
3. You can also ask the eliza to close the deployment.
4. You can also ask the eliza to check the balance of your account.
5. You can also ask the eliza to deposit or withdraw tokens from your account.

## Development

1. Install dependencies:

```bash
npm install
```

2. Build the plugin:

```bash
npm run build
```

3. Run tests:

```bash
npm test
```

## License

This plugin is part of the Eliza project. See the main project repository for license information.
