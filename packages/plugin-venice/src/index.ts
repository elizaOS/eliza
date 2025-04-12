import { createOpenAI } from '@ai-sdk/openai';
import type {
    ImageDescriptionParams,
    ModelTypeName,
    ObjectGenerationParams,
    Plugin,
    TextEmbeddingParams
} from '@elizaos/core';
import {
    type DetokenizeTextParams,
    type GenerateTextParams,
    ModelType,
    type TokenizeTextParams,
    logger,
    VECTOR_DIMS,
} from '@elizaos/core';
import { generateObject, generateText } from 'ai';
import { type TiktokenModel, encodingForModel } from 'js-tiktoken';
import { FormData as NodeFormData, File as NodeFile } from 'formdata-node';

// Venice-specific helper functions
function getSetting(runtime: any, key: string, defaultValue?: string): string | undefined {
    return runtime.getSetting(key) ?? process.env[key] ?? defaultValue;
}

function getBaseURL(): string {
    return 'https://api.venice.ai/api/v1';  // Venice requires this specific base URL
}

function getVeniceApiKey(runtime: any): string | undefined {
    return getSetting(runtime, 'VENICE_API_KEY');
}

function getSmallModel(runtime: any): string {
    return getSetting(runtime, 'VENICE_SMALL_MODEL') ?? 'llama-3.3-70b';
}

function getLargeModel(runtime: any): string {
    return getSetting(runtime, 'VENICE_LARGE_MODEL') ?? 'llama-3.1-405b';
}

function getEmbeddingModel(runtime: any): string {
    return getSetting(runtime, 'VENICE_EMBEDDING_MODEL') ?? 'text-embedding-3-small';
}

function getEmbeddingDimensions(runtime: any): number {
    return parseInt(getSetting(runtime, 'VENICE_EMBEDDING_DIMENSIONS') ?? '4096', 10);
}

// OpenAI-specific helper functions
function getOpenAIApiKey(runtime: any): string | undefined {
    return getSetting(runtime, 'OPENAI_API_KEY');
}

function getOpenAIEmbeddingModel(runtime: any): string {
    return getSetting(runtime, 'OPENAI_EMBEDDING_MODEL') ?? 'text-embedding-3-small';
}

function getOpenAIEmbeddingDimensions(runtime: any): number | undefined {
    const dimsString = getSetting(runtime, 'OPENAI_EMBEDDING_DIMENSIONS');
    return dimsString ? parseInt(dimsString, 10) : undefined;
}

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

function createVeniceClient(runtime: any) {
    return createOpenAI({
        apiKey: getVeniceApiKey(runtime),
        baseURL: getBaseURL(),
    });
}

const PLUGIN_VERSION = '1.1.2-obj-gen-fix'; // Updated version

export const venicePlugin: Plugin = {
    name: 'venice',
    description: `Venice AI plugin (Handles Inference; Embeddings via OpenAI - v${PLUGIN_VERSION})`,
    config: {
        VENICE_API_KEY: process.env.VENICE_API_KEY,
        VENICE_SMALL_MODEL: process.env.VENICE_SMALL_MODEL,
        VENICE_LARGE_MODEL: process.env.VENICE_LARGE_MODEL,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
        OPENAI_EMBEDDING_DIMENSIONS: process.env.OPENAI_EMBEDDING_DIMENSIONS,
    },
    async init(_config, runtime) {
        logger.info(`[plugin-venice] Initializing v${PLUGIN_VERSION}`);
        if (!getVeniceApiKey(runtime)) {
            logger.warn('[plugin-venice] VENICE_API_KEY is not set - Venice text generation will fail');
        }
        if (!getOpenAIApiKey(runtime)) {
            logger.warn('[plugin-venice] OPENAI_API_KEY is not set - Embeddings via OpenAI will fail');
        }
    },
    models: {
        [ModelType.TEXT_LARGE]: async (
            runtime,
            {
                prompt,
                stopSequences = [],
                maxTokens = 8192,
                temperature = 0.7,
                frequencyPenalty = 0.7,
                presencePenalty = 0.7,
            }: GenerateTextParams
        ) => {
            const venice = createVeniceClient(runtime);
            const model = getLargeModel(runtime);

            const { text: veniceResponse } = await generateText({
                model: venice.languageModel(model),
                prompt: prompt,
                system: runtime.character.system ?? undefined,
                temperature: temperature,
                maxTokens: maxTokens,
                frequencyPenalty: frequencyPenalty,
                presencePenalty: presencePenalty,
                stopSequences: stopSequences,
                // @ts-expect-error Venice.ai parameters are unique to Venice
                venice_parameters: {
                    include_venice_system_prompt: false, // Use our own system prompt
                    top_p: 0.9, // Venice's default top_p value
                },
            });

            return veniceResponse;
        },
        [ModelType.TEXT_SMALL]: async (
            runtime,
            {
                prompt,
                stopSequences = [],
                maxTokens = 8192,
                temperature = 0.7,
                frequencyPenalty = 0.7,
                presencePenalty = 0.7,
            }: GenerateTextParams
        ) => {
            const venice = createVeniceClient(runtime);
            const model = getSmallModel(runtime);

            const { text: veniceResponse } = await generateText({
                model: venice.languageModel(model),
                prompt: prompt,
                system: runtime.character.system ?? undefined,
                temperature: temperature,
                maxTokens: maxTokens,
                frequencyPenalty: frequencyPenalty,
                presencePenalty: presencePenalty,
                stopSequences: stopSequences,
                // @ts-expect-error Venice.ai parameters are unique to Venice
                venice_parameters: {
                    include_venice_system_prompt: false, // Use our own system prompt
                },
            });

            return veniceResponse;
        },
        [ModelType.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
            logger.debug(`[plugin-venice v${PLUGIN_VERSION}] OBJECT_LARGE handler using generateText`);
            const venice = createVeniceClient(runtime);
            const model = getLargeModel(runtime);
            const jsonPrompt = `${params.prompt}\n\nPlease provide your response strictly in JSON format. Do not include any explanatory text before or after the JSON object.`;

            try {
                const { text: jsonText } = await generateText({
                    model: venice.languageModel(model),
                    prompt: jsonPrompt,
                    temperature: params.temperature ?? 0, // Use lower temp for structured output
                    // @ts-expect-error Venice.ai parameters are unique to Venice
                    venice_parameters: {
                        include_venice_system_prompt: false,
                    },
                    // Note: No response_format parameter is sent here by generateText
                });

                // Log the raw text received BEFORE parsing
                logger.debug(`[plugin-venice v${PLUGIN_VERSION}] Raw OBJECT_LARGE text received:`, jsonText);

                try {
                    // Attempt to parse the result as JSON
                    const object = JSON.parse(jsonText);
                    logger.debug(`[plugin-venice v${PLUGIN_VERSION}] Successfully parsed JSON from OBJECT_LARGE`);
                    return object;
                } catch (parseError) {
                    logger.error(`[plugin-venice v${PLUGIN_VERSION}] Failed to parse JSON from OBJECT_LARGE response:`, { jsonText, parseError });
                    throw new Error('Model did not return valid JSON.');
                }
            } catch (error) {
                logger.error(`[plugin-venice v${PLUGIN_VERSION}] Error during OBJECT_LARGE generation via generateText:`, error);
                throw error;
            }
        },
        [ModelType.OBJECT_SMALL]: async (runtime, params: ObjectGenerationParams) => {
            logger.debug(`[plugin-venice v${PLUGIN_VERSION}] OBJECT_SMALL handler using generateText`);
            const venice = createVeniceClient(runtime);
            const model = getSmallModel(runtime);
            const jsonPrompt = `${params.prompt}\n\nPlease provide your response strictly in JSON format. Do not include any explanatory text before or after the JSON object.`;

            try {
                const { text: jsonText } = await generateText({
                    model: venice.languageModel(model),
                    prompt: jsonPrompt,
                    temperature: params.temperature ?? 0, // Use lower temp for structured output
                    // @ts-expect-error Venice.ai parameters are unique to Venice
                    venice_parameters: {
                        include_venice_system_prompt: false,
                    },
                    // Note: No response_format parameter is sent here by generateText
                });

                // Log the raw text received BEFORE parsing
                logger.debug(`[plugin-venice v${PLUGIN_VERSION}] Raw OBJECT_SMALL text received:`, jsonText);

                try {
                    // Attempt to parse the result as JSON
                    const object = JSON.parse(jsonText);
                    logger.debug(`[plugin-venice v${PLUGIN_VERSION}] Successfully parsed JSON from OBJECT_SMALL`);
                    return object;
                } catch (parseError) {
                    logger.error(`[plugin-venice v${PLUGIN_VERSION}] Failed to parse JSON from OBJECT_SMALL response:`, { jsonText, parseError });
                    throw new Error('Model did not return valid JSON.');
                }
            } catch (error) {
                logger.error(`[plugin-venice v${PLUGIN_VERSION}] Error during OBJECT_SMALL generation via generateText:`, error);
                throw error;
            }
        },
        [ModelType.TEXT_EMBEDDING]: async (runtime, params: TextEmbeddingParams): Promise<number[]> => {
            logger.debug(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] Handler entered.`);
            const openaiApiKey = getOpenAIApiKey(runtime);
            const model = getOpenAIEmbeddingModel(runtime);
            const dimensions = getOpenAIEmbeddingDimensions(runtime);
            const hardcodedDimensionFallback = 1536;

            if (!params?.text || params.text.trim() === '') {
                logger.debug(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] Creating test embedding for initialization/empty text`);
                const initDimensions = dimensions ?? hardcodedDimensionFallback;
                const testVector = new Array(initDimensions).fill(0);
                testVector[0] = 0.1;
                return testVector;
            }

            if (!openaiApiKey) {
                logger.error(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] OPENAI_API_KEY is missing. Cannot generate embedding.`);
                const errorDims = dimensions ?? hardcodedDimensionFallback;
                const errorVector = new Array(errorDims).fill(0);
                errorVector[0] = 0.3;
                return errorVector;
            }

            logger.debug(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] Attempting OpenAI API call...`);
            try {
                const payload: { model: string; input: string; dimensions?: number } = {
                    model: model,
                    input: params.text,
                };
                if (dimensions !== undefined) {
                    payload.dimensions = dimensions;
                }
                logger.debug(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] Calling ${OPENAI_BASE_URL}/embeddings with model ${model}`);

                const response = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${openaiApiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                });

                logger.debug(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] Received response status: ${response.status}`);
                if (!response.ok) {
                    let errorBody = 'Could not parse error body';
                    try {
                        errorBody = await response.text();
                    } catch (e) { /* ignore */ }
                    logger.error(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] OpenAI API error: ${response.status} - ${response.statusText}`, { errorBody });
                    throw new Error(`OpenAI API error: ${response.status} - ${response.statusText}`);
                }

                const data = await response.json() as {
                    data: Array<{ embedding: number[] }>;
                    usage: object;
                    model: string;
                };
                logger.debug(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] Successfully parsed OpenAI response.`);

                if (!data?.data?.[0]?.embedding) {
                    logger.error(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] No embedding returned from OpenAI API`, { responseData: data });
                    throw new Error('No embedding returned from OpenAI API');
                }

                const embedding = data.data[0].embedding;
                const embeddingDimensions = embedding.length;

                if (dimensions !== undefined && embeddingDimensions !== dimensions) {
                    logger.warn(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] OpenAI Embedding dimensions mismatch: requested ${dimensions}, got ${embeddingDimensions}`);
                }

                logger.debug(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] Returning embedding with dimensions ${embeddingDimensions}.`);
                return embedding;

            } catch (error) {
                logger.error(`[plugin-venice/OpenAI Embed v${PLUGIN_VERSION}] Error during OpenAI embedding generation process:`, error);
                const errorDims = dimensions ?? hardcodedDimensionFallback;
                const errorVector = new Array(errorDims).fill(0);
                errorVector[0] = 0.2;
                return errorVector;
            }
        },
    }
};

export default venicePlugin; 