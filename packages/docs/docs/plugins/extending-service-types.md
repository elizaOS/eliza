# Extending Service Types

The Eliza runtime allows plugins to extend the core service types through TypeScript module augmentation. This provides full type safety while allowing plugins to register their own custom services.

## How to Extend Service Types

### 1. In your plugin's type definitions

Create a type declaration file (e.g., `types.ts`) in your plugin:

```typescript
// In your plugin's types.ts or index.ts
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    // Add your custom service types here
    BLOCKCHAIN: 'blockchain';
    WEATHER: 'weather';
    NOTIFICATION: 'notification';
    CUSTOM_AI: 'custom_ai';
  }
}

// Export your service type constants for use in your plugin
export const MyPluginServiceType = {
  BLOCKCHAIN: 'blockchain' as const,
  WEATHER: 'weather' as const,
  NOTIFICATION: 'notification' as const,
  CUSTOM_AI: 'custom_ai' as const,
} satisfies Partial<import('@elizaos/core').ServiceTypeRegistry>;
```

### 2. Implement your service class

```typescript
import { Service, type IAgentRuntime } from '@elizaos/core';
import { MyPluginServiceType } from './types';

export class BlockchainService extends Service {
  static serviceType = MyPluginServiceType.BLOCKCHAIN;
  capabilityDescription = 'Provides blockchain interaction capabilities';

  static async start(runtime: IAgentRuntime): Promise<BlockchainService> {
    const service = new BlockchainService(runtime);
    // Initialize your service
    return service;
  }

  async stop(): Promise<void> {
    // Cleanup logic
  }

  // Your service implementation
  async getBalance(address: string): Promise<string> {
    // Implementation
    return '0';
  }
}
```

### 3. Register the service in your plugin

```typescript
import { type Plugin } from '@elizaos/core';
import { BlockchainService } from './services/blockchain';
import './types'; // Ensure module augmentation is loaded

export const myPlugin: Plugin = {
  name: 'my-blockchain-plugin',
  description: 'Adds blockchain capabilities',
  services: [BlockchainService],
  // ... other plugin properties
};

export * from './types';
export * from './services/blockchain';
```

### 4. Use the service with full type safety

```typescript
// In your actions, evaluators, or other plugin code
const blockchainService = runtime.getService<BlockchainService>(MyPluginServiceType.BLOCKCHAIN);
if (blockchainService) {
  const balance = await blockchainService.getBalance('0x...');
}
```

## Benefits

1. **Full Type Safety**: TypeScript will provide autocomplete and type checking for your custom service types
2. **IDE Support**: Your IDE will show your custom service types in autocomplete
3. **Runtime Safety**: The runtime will properly handle your custom services
4. **No Conflicts**: Multiple plugins can extend service types without conflicts

## Example: Complete Plugin Structure

```
my-plugin/
├── src/
│   ├── types.ts          # Service type extensions
│   │   └── weather.ts    # Service implementation
│   ├── actions/
│   │   └── getWeather.ts # Actions using the service
│   └── index.ts          # Plugin definition
└── package.json
```

## Runtime Behavior

- Services are registered during plugin initialization
- The runtime maintains a `Map<ServiceTypeName, Service>` of all registered services
- `runtime.getService()` provides type-safe access to any registered service
- Services can be accessed by any part of the runtime (actions, evaluators, providers, etc.)

This approach ensures that your plugin's service types are fully integrated into the Eliza type system while maintaining clean separation between core and plugin functionality.
