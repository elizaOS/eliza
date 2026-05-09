---
description: Providers add context to the LLM so that it can be agentic. Providers are the input to the agent and can be static and always included or dynamic and included when the agent determines they are needed
globs:
alwaysApply: false
---

# ElizaOS Providers System

Providers are the sources of information for agents. They act as the agent's "senses", injecting real-time information and context into the agent's decision-making process.

## Core Concepts

### Provider Structure

```typescript
interface Provider {
  name: string; // Unique identifier
  description?: string; // Purpose explanation
  dynamic?: boolean; // Only used when explicitly requested
  position?: number; // Execution order (lower runs first)
  private?: boolean; // Must be explicitly included
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}

interface ProviderResult {
  values?: { [key: string]: any }; // Merged into state.values
  data?: { [key: string]: any }; // Stored in state.data.providers
  text?: string; // Injected into agent context
}
```

## Provider Types

### Regular Providers

- Automatically included in context composition
- Run for every message unless filtered out
- Example: TIME, CHARACTER, RECENT_MESSAGES

### Dynamic Providers

- Only included when explicitly requested
- Used for expensive or situational data
- Example: WEATHER, PORTFOLIO

### Private Providers

- Never included automatically
- Must be explicitly included via `includeList`
- Example: INTERNAL_METRICS

## State Composition

```typescript
// Default: all regular providers
const state = await runtime.composeState(message);

// Filtered: only specific providers
const state = await runtime.composeState(
  message,
  ['TIME', 'FACTS'] // Only these providers
);

// Include private/dynamic providers
const state = await runtime.composeState(
  message,
  null,
  ['WEATHER', 'PRIVATE_DATA'] // Include these extras
);
```

## Implementation Patterns

### Basic Provider

```typescript
const timeProvider: Provider = {
  name: 'TIME',
  description: 'Provides current date and time',
  position: -10, // Run early

  get: async (runtime, message) => {
    const now = new Date();
    const formatted = now.toLocaleString('en-US', {
      timeZone: 'UTC',
      dateStyle: 'full',
      timeStyle: 'long',
    });

    return {
      text: `Current time: ${formatted}`,
      values: {
        currentDate: now.toISOString(),
        humanDate: formatted,
      },
    };
  },
};
```

### Dynamic Provider

```typescript
const weatherProvider: Provider = {
  name: 'WEATHER',
  dynamic: true, // Only when requested

  get: async (runtime, message, state) => {
    const location = state.values.location || 'San Francisco';
    const weather = await fetchWeatherAPI(location);

    return {
      text: `Weather in ${location}: ${weather.description}`,
      values: {
        weather: {
          location,
          temperature: weather.temp,
          conditions: weather.description,
        },
      },
      data: {
        fullWeatherData: weather, // Additional data
      },
    };
  },
};
```

### Action State Provider

Special provider for action chaining that exposes:

- Previous action results
- Working memory state
- Active plan information

```typescript
const actionStateProvider: Provider = {
  name: 'ACTION_STATE',
  position: -5, // High priority

  get: async (runtime, message, state) => {
    const actionResults = state.data?.actionResults || [];
    const workingMemory = runtime.getWorkingMemory(message.roomId);

    return {
      text: formatActionResults(actionResults),
      values: {
        previousActionCount: actionResults.length,
        lastActionSuccess: actionResults.slice(-1)[0]?.success,
      },
      data: {
        actionResults,
        workingMemory: workingMemory?.serialize(),
      },
    };
  },
};
```

## Common Provider Categories

### System & Integration

- **TIME**: Current date/time
- **CHARACTER**: Agent personality
- **RECENT_MESSAGES**: Conversation history
- **ACTION_STATE**: Action execution state
- **ENTITIES**: User information

### External Services

- **WEATHER**: Weather data
- **NEWS**: Current events
- **MARKET**: Financial data
- **SOCIAL**: Social media info

### Knowledge & Context

- **FACTS**: Extracted knowledge
- **TOPICS**: Conversation topics
- **SETTINGS**: Configuration values
- **CAPABILITIES**: Agent abilities

## Best Practices

1. **Return Structure**: Always return `ProviderResult` with appropriate fields
2. **Error Handling**: Handle errors gracefully, return empty result on failure
3. **Caching**: Use runtime cache for expensive operations
4. **Position**: Set appropriate position for execution order
5. **Dynamic Flag**: Mark expensive providers as dynamic
6. **Text Formatting**: Format text for clear context injection

## Provider Flow

1. `composeState()` called with message
2. Providers filtered based on type and request
3. Providers execute in position order
4. Results cached and aggregated
5. State object returned with merged data

## Integration with Actions

Providers run before action selection, providing context that helps the LLM choose appropriate actions. The ACTION_STATE provider specifically enables action chaining by exposing previous execution results.
