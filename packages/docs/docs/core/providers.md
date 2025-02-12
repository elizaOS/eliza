# 🔌 Providers

[Providers](/api/interfaces/provider) are core modules that inject dynamic context and real-time information into agent interactions. They serve as a bridge between the agent and various external systems, enabling access to market data, wallet information, sentiment analysis, and temporal context.

---

## Overview

A provider's primary purpose is to:

- Supply dynamic contextual information
- Integrate with the agent runtime
- Format information for conversation templates
- Maintain consistent data access

### Core Structure

```typescript
interface Provider {
    get: (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
    ) => Promise<string>;
}
```

---

## Built-in Providers

### Time Provider

Provides temporal context for agent interactions:

```typescript
const timeProvider: Provider = {
    get: async (_runtime: IAgentRuntime, _message: Memory) => {
        const currentDate = new Date();
        const currentTime = currentDate.toLocaleTimeString("en-US");
        const currentYear = currentDate.getFullYear();
        return `The current time is: ${currentTime}, ${currentYear}`;
    },
};
```

### Facts Provider

From bootstrap plugin - maintains conversation facts:

```typescript
const factsProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Create embedding for recent messages and retrieve relevant facts
        const recentMessages = formatMessages({
            messages: state?.recentMessagesData?.slice(-10),
            actors: state?.actorsData,
        });
        const embedding = await embed(runtime, recentMessages);
        const memoryManager = new MemoryManager({
            runtime,
            tableName: "facts",
        });
        const recentFactsData = await memoryManager.getMemories({
            roomId: message.roomId,
            count: 10,
            agentId: runtime.agentId,
        });

        // Combine and format facts
        const allFacts = [...recentFactsData]; // Deduplication can be skipped if no overlap
        const formattedFacts = formatFacts(allFacts);

        return `Key facts that ${runtime.character.name} knows:\n${formattedFacts}`;
    },
};

export { factsProvider };
```

### Boredom Provider

From bootstrap plugin - manages conversation dynamics and engagement by calculating the boredom level of an agent based on recent messages in a chat room.

1. **Data Structures**:

    - **boredomLevels**: An array of objects, each representing a boredom level with a minimum score and a set of status messages that reflect the agent's current engagement.
    - **interestWords**, **cringeWords**, and **negativeWords**: Arrays of words that influence the boredom score based on their presence in messages.

2. **Boredom Calculation**:

- The `boredomProvider` gets recent messages from the agent’s conversation over the last 15 minutes.
- It calculates a **boredom score** by analyzing the text of these messages. The score is influenced by:
    - **Interest words**: Decrease boredom (subtract 1 point).
    - **Cringe words**: Increase boredom (add 1 point).
    - **Negative words**: Increase boredom (add 1 point).
    - **Exclamation marks**: Increase boredom (add 1 point).
    - **Question marks**: Increase or decrease boredom depending on the sender.

3. **Boredom Level**:
    - The boredom score is matched to a level from the `boredomLevels` array, which defines how engaged the agent feels.
    - A random status message from the selected boredom level is chosen and the agent’s name is inserted into the message.

```typescript
interface BoredomLevel {
    minScore: number;
    statusMessages: string[];
}
```

The result is a message that reflects the agent's perceived level of engagement in the conversation, based on their recent interactions.

```typescript
const boredomProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory) => {
        const messages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 10,
        });

        return messages.length > 0
            ? "Actively engaged in conversation"
            : "No recent interactions";
    },
};
```

Features:

- Engagement tracking
- Conversation flow management
- Natural disengagement
- Sentiment analysis
- Response adaptation

---

## Implementation

### Basic Provider Template

```typescript
import { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";

const customProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Get relevant data using runtime services
        const memories = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5,
        });

        // Format and return context
        return formatContextString(memories);
    },
};
```

### Memory Integration

```typescript
const memoryProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory) => {
        // Get recent messages
        const messages = await runtime.messageManager.getMemories({
            roomId: message.roomId,
            count: 5,
            unique: true,
        });

        // Get user descriptions
        const descriptions = await runtime.descriptionManager.getMemories({
            roomId: message.roomId,
            userId: message.userId,
        });

        // Combine and format
        return `
Recent Activity:
${formatMessages(messages)}

User Context:
${formatDescriptions(descriptions)}
    `.trim();
    },
};
```

---

## Best Practices

### 1. Data Management

- Implement robust caching strategies
- Use appropriate TTL for different data types
- Validate data before caching

### 2. Performance

```typescript
// Example of optimized data fetching
async function fetchDataWithCache<T>(
    key: string,
    fetcher: () => Promise<T>,
): Promise<T> {
    const cached = await cache.get(key);
    if (cached) return cached;

    const data = await fetcher();
    await cache.set(key, data);
    return data;
}
```

### 3. Error Handling

- Implement retry mechanisms
- Provide fallback values
- Log errors comprehensively
- Handle API timeouts

### 4. Security

- Validate input parameters
- Sanitize returned data
- Implement rate limiting
- Handle sensitive data appropriately

---

## Integration with Runtime

Providers are registered with the [AgentRuntime](/api/classes/AgentRuntime):

```typescript
// Register provider
runtime.registerContextProvider(customProvider);

// Providers are accessed through composeState
const state = await runtime.composeState(message);
```

## Example: Complete Provider

```typescript
import { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";

const comprehensiveProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        try {
            // Get recent messages
            const messages = await runtime.messageManager.getMemories({
                roomId: message.roomId,
                count: 5,
            });

            // Get user context
            const userContext = await runtime.descriptionManager.getMemories({
                roomId: message.roomId,
                userId: message.userId,
            });

            // Get relevant facts
            const facts = await runtime.messageManager.getMemories({
                roomId: message.roomId,
                tableName: "facts",
                count: 3,
            });

            // Format comprehensive context
            return `
# Conversation Context
${messages.map((m) => `- ${m.content.text}`).join("\n")}

# User Information
${userContext.map((c) => c.content.text).join("\n")}

# Related Facts
${facts.map((f) => `- ${f.content.text}`).join("\n")}
      `.trim();
        } catch (error) {
            console.error("Provider error:", error);
            return "Context temporarily unavailable";
        }
    },
};
```

---

## Troubleshooting

1. **Stale Data**

    ```typescript
    // Implement cache invalidation
    const invalidateCache = async (pattern: string) => {
        const keys = await cache.keys(pattern);
        await Promise.all(keys.map((k) => cache.del(k)));
    };
    ```

2. **Rate Limiting**

    ```typescript
    // Implement backoff strategy
    const backoff = async (attempt: number) => {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise((resolve) => setTimeout(resolve, delay));
    };
    ```

3. **API Failures**
    ```typescript
    // Implement fallback data sources
    const getFallbackData = async () => {
        // Attempt alternative data sources
    };
    ```

---

## Further Reading

- [Agent Runtime](./agents.md)
- [Memory System](../../packages/core)
