import { IAgentRuntime, ModelType } from '@elizaos/core';
import aiGatewayPlugin from '@elizaos-plugins/plugin-aigateway';

/**
 * Example 1: Basic character configuration
 */
export const basicCharacter = {
    name: 'AIGatewayAgent',
    plugins: [aiGatewayPlugin],
    settings: {
        // Minimum configuration - just API key
        AIGATEWAY_API_KEY: process.env.AIGATEWAY_API_KEY,
    }
};

/**
 * Example 2: Custom gateway configuration (OpenRouter)
 * Note: OpenRouter uses slash format for models
 */
export const openRouterCharacter = {
    name: 'OpenRouterAgent',
    plugins: [aiGatewayPlugin],
    settings: {
        AIGATEWAY_API_KEY: process.env.OPENROUTER_API_KEY,
        AIGATEWAY_BASE_URL: 'https://openrouter.ai/api/v1',
        AIGATEWAY_DEFAULT_MODEL: 'anthropic/claude-3-haiku', // Slash format for OpenRouter
        AIGATEWAY_LARGE_MODEL: 'anthropic/claude-3-5-sonnet',
        AIGATEWAY_CACHE_TTL: '600', // 10 minutes
    }
};

/**
 * Example 3: Vercel AI Gateway with advanced settings
 * Note: Vercel uses colon format for models
 */
export const vercelGatewayCharacter = {
    name: 'VercelAgent',
    plugins: [aiGatewayPlugin],
    settings: {
        AIGATEWAY_API_KEY: process.env.VERCEL_API_KEY,
        AIGATEWAY_BASE_URL: 'https://ai-gateway.vercel.sh/v1',
        AIGATEWAY_DEFAULT_MODEL: 'openai:gpt-4o-mini', // Colon format for Vercel
        AIGATEWAY_LARGE_MODEL: 'openai:gpt-4o',
        AIGATEWAY_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
        AIGATEWAY_CACHE_TTL: '300',
        AIGATEWAY_MAX_RETRIES: '5',
    }
};

/**
 * Example 4: Using the plugin in code
 */
export async function demonstrateUsage(runtime: IAgentRuntime) {
    // Text generation with small model
    const shortText = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: 'Write a haiku about coding',
        temperature: 0.8,
        maxTokens: 50
    });
    // Result: shortText

    // Complex reasoning with large model
    const analysis = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: 'Analyze the pros and cons of microservices architecture',
        temperature: 0.7,
        maxTokens: 1000
    });
    // Result: analysis

    // Generate embeddings for semantic search
    const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text: 'Machine learning transforms data into insights'
    });
    // Result: embedding with dimensions

    // Generate an image
    const images = await runtime.useModel(ModelType.IMAGE, {
        prompt: 'A futuristic city powered by renewable energy, digital art style',
        size: '1024x1024',
        n: 1
    });
    // Result: images

    // Generate structured data
    const structuredData = await runtime.useModel(ModelType.OBJECT_SMALL, {
        prompt: 'Generate a JSON object with user profile fields: name, age, interests (array), location',
        temperature: 0
    });
    // Result: structuredData
}

/**
 * Example 5: Using actions directly
 */
export const actionExamples = {
    // Generate text action
    generateText: {
        action: 'GENERATE_TEXT',
        content: {
            text: 'Explain quantum computing in simple terms',
            temperature: 0.7,
            maxTokens: 200,
            useSmallModel: false
        }
    },

    // Generate image action
    generateImage: {
        action: 'GENERATE_IMAGE',
        content: {
            prompt: 'Abstract art representing the concept of time',
            size: '1792x1024',
            n: 2
        }
    },

    // Generate embedding action
    generateEmbedding: {
        action: 'GENERATE_EMBEDDING',
        content: {
            text: 'The quick brown fox jumps over the lazy dog'
        }
    },

    // List models action
    listModels: {
        action: 'LIST_MODELS',
        content: {
            type: 'text',
            provider: 'openai'
        }
    }
};

/**
 * Example 6: Multi-provider configuration with Vercel
 */
export const multiProviderCharacter = {
    name: 'MultiProviderAgent',
    plugins: [aiGatewayPlugin],
    settings: {
        // Primary gateway (Vercel)
        AIGATEWAY_API_KEY: process.env.VERCEL_API_KEY,
        AIGATEWAY_BASE_URL: 'https://ai-gateway.vercel.sh/v1',
        
        // Use different models from different providers (colon format for Vercel)
        AIGATEWAY_DEFAULT_MODEL: 'anthropic:claude-3-haiku', // Fast responses
        AIGATEWAY_LARGE_MODEL: 'openai:gpt-4o', // Complex reasoning
        AIGATEWAY_EMBEDDING_MODEL: 'openai:text-embedding-3-small', // Embeddings
        
        // Performance settings
        AIGATEWAY_CACHE_TTL: '900', // 15 minutes
        AIGATEWAY_MAX_RETRIES: '3',
    }
};

/**
 * Example 7: Error handling
 */
export async function handleErrors(runtime: IAgentRuntime) {
    try {
        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: 'Hello, AI!',
            temperature: 0.7
        });
        // Success: response
    } catch (error) {
        console.error('Error generating text:', error);
        
        // Fallback logic
        if (error.message.includes('rate limit')) {
            // Rate limited, waiting before retry...
            await new Promise(resolve => setTimeout(resolve, 5000));
            // Retry with smaller model or different settings
        } else if (error.message.includes('API key')) {
            console.error('Invalid API key configuration');
        }
    }
}