---
sidebar_position: 5
title: Providers System
description: Understanding ElizaOS providers - components that supply real-time information and context to agents
keywords: [providers, context, information, data, integration, dynamic, private, state]
image: /img/providers.jpg
---

# 🔌 Providers

[Providers](/packages/core/src/providers.ts) are the sources of information for the agent. They provide data or state while acting as the agent's "senses", injecting real-time information into the agent's context. They serve as the eyes, ears, and other sensory inputs that allow the agent to perceive and interact with its environment, like a bridge between the agent and various external systems such as market data, wallet information, sentiment analysis, and temporal context. Anything that the agent knows is either coming from like the built-in context or from a provider. For more info, see the [providers API page](/api/interfaces/provider).

Here's an example of how providers work within ElizaOS:

- A news provider could fetch and format news.
- A computer terminal provider in a game could feed the agent information when the player is near a terminal.
- A wallet provider can provide the agent with the current assets in a wallet.
- A time provider injects the current date and time into the context.

---

## Overview

A provider's primary purpose is to supply dynamic contextual information that integrates with the agent's runtime. They format information for conversation templates and maintain consistent data access. For example:

- **Function:** Providers run during or before an action is executed.
- **Purpose:** They allow for fetching information from other APIs or services to provide different context or ways for an action to be performed.
- **Example:** Before a "Mars rover action" is executed, a provider could fetch information from another API. This fetched information can then be used to enrich the context of the Mars rover action.

The provider interface is defined in [types.ts](/packages/core/src/types.ts):

```typescript
interface Provider {
  /** Provider name */
  name: string;

  /** Description of the provider */
  description?: string;

  /** Whether the provider is dynamic */
  dynamic?: boolean;

  /** Position of the provider in the provider list, positive or negative */
  position?: number;

  /**
   * Whether the provider is private
   *
   * Private providers are not displayed in the regular provider list, they have to be called explicitly
   */
  private?: boolean;

  /** Data retrieval function */
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}
```

The `get` function takes:

- `runtime`: The agent instance calling the provider
- `message`: The last message received
- `state`: Current conversation state

It returns a `ProviderResult` object that contains:

```typescript
interface ProviderResult {
  values?: {
    [key: string]: any;
  };
  data?: {
    [key: string]: any;
  };
  text?: string;
}
```

- `values`: Key-value pairs to be merged into the agent's state values
- `data`: Additional structured data that can be used by the agent but not directly included in the context
- `text`: String that gets injected into the agent's context

---

## Provider Types and Properties

Providers come with several properties that control how and when they are used:

### Dynamic Providers

Dynamic providers are not automatically included in the context. They must be explicitly requested either in the filter list or include list when composing state.

```typescript
const dynamicProvider: Provider = {
  name: 'dynamicExample',
  description: 'A dynamic provider example',
  dynamic: true,
  get: async (runtime, message, state) => {
    // ...implementation
    return {
      text: 'Dynamic information fetched on demand',
      values: {
        /* key-value pairs */
      },
    };
  },
};
```

### Private Providers

Private providers are not included in the regular provider list and must be explicitly included in the include list when composing state.

```typescript
const privateProvider: Provider = {
  name: 'privateExample',
  description: 'A private provider example',
  private: true,
  get: async (runtime, message, state) => {
    // ...implementation
    return {
      text: 'Private information only available when explicitly requested',
      values: {
        /* key-value pairs */
      },
    };
  },
};
```

### Provider Positioning

The `position` property determines the order in which providers are processed. Lower numbers are processed first.

```typescript
const earlyProvider: Provider = {
  name: 'earlyExample',
  description: 'Runs early in the provider chain',
  position: -100,
  get: async (runtime, message, state) => {
    // ...implementation
    return {
      text: 'Early information',
      values: {
        /* key-value pairs */
      },
    };
  },
};

const lateProvider: Provider = {
  name: 'lateExample',
  description: 'Runs late in the provider chain',
  position: 100,
  get: async (runtime, message, state) => {
    // ...implementation
    return {
      text: 'Late information that might depend on earlier providers',
      values: {
        /* key-value pairs */
      },
    };
  },
};
```

---

## State Composition with Providers

The runtime composes state by gathering data from enabled providers. When calling `composeState`, you can control which providers are used:

```typescript
// Get state with all non-private, non-dynamic providers
const state = await runtime.composeState(message);

// Get state with specific providers only
const filteredState = await runtime.composeState(
  message,
  ['timeProvider', 'factsProvider'], // Only include these providers
  null
);

// Include private or dynamic providers
const enhancedState = await runtime.composeState(
  message,
  null,
  ['privateExample', 'dynamicExample'] // Include these private/dynamic providers
);
```

The system caches provider results to optimize performance. When a provider is called multiple times with the same message, the cached result is used unless you explicitly request a new evaluation.

---

## Examples

ElizaOS providers typically fall into these categories, with examples from the ecosystem:

### System & Integration

- **Time Provider**: Injects current date/time for temporal awareness
- **Giphy Provider**: Provides GIF responses using Giphy API
- **GitBook Provider**: Supplies documentation context from GitBook
- **Topics Provider**: Caches and serves Allora Network topic information

### Blockchain & DeFi

- **Wallet Provider**: Portfolio data from Zerion, balances and prices
- **DePIN Provider**: Network metrics via DePINScan API
- **Chain Providers**: Data from Abstract, Fuel, ICP, EVM networks
- **Market Provider**: Token data from DexScreener, Birdeye APIs

### Knowledge & Data

- **DKG Provider**: OriginTrail decentralized knowledge integration
- **News Provider**: Current events via NewsAPI
- **Trust Provider**: Calculates and injects trust scores

Visit the [ElizaOS Plugin Registry](https://github.com/elizaos-plugins/registry) for a complete list of available plugins and providers.

### Time Provider Example

```typescript
const timeProvider: Provider = {
  name: 'time',
  description: 'Provides the current date and time',
  position: -10, // Run early to ensure time is available for other providers
  get: async (_runtime: IAgentRuntime, _message: Memory) => {
    const currentDate = new Date();
    const options = {
      timeZone: 'UTC',
      dateStyle: 'full' as const,
      timeStyle: 'long' as const,
    };
    const humanReadable = new Intl.DateTimeFormat('en-US', options).format(currentDate);

    return {
      text: `The current date and time is ${humanReadable}. Please use this as your reference for any time-based operations or responses.`,
      values: {
        currentDate: currentDate.toISOString(),
        humanReadableDate: humanReadable,
      },
    };
  },
};
```

### Dynamic Provider Example

```typescript
const weatherProvider: Provider = {
  name: 'weather',
  description: 'Provides weather information for a location',
  dynamic: true, // Only used when explicitly requested
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Extract location from state if available
    const location = state?.values?.location || 'San Francisco';

    try {
      // Fetch weather data from an API
      const weatherData = await fetchWeatherData(location);

      return {
        text: `The current weather in ${location} is ${weatherData.description} with a temperature of ${weatherData.temperature}°C.`,
        values: {
          weather: {
            location,
            temperature: weatherData.temperature,
            description: weatherData.description,
            humidity: weatherData.humidity,
          },
        },
        data: {
          // Additional detailed data that doesn't go into the context
          weatherDetails: weatherData,
        },
      };
    } catch (error) {
      // Handle errors gracefully
      return {
        text: `I couldn't retrieve weather information for ${location} at this time.`,
        values: {
          weather: { error: true },
        },
      };
    }
  },
};
```

---

## Best Practices

### 1. Optimize for Efficiency

- Return both structured data (`values`) and formatted text (`text`)
- Use caching for expensive operations
- Include a clear provider name and description

```typescript
const efficientProvider: Provider = {
  name: 'efficientExample',
  description: 'Efficiently provides cached data',
  get: async (runtime, message) => {
    // Check for cached data
    const cacheKey = `data:${message.roomId}`;
    const cachedData = await runtime.getCache(cacheKey);

    if (cachedData) {
      return cachedData;
    }

    // Fetch fresh data if not cached
    const result = {
      text: 'Freshly generated information',
      values: {
        /* key-value pairs */
      },
      data: {
        /* structured data */
      },
    };

    // Cache the result with appropriate TTL
    await runtime.setCache(cacheKey, result, { expires: 30 * 60 * 1000 }); // 30 minutes

    return result;
  },
};
```

### 2. Handle Errors Gracefully

Always handle errors without throwing exceptions that would interrupt the agent's processing:

```typescript
try {
  // Risky operation
} catch (error) {
  return {
    text: "I couldn't retrieve that information right now.",
    values: { error: true },
  };
}
```

### 3. Use Position for Optimal Order

Position providers according to their dependencies:

- Negative positions: Fundamental information providers (time, location)
- Zero (default): Standard information providers
- Positive positions: Providers that depend on other information

### 4. Structure Return Values Consistently

Maintain a consistent structure in your provider's return values to make data easier to use across the system.

---

## FAQ

### What's the difference between values, data, and text?

- `values`: These are merged into the agent state and can be accessed by other providers
- `data`: Structured data stored in state.data.providers but not directly exposed to the agent
- `text`: Formatted text that's directly injected into the agent's context

### When should I use a dynamic provider?

Use dynamic providers when the information is expensive to compute, only relevant in specific situations, or requires explicit triggering rather than being included in every context.

### How do I explicitly include a private provider?

Private providers must be included in the `includeList` parameter when calling `composeState`:

```typescript
const state = await runtime.composeState(message, null, ['privateProviderName']);
```

### Can providers access service functionality?

Yes, providers can use services through the runtime. For example, a wallet provider might use a blockchain service to fetch data:

```typescript
const walletProvider: Provider = {
  name: 'wallet',
  get: async (runtime, message) => {
    const solanaService = runtime.getService('solana');
    if (!solanaService) {
      return { text: '' };
    }

    const walletData = await solanaService.getCachedData();
    // Process and return wallet data
  },
};
```

### How should providers handle failures?

Providers should handle failures gracefully and return valid ProviderResult objects with appropriate error information. Never throw errors that would break the agent's context composition.

### Can providers maintain state between calls?

While providers can maintain internal state (e.g., through closures), it's better to use the runtime's cache system for persistence:

```typescript
// Store data
await runtime.setCache('myProvider:someKey', dataToStore);

// Retrieve data later
const storedData = await runtime.getCache('myProvider:someKey');
```

---

## Further Reading

- [Provider Implementation](/packages/core/src/providers.ts)
- [Types Reference](/packages/core/src/types.ts)
- [Runtime Integration](/packages/core/src/runtime.ts)
