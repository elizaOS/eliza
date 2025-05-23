# Service Registration Pattern

This document describes the complete service registration pattern in Eliza, providing type safety and automatic type inference.

## Core Concepts

1. **Service Type Registry**: A global registry of service types that can be extended by plugins
2. **Type-Safe Registration**: Services are registered with full type safety
3. **Automatic Type Inference**: The runtime can infer service types from registration

## Creating Services

### Method 1: Using Service Builder

The service builder provides a fluent API for creating services:

```typescript
import { createService, ServiceType } from '@elizaos/core';

// Define your service interface
interface MyCustomService extends Service {
  doSomething(): Promise<string>;
}

// Create the service using the builder
const MyServiceClass = createService<MyCustomService>('my_custom_service')
  .withDescription('My custom service')
  .withStart(async (runtime) => {
    const service = new MyServiceImpl(runtime);
    await service.initialize();
    return service;
  })
  .withStop(async () => {
    // Cleanup logic
  })
  .build();

// Implementation
class MyServiceImpl extends Service implements MyCustomService {
  async doSomething(): Promise<string> {
    return 'Hello from custom service!';
  }

  async stop(): Promise<void> {
    // Cleanup
  }
}
```

### Method 2: Using defineService Helper

For simpler cases, use the `defineService` helper:

```typescript
import { defineService, type ServiceDefinition } from '@elizaos/core';

const weatherServiceDef: ServiceDefinition<WeatherService> = {
  serviceType: 'weather',
  description: 'Provides weather information',
  start: async (runtime) => {
    return new WeatherService(runtime);
  },
  stop: async () => {
    console.log('Weather service stopped');
  },
};

export const WeatherServiceClass = defineService(weatherServiceDef);
```

### Method 3: Traditional Class Definition

You can still use the traditional approach:

```typescript
export class TraditionalService extends Service {
  static serviceType = 'traditional' as const;
  capabilityDescription = 'Traditional service';

  static async start(runtime: IAgentRuntime): Promise<TraditionalService> {
    return new TraditionalService(runtime);
  }

  async stop(): Promise<void> {
    // Cleanup
  }
}
```

## Extending Service Types

### 1. Declare Module Augmentation

```typescript
// In your plugin's types.ts
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    WEATHER: 'weather';
    BLOCKCHAIN: 'blockchain';
    ANALYTICS: 'analytics';
  }

  // Optional: Map service types to their classes for better type inference
  interface ServiceClassMap {
    weather: typeof WeatherService;
    blockchain: typeof BlockchainService;
    analytics: typeof AnalyticsService;
  }
}
```

### 2. Export Service Type Constants

```typescript
export const PluginServiceTypes = {
  WEATHER: 'weather',
  BLOCKCHAIN: 'blockchain',
  ANALYTICS: 'analytics',
} as const satisfies Partial<ServiceTypeRegistry>;
```

## Using Services

### Type-Safe Service Access

```typescript
// Method 1: Generic type parameter
const weatherService = runtime.getService<WeatherService>('weather');

// Method 2: Type-safe getter
const typedService = runtime.getTypedService<WeatherService>('weather');

// Method 3: Check if service exists
if (runtime.hasService('weather')) {
  const service = runtime.getService<WeatherService>('weather');
  // Use service
}

// Method 4: Get all registered services
const registeredTypes = runtime.getRegisteredServiceTypes();
console.log('Available services:', registeredTypes);
```

### In Actions and Evaluators

```typescript
export const getWeatherAction: Action = {
  name: 'GET_WEATHER',
  description: 'Get weather information',
  handler: async (runtime, message, state) => {
    const weatherService = runtime.getService<WeatherService>('weather');

    if (!weatherService) {
      throw new Error('Weather service not available');
    }

    const location = state.values.location || 'New York';
    const weather = await weatherService.getCurrentWeather(location);

    return {
      text: `The weather in ${location} is ${weather.condition} with a temperature of ${weather.temperature}°C`,
    };
  },
  validate: async (runtime) => {
    return runtime.hasService('weather');
  },
};
```

## Complete Plugin Example

```typescript
// types.ts
import { type Service } from '@elizaos/core';

declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    NOTIFICATION: 'notification';
  }
}

export const NotificationServiceType = 'notification' as const;

export interface NotificationService extends Service {
  sendNotification(title: string, message: string): Promise<void>;
  getNotificationHistory(): Promise<Notification[]>;
}

// service.ts
import { defineService } from '@elizaos/core';
import { NotificationServiceType, type NotificationService } from './types';

class NotificationServiceImpl extends Service implements NotificationService {
  private notifications: Notification[] = [];

  async sendNotification(title: string, message: string): Promise<void> {
    const notification = { title, message, timestamp: Date.now() };
    this.notifications.push(notification);
    // Send actual notification
  }

  async getNotificationHistory(): Promise<Notification[]> {
    return this.notifications;
  }

  async stop(): Promise<void> {
    this.notifications = [];
  }
}

export const NotificationServiceClass = defineService<NotificationService>({
  serviceType: NotificationServiceType,
  description: 'Handles system notifications',
  start: async (runtime) => new NotificationServiceImpl(runtime),
});

// plugin.ts
import { type Plugin } from '@elizaos/core';
import { NotificationServiceClass } from './service';
import { sendNotificationAction } from './actions';

export const notificationPlugin: Plugin = {
  name: 'notification-plugin',
  description: 'Adds notification capabilities',
  services: [NotificationServiceClass],
  actions: [sendNotificationAction],
};
```

## Best Practices

1. **Always extend the ServiceTypeRegistry** for new service types
2. **Use descriptive service type names** (lowercase, underscore-separated)
3. **Export service type constants** for use in your plugin
4. **Document your service interface** for other developers
5. **Validate service availability** before using in actions/evaluators
6. **Handle missing services gracefully** with appropriate error messages
7. **Clean up resources** in the `stop()` method

## Runtime Behavior

- Services are initialized during plugin registration
- Services can depend on other services (check availability in `start()`)
- The runtime maintains a single instance of each service type
- Services are stopped in reverse registration order during shutdown
- Service types are validated at registration time
