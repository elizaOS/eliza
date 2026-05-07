import {
    type IAgentRuntime,
    type Memory,
    type Provider,
    type RecordLlmCallDetails,
    recordLlmCall,
    type State,
} from '@elizaos/core';

export interface SunoConfig {
    apiKey: string;
    baseUrl?: string;
}

export class SunoProvider {
    private apiKey: string;
    private baseUrl: string;

    static async get(
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<SunoProvider> {
        const apiKey = runtime.getSetting('SUNO_API_KEY');
        if (typeof apiKey !== 'string' || !apiKey) {
            throw new Error('SUNO_API_KEY is required');
        }
        return new SunoProvider({ apiKey });
    }

    constructor(config: SunoConfig) {
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl || 'https://api.suno.ai/v1';
    }

    async get(
        _runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<{ status: string }> {
        return { status: 'ready' };
    }

    async request(runtime: IAgentRuntime, endpoint: string, options: RequestInit = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...options.headers,
        };

        const body = typeof options.body === 'string' ? options.body : '';
        const details: RecordLlmCallDetails = {
            model: 'suno',
            modelVersion: 'api-v1',
            systemPrompt: 'Suno music generation API request',
            userPrompt: body,
            temperature: readTemperature(body),
            maxTokens: 0,
            purpose: 'action',
            actionType: `suno.fetch${endpoint}`,
        };

        return recordLlmCall(runtime, details, async () => {
            const response = await fetch(url, {
                ...options,
                headers,
            });

            if (!response.ok) {
                throw new Error(`Suno API error: ${response.statusText}`);
            }

            const data = await response.json();
            details.response = JSON.stringify({ suno_response: data });
            return data;
        });
    }
}

function readTemperature(body: string): number {
    if (!body) return 0;
    try {
        const parsed = JSON.parse(body) as { temperature?: unknown };
        return typeof parsed.temperature === 'number' ? parsed.temperature : 0;
    } catch {
        return 0;
    }
}

export const sunoStatusProvider: Provider = {
    name: 'SUNO_STATUS',
    description: 'Suno music generation status',
    descriptionCompressed: 'Suno generation availability.',
    contexts: ["media"],
    contextGate: { anyOf: ["media"] },
    cacheStable: false,
    cacheScope: "turn",
    get: async (runtime: IAgentRuntime) => {
        const configured = Boolean(runtime.getSetting('SUNO_API_KEY'));
        return {
            text: JSON.stringify({
                suno: {
                    configured,
                    status: configured ? 'ready' : 'missing_api_key',
                    action: 'MUSIC_GENERATION',
                    subactions: ['generate', 'custom', 'extend'],
                },
            }, null, 2),
            data: { configured },
            values: { sunoConfigured: configured },
        };
    },
};

export interface GenerateParams {
    prompt: string;
    duration?: number;
    temperature?: number;
    topK?: number;
    topP?: number;
    classifier_free_guidance?: number;
}

export interface CustomGenerateParams extends GenerateParams {
    reference_audio?: string;
    style?: string;
    bpm?: number;
    key?: string;
    mode?: string;
}

export interface ExtendParams {
    audio_id: string;
    duration: number;
}

export interface GenerationResponse {
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    audio_url?: string;
    error?: string;
}
