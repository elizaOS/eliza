# @elizaos/plugin-acp

Agent Client Protocol (ACP) plugin for elizaOS. Enables IDE integration and gateway bridging via the ACP protocol.

## Overview

This plugin provides Agent Client Protocol (ACP) support for elizaOS, allowing AI agents to integrate with IDEs and other clients that implement the ACP specification.

## Installation

```bash
pnpm add @elizaos/plugin-acp
```

## Features

- **ACP Server**: Stdio-based ACP server for IDE integration
- **Session Management**: In-memory session storage with support for multiple concurrent sessions
- **Gateway Bridge**: Translation layer between ACP protocol and gateway events
- **Runtime Service**: Integrates with elizaOS runtime via `runtime.getService<ACPService>()`

## Usage

### Register the Plugin

```typescript
import { acpPlugin } from '@elizaos/plugin-acp';

// In your agent configuration
const agent = {
  plugins: [acpPlugin],
  // ... other configuration
};
```

### Use the Service

```typescript
import { 
  ACPService, 
  ACP_SERVICE_TYPE,
  getACPService 
} from '@elizaos/plugin-acp';

// Get service from runtime
const service = runtime.getService<ACPService>(ACP_SERVICE_TYPE);

// Or use the helper function
const service = getACPService(runtime);

// Start the ACP server
service?.startServer({
  gatewayUrl: 'ws://localhost:18789',
  verbose: true,
});
```

### Standalone Usage (CLI)

```typescript
import { serveAcpGateway } from '@elizaos/plugin-acp';

// Start ACP server without runtime
serveAcpGateway({
  gatewayUrl: 'ws://localhost:18789',
  verbose: true,
});
```

### Configuration

The plugin can be configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `ACP_GATEWAY_URL` | Gateway WebSocket URL | `ws://127.0.0.1:18789` |
| `ACP_GATEWAY_TOKEN` | Gateway authentication token | - |
| `ACP_GATEWAY_PASSWORD` | Gateway password | - |
| `ACP_DEFAULT_SESSION_KEY` | Default session key | - |
| `ACP_DEFAULT_SESSION_LABEL` | Default session label | - |
| `ACP_REQUIRE_EXISTING` | Require existing sessions | `false` |
| `ACP_RESET_SESSION` | Reset sessions on first use | `false` |
| `ACP_PREFIX_CWD` | Prefix prompts with working directory | `true` |
| `ACP_VERBOSE` | Enable verbose logging | `false` |

## API Reference

### ACPService

The main service class that provides ACP functionality.

```typescript
class ACPService extends Service {
  static serviceType = "acp";
  
  // Start the ACP server
  startServer(opts?: AcpServerOptions): void;
  
  // Check if server is running
  isServerRunning(): boolean;
  
  // Get session store
  getSessionStore(): AcpSessionStore;
  
  // Get/update configuration
  getConfig(): ACPServiceConfig;
  updateConfig(config: Partial<ACPServiceConfig>): void;
  
  // Create custom agents and clients
  createAgent(connection, gateway, opts?): AcpGatewayAgent;
  createGatewayClient(url, callbacks?): GatewayClient;
}
```

### Helper Functions

```typescript
// Get service from runtime
function getACPService(runtime: IAgentRuntime): ACPService | null;

// Start ACP server via runtime
function startAcpServer(runtime: IAgentRuntime, opts?): boolean;

// Standalone server (no runtime)
function serveAcpGateway(opts?: AcpServerOptions): void;
```

### Client Functions

```typescript
// Create an ACP client
async function createAcpClient(opts?: AcpClientOptions): Promise<AcpClientHandle>;

// Run interactive client session
async function runAcpClientInteractive(opts?: AcpClientOptions): Promise<void>;
```

## License

MIT
