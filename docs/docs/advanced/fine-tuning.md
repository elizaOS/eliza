---
sidebar_position: 13
---

# 🎯 Fine-tuning Guide

## Overview

Eliza supports multiple AI model providers and offers extensive configuration options for fine-tuning model behavior, embedding generation, and performance optimization.

## Model Providers

Eliza supports multiple model providers through a flexible configuration system:

```typescript
enum ModelProviderName {
    OPENAI,
    ANTHROPIC,
    CLAUDE_VERTEX,
    GROK,
    GROQ,
    LLAMACLOUD,
    LLAMALOCAL,
    GOOGLE,
    MISTRAL,
    REDPILL,
    OPENROUTER,
    HEURIST,
    LIVEPEER,
}
```

### Provider Configuration

Each provider has specific settings:

```typescript
const models = {
    [ModelProviderName.ANTHROPIC]: {
        settings: {
            stop: [],
            maxInputTokens: 200000,
            maxOutputTokens: 8192,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            temperature: 0.3,
        },
        endpoint: "https://api.anthropic.com/v1",
        model: {
            [ModelClass.SMALL]: "claude-3-5-haiku",
            [ModelClass.MEDIUM]: "claude-3-5-sonnet-20241022",
            [ModelClass.LARGE]: "claude-3-5-opus-20240229",
        },
    },
    // ... other providers
};
```

## Model Classes

Models are categorized into different classes based on their capabilities:

```typescript
enum ModelClass {
    SMALL, // Fast, efficient for simple tasks
    MEDIUM, // Balanced performance and capability
    LARGE, // Most capable but slower/more expensive
    EMBEDDING, // Specialized for vector embeddings
    IMAGE, // Image generation capabilities
}
```

## Embedding System

### Configuration

```typescript
const embeddingConfig = {
    dimensions: 1536,
    modelName: "text-embedding-3-small",
    cacheEnabled: true,
};
```

### Implementation

```typescript
async function embed(runtime: IAgentRuntime, input: string): Promise<number[]> {
    // Check cache first
    const cachedEmbedding = await retrieveCachedEmbedding(runtime, input);
    if (cachedEmbedding) return cachedEmbedding;

    // Generate new embedding
    const response = await runtime.fetch(
        `${runtime.modelProvider.endpoint}/embeddings`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${runtime.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                input,
                model: runtime.modelProvider.model.EMBEDDING,
                dimensions: 1536,
            }),
        },
    );

    const data = await response.json();
    return data?.data?.[0].embedding;
}
```

## Fine-tuning Options

### Temperature Control

Configure model creativity vs. determinism:

```typescript
const temperatureSettings = {
    creative: {
        temperature: 0.8,
        frequency_penalty: 0.7,
        presence_penalty: 0.7,
    },
    balanced: {
        temperature: 0.5,
        frequency_penalty: 0.3,
        presence_penalty: 0.3,
    },
    precise: {
        temperature: 0.2,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
    },
};
```

### Context Window

Manage token limits:

```typescript
const contextSettings = {
    OPENAI: {
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
    },
    ANTHROPIC: {
        maxInputTokens: 200000,
        maxOutputTokens: 8192,
    },
    LLAMALOCAL: {
        maxInputTokens: 32768,
        maxOutputTokens: 8192,
    },
};
```

## Performance Optimization

### Caching Strategy

```typescript
class EmbeddingCache {
    private cache: NodeCache;
    private cacheDir: string;

    constructor() {
        this.cache = new NodeCache({ stdTTL: 300 }); // 5 minute TTL
        this.cacheDir = path.join(__dirname, "cache");
    }

    async get(key: string): Promise<number[] | null> {
        // Check memory cache first
        const cached = this.cache.get<number[]>(key);
        if (cached) return cached;

        // Check disk cache
        return this.readFromDisk(key);
    }

    async set(key: string, embedding: number[]): Promise<void> {
        this.cache.set(key, embedding);
        await this.writeToDisk(key, embedding);
    }
}
```

### Model Selection

```typescript
async function selectOptimalModel(
    task: string,
    requirements: ModelRequirements,
): Promise<ModelClass> {
    if (requirements.speed === "fast") {
        return ModelClass.SMALL;
    } else if (requirements.complexity === "high") {
        return ModelClass.LARGE;
    }
    return ModelClass.MEDIUM;
}
```

## Provider-Specific Optimizations

### OpenAI

```typescript
const openAISettings = {
    endpoint: "https://api.openai.com/v1",
    settings: {
        stop: [],
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.6,
    },
    model: {
        [ModelClass.SMALL]: "gpt-4o-mini",
        [ModelClass.MEDIUM]: "gpt-4o",
        [ModelClass.LARGE]: "gpt-4o",
        [ModelClass.EMBEDDING]: "text-embedding-3-small",
        [ModelClass.IMAGE]: "dall-e-3",
    },
};
```

### Anthropic

```typescript
const anthropicSettings = {
    endpoint: "https://api.anthropic.com/v1",
    settings: {
        stop: [],
        maxInputTokens: 200000,
        maxOutputTokens: 8192,
        temperature: 0.3,
    },
    model: {
        [ModelClass.SMALL]: "claude-3-5-haiku",
        [ModelClass.MEDIUM]: "claude-3-5-sonnet-20241022",
        [ModelClass.LARGE]: "claude-3-5-opus-20240229",
    },
};
```

### Local LLM

```typescript
const llamaLocalSettings = {
    settings: {
        stop: ["<|eot_id|>", "<|eom_id|>"],
        maxInputTokens: 32768,
        maxOutputTokens: 8192,
        repetition_penalty: 0.0,
        temperature: 0.3,
    },
    model: {
        [ModelClass.SMALL]: "NousResearch/Hermes-3-Llama-3.1-8B-GGUF",
        [ModelClass.MEDIUM]: "NousResearch/Hermes-3-Llama-3.1-8B-GGUF",
        [ModelClass.LARGE]: "NousResearch/Hermes-3-Llama-3.1-8B-GGUF",
        [ModelClass.EMBEDDING]: "togethercomputer/m2-bert-80M-32k-retrieval",
    },
};
```

### Heurist Provider

```typescript
const heuristSettings = {
  settings: {
    stop: [],
    maxInputTokens: 32768,
    maxOutputTokens: 8192,
    repetition_penalty: 0.0,
    temperature: 0.7,
  },
  imageSettings: {
    steps: 20,
  },
  endpoint: "https://llm-gateway.heurist.xyz",
  model: {
    [ModelClass.SMALL]: "hermes-3-llama3.1-8b",
    [ModelClass.MEDIUM]: "mistralai/mixtral-8x7b-instruct",
    [ModelClass.LARGE]: "nvidia/llama-3.1-nemotron-70b-instruct",
    [ModelClass.EMBEDDING]: "", // Add later
    [ModelClass.IMAGE]: "FLUX.1-dev",
  },
};
```

### Livepeer Provider

```typescript
const livepeerSettings = {
  settings: {
    stop: [],
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    repetition_penalty: 0.4,
    temperature: 0.7,
  },
  endpoint: "https://dream-gateway.livepeer.cloud",
  model: {
    [ModelClass.SMALL]: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    [ModelClass.MEDIUM]: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    [ModelClass.LARGE]: "meta-llama/Llama-3.3-70B-Instruct",
    [ModelClass.IMAGE]: "ByteDance/SDXL-Lightning",
  },
};
```

## Testing and Validation

### Embedding Tests

```typescript
async function validateEmbedding(
    embedding: number[],
    expectedDimensions: number = 1536,
): Promise<boolean> {
    if (!Array.isArray(embedding)) return false;
    if (embedding.length !== expectedDimensions) return false;
    if (embedding.some((n) => typeof n !== "number")) return false;
    return true;
}
```

### Model Performance Testing

```typescript
async function benchmarkModel(
    runtime: IAgentRuntime,
    modelClass: ModelClass,
    testCases: TestCase[],
): Promise<BenchmarkResults> {
    const results = {
        latency: [],
        tokenUsage: [],
        accuracy: [],
    };

    for (const test of testCases) {
        const start = Date.now();
        const response = await runtime.generateText({
            context: test.input,
            modelClass,
        });
        results.latency.push(Date.now() - start);
        // ... additional metrics
    }

    return results;
}
```

## Best Practices

### Model Selection Guidelines

1. **Task Complexity**

    - Use SMALL for simple, quick responses
    - Use MEDIUM for balanced performance
    - Use LARGE for complex reasoning

2. **Context Management**

    - Keep prompts concise and focused
    - Use context windows efficiently
    - Implement proper context truncation

3. **Temperature Adjustment**
    - Lower for factual responses
    - Higher for creative tasks
    - Balance based on use case

### Performance Optimization

1. **Caching Strategy**

    - Cache embeddings for frequently accessed content
    - Implement tiered caching (memory/disk)
    - Regular cache cleanup

2. **Resource Management**
    - Monitor token usage
    - Implement rate limiting
    - Optimize batch processing

## Troubleshooting

### Common Issues

1. **Token Limits**

    ```typescript
    function handleTokenLimit(error: Error) {
        if (error.message.includes("token limit")) {
            return truncateAndRetry();
        }
    }
    ```

2. **Embedding Errors**

    ```typescript
    function handleEmbeddingError(error: Error) {
        if (error.message.includes("dimension mismatch")) {
            return regenerateEmbedding();
        }
    }
    ```

3. **Model Availability**
    ```typescript
    async function handleModelFailover(error: Error) {
        if (error.message.includes("model not available")) {
            return switchToFallbackModel();
        }
    }
    ```
