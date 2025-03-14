---
sidebar_position: 1
---

# 📦 Core Package

## Overview

The Core Package (`@elizaos/core`) provides the fundamental building blocks of Eliza's architecture, handling essential functionalities like:

- Memory Management & Semantic Search
- Message Processing & Generation
- Runtime Environment & State Management
- Action & Evaluator Systems
- Provider Integration & Context Composition
- Service Infrastructure

## Installation

```bash
pnpm add @elizaos/core
```

## Key Components

### AgentRuntime

The AgentRuntime class serves as the central nervous system of Eliza, orchestrating all major components:

```typescript
import { AgentRuntime } from "@elizaos/core";

const runtime = new AgentRuntime({
    // Core configuration
    databaseAdapter,
    token,
    modelProvider: ModelProviderName.OPENAI,
    character,

    // Extension points
    plugins: [bootstrapPlugin, nodePlugin],
    providers: [],
    actions: [],
    services: [],
    managers: [],

    // Optional settings
    conversationLength: 32,
    agentId: customId,
    fetch: customFetch,
});
```

Key capabilities:

- State composition and management
- Plugin and service registration
- Memory and relationship management
- Action processing and evaluation
- Message generation and handling

### Memory System

The MemoryManager handles persistent storage and retrieval of context-aware information:

```typescript
class MemoryManager implements IMemoryManager {
    runtime: IAgentRuntime;
    tableName: string;

    // Create new memories with embeddings
    async createMemory(memory: Memory, unique = false): Promise<void> {
        if (!memory.embedding) {
            memory.embedding = await embed(this.runtime, memory.content.text);
        }

        await this.runtime.databaseAdapter.createMemory(
            memory,
            this.tableName,
            unique,
        );
    }

    // Semantic search with embeddings
    async searchMemoriesByEmbedding(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId: UUID;
            unique?: boolean;
        },
    ): Promise<Memory[]> {
        return this.runtime.databaseAdapter.searchMemories({
            tableName: this.tableName,
            roomId: opts.roomId,
            embedding,
            match_threshold: opts.match_threshold ?? 0.8,
            match_count: opts.count ?? 10,
            unique: opts.unique ?? false,
        });
    }
}
```

### Context System

The context system manages state composition and template handling:

```typescript
// Template composition
export const composeContext = ({
    state,
    template,
}: {
    state: State;
    template: string;
}): string => {
    return template.replace(/{{\w+}}/g, (match) => {
        const key = match.replace(/{{|}}/g, "");
        return state[key] ?? "";
    });
};

// Header handling
export const addHeader = (header: string, body: string): string => {
    return body.length > 0 ? `${header ? header + "\n" : header}${body}\n` : "";
};
```

### Action System

Actions define the available behaviors and responses:

```typescript
interface Action {
    name: string;
    similes: string[];
    description: string;
    examples: MessageExample[][];

    validate: (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
    ) => Promise<boolean>;

    handler: (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback,
    ) => Promise<void>;
}

// Example action implementation
const generateImageAction: Action = {
    name: "GENERATE_IMAGE",
    similes: ["CREATE_IMAGE", "MAKE_PICTURE"],
    description: "Generate an AI image from text",

    validate: async (runtime, message) => {
        return (
            !!runtime.getSetting("ANTHROPIC_API_KEY") &&
            !!runtime.getSetting("TOGETHER_API_KEY")
        );
    },

    handler: async (runtime, message, state, options, callback) => {
        const images = await generateImage(
            { prompt: message.content.text },
            runtime,
        );

        const captions = await Promise.all(
            images.data.map((image) =>
                generateCaption({ imageUrl: image }, runtime),
            ),
        );

        callback?.(
            {
                text: "Generated images",
                attachments: images.data.map((image, i) => ({
                    id: crypto.randomUUID(),
                    url: image,
                    title: "Generated image",
                    description: captions[i].title,
                })),
            },
            [],
        );
    },
};
```

### Evaluation System

Evaluators assess messages and guide agent behavior:

```typescript
interface Evaluator {
    name: string;
    similes: string[];
    alwaysRun?: boolean;

    validate: (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
    ) => Promise<boolean>;

    handler: (runtime: IAgentRuntime, message: Memory) => Promise<void>;
}

// Example evaluator
const factEvaluator: Evaluator = {
    name: "EVALUATE_FACTS",
    similes: ["CHECK_FACTS"],
    alwaysRun: true,

    validate: async (runtime, message) => {
        return message.content.text.includes("fact:");
    },

    handler: async (runtime, message) => {
        const facts = await runtime.loreManager.searchMemories({
            text: message.content.text,
            threshold: 0.8,
        });

        if (facts.length > 0) {
            await runtime.messageManager.createMemory({
                content: {
                    text: `Verified fact: ${facts[0].content.text}`,
                },
                roomId: message.roomId,
                userId: runtime.agentId,
            });
        }
    },
};
```

### State Management

The state system maintains conversation context and agent knowledge:

```typescript
interface State {
    // Agent identity
    agentId: UUID;
    agentName: string;
    bio: string;
    lore: string;
    adjective?: string;

    // Conversation context
    senderName?: string;
    actors: string;
    actorsData: Actor[];
    recentMessages: string;
    recentMessagesData: Memory[];

    // Objectives
    goals: string;
    goalsData: Goal[];

    // Behavioral guidance
    actions: string;
    actionNames: string;
    evaluators: string;
    evaluatorNames: string;

    // Additional context
    providers: string;
    attachments: string;
    characterPostExamples?: string;
    characterMessageExamples?: string;
}
```

## Service Architecture

The core implements a service-based architecture:

```typescript
// Service base class
class Service {
    static serviceType: ServiceType;

    async initialize(
        device: string | null,
        runtime: IAgentRuntime,
    ): Promise<void>;
}

// Service registry
class ServiceRegistry {
    private services = new Map<ServiceType, Service>();

    registerService(service: Service): void {
        const type = (service as typeof Service).serviceType;
        if (this.services.has(type)) {
            console.warn(`Service ${type} already registered`);
            return;
        }
        this.services.set(type, service);
    }

    getService<T>(type: ServiceType): T | null {
        return (this.services.get(type) as T) || null;
    }
}
```

## Best Practices

### Memory Management

```typescript
// Use unique flags for important memories
await memoryManager.createMemory(memory, true);

// Search with appropriate thresholds
const similar = await memoryManager.searchMemoriesByEmbedding(embedding, {
    match_threshold: 0.8,
    count: 10,
});

// Clean up old memories periodically
await memoryManager.removeAllMemories(roomId, tableName);
```

### State Composition

```typescript
// Compose full state
const state = await runtime.composeState(message, {
    additionalContext: "Custom context",
});

// Update with recent messages
const updatedState = await runtime.updateRecentMessageState(state);

// Add custom providers
state.providers = addHeader(
    "# Additional Information",
    await Promise.all(providers.map((p) => p.get(runtime, message))).join("\n"),
);
```

### Service Management

```typescript
// Service initialization
class CustomService extends Service {
    static serviceType = ServiceType.CUSTOM;

    async initialize(device: string | null, runtime: IAgentRuntime) {
        await this.setupDependencies();
        await this.validateConfig();
        await this.connect();
    }

    async cleanup() {
        await this.disconnect();
        await this.clearResources();
    }
}

// Service registration
runtime.registerService(new CustomService());

// Service usage
const service = runtime.getService<CustomService>(ServiceType.CUSTOM);
```

## Error Handling

Implement proper error handling throughout:

```typescript
try {
    await runtime.processActions(message, responses, state);
} catch (error) {
    if (error instanceof TokenError) {
        await this.refreshToken();
    } else if (error instanceof DatabaseError) {
        await this.reconnectDatabase();
    } else {
        console.error("Unexpected error:", error);
        throw error;
    }
}
```

## Advanced Features

### Custom Memory Types

```typescript
// Create specialized memory managers
class DocumentMemoryManager extends MemoryManager {
    constructor(runtime: IAgentRuntime) {
        super({
            runtime,
            tableName: "documents",
            useCache: true,
        });
    }

    async processDocument(doc: Document): Promise<void> {
        const chunks = await splitChunks(doc.content);

        for (const chunk of chunks) {
            await this.createMemory({
                content: { text: chunk },
                metadata: {
                    documentId: doc.id,
                    section: chunk.section,
                },
            });
        }
    }
}
```

### Enhanced Embeddings

```typescript
// Advanced embedding handling
async function enhancedEmbed(
    runtime: IAgentRuntime,
    text: string,
    opts: {
        model?: string;
        dimensions?: number;
        pooling?: "mean" | "max";
    },
): Promise<number[]> {
    // Get cached embedding if available
    const cached = await runtime.databaseAdapter.getCachedEmbeddings({
        query_input: text,
        query_threshold: 0.95,
    });

    if (cached.length > 0) {
        return cached[0].embedding;
    }

    // Generate new embedding
    return embed(runtime, text, opts);
}
```

### State Persistence

```typescript
class StateManager {
    async saveState(state: State): Promise<void> {
        await this.runtime.databaseAdapter.createMemory(
            {
                content: {
                    type: "state",
                    data: state,
                },
                roomId: state.roomId,
                userId: state.agentId,
            },
            "states",
        );
    }

    async loadState(roomId: UUID): Promise<State | null> {
        const states = await this.runtime.databaseAdapter.getMemories({
            roomId,
            tableName: "states",
            count: 1,
        });

        return states[0]?.content.data || null;
    }
}
```

## Related Documentation

- [API Reference](/api/classes/AgentRuntime)
