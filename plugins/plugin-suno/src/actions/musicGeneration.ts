import type {
    Action,
    ActionResult,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
} from '@elizaos/core';
import { SunoProvider } from '../providers/suno';

type MusicGenerationSubaction = 'generate' | 'custom' | 'extend';

type MusicGenerationParams = {
    subaction?: MusicGenerationSubaction | string;
    operation?: MusicGenerationSubaction | string;
    prompt?: string;
    duration?: number;
    temperature?: number;
    topK?: number;
    topP?: number;
    classifier_free_guidance?: number;
    reference_audio?: string;
    style?: string;
    bpm?: number;
    key?: string;
    mode?: string;
    audio_id?: string;
};

const SUNO_ACTION_TIMEOUT_MS = 30_000;
const MAX_SUNO_RESPONSE_BYTES = 4000;

function paramsFromMessageAndOptions(
    message: Memory,
    options?: Record<string, unknown>
): MusicGenerationParams {
    const content =
        message.content && typeof message.content === 'object'
            ? (message.content as Record<string, unknown>)
            : {};
    const parameters =
        options?.parameters && typeof options.parameters === 'object'
            ? (options.parameters as Record<string, unknown>)
            : {};
    return { ...content, ...options, ...parameters } as MusicGenerationParams;
}

function normalizeSubaction(value: unknown): MusicGenerationSubaction | null {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'generate' || normalized === 'custom' || normalized === 'extend') {
        return normalized;
    }
    if (normalized === 'custom_generate' || normalized === 'custom-generate') return 'custom';
    if (normalized === 'extend_audio' || normalized === 'extend-audio') return 'extend';
    return null;
}

function inferSubaction(message: Memory, params: MusicGenerationParams): MusicGenerationSubaction {
    const explicit = normalizeSubaction(params.subaction ?? params.operation);
    if (explicit) return explicit;
    const text = (message.content?.text ?? '').toLowerCase();
    if (params.audio_id || /\b(extend|lengthen|longer|add \d+.*seconds?)\b/.test(text)) {
        return 'extend';
    }
    if (
        params.reference_audio ||
        params.style ||
        params.bpm ||
        params.key ||
        params.mode ||
        /\b(custom|style|bpm|key|mode|reference)\b/.test(text)
    ) {
        return 'custom';
    }
    return 'generate';
}

function promptFromParams(message: Memory, params: MusicGenerationParams): string {
    const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
    if (prompt) return prompt;
    return (message.content?.text ?? '').trim();
}

function numberOrDefault(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function generationBody(params: MusicGenerationParams, prompt: string): Record<string, unknown> {
    return {
        prompt,
        duration: numberOrDefault(params.duration, 30),
        temperature: numberOrDefault(params.temperature, 1.0),
        top_k: numberOrDefault(params.topK, 250),
        top_p: numberOrDefault(params.topP, 0.95),
        classifier_free_guidance: numberOrDefault(params.classifier_free_guidance, 3.0),
    };
}

export const musicGeneration: Action = {
    name: 'MUSIC_GENERATION',
    contexts: ['media'],
    contextGate: { anyOf: ['media'] },
    roleGate: { minRole: 'USER' },
    description:
        'Generate music through Suno. Use subaction generate for a simple prompt, custom for style/BPM/key/reference parameters, or extend for an existing audio_id and duration.',
    descriptionCompressed: 'Suno music generation router subaction: generate, custom, extend.',
    similes: [
        'GENERATE_MUSIC',
        'CREATE_MUSIC',
        'MAKE_MUSIC',
        'COMPOSE_MUSIC',
        'CUSTOM_GENERATE_MUSIC',
        'EXTEND_AUDIO',
    ],
    parameters: [
        {
            name: 'subaction',
            description: 'Suno operation: generate, custom, or extend.',
            required: false,
            schema: { type: 'string', enum: ['generate', 'custom', 'extend'] },
        },
        {
            name: 'prompt',
            description: 'Music prompt for generate/custom.',
            required: false,
            schema: { type: 'string' },
        },
        {
            name: 'audio_id',
            description: 'Existing Suno audio id for extend.',
            required: false,
            schema: { type: 'string' },
        },
        {
            name: 'duration',
            description: 'Generation duration or extension seconds.',
            required: false,
            schema: { type: 'number', default: 30 },
        },
    ],
    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (!runtime.getSetting('SUNO_API_KEY')) return false;
        const text = (message.content?.text ?? '').toLowerCase();
        return /\b(generate|create|make|compose|extend|music|song|audio|track)\b/.test(text);
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: Record<string, unknown> | undefined,
        callback?: HandlerCallback
    ): Promise<ActionResult> => {
        try {
            const params = paramsFromMessageAndOptions(message, options);
            const subaction = inferSubaction(message, params);
            const provider = await SunoProvider.get(runtime, message, state);

            let endpoint = '/generate';
            let body: Record<string, unknown>;

            if (subaction === 'extend') {
                if (!params.audio_id || !params.duration) {
                    throw new Error('Missing required parameters: audio_id and duration');
                }
                endpoint = '/extend';
                body = {
                    audio_id: params.audio_id,
                    duration: params.duration,
                };
            } else {
                const prompt = promptFromParams(message, params);
                if (!prompt) {
                    throw new Error('Missing required parameter: prompt');
                }
                body = generationBody(params, prompt);
                if (subaction === 'custom') {
                    endpoint = '/custom-generate';
                    body = {
                        ...body,
                        reference_audio: params.reference_audio,
                        style: params.style,
                        bpm: params.bpm,
                        key: params.key,
                        mode: params.mode,
                    };
                }
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), SUNO_ACTION_TIMEOUT_MS);
            const response = await provider
                .request(runtime, endpoint, {
                    method: 'POST',
                    body: JSON.stringify(body),
                    signal: controller.signal,
                })
                .finally(() => clearTimeout(timeout));
            const cappedResponse =
                JSON.stringify(response).length > MAX_SUNO_RESPONSE_BYTES
                    ? {
                          truncated: true,
                          preview: JSON.stringify(response).slice(0, MAX_SUNO_RESPONSE_BYTES),
                      }
                    : response;

            await callback?.({
                text:
                    subaction === 'extend'
                        ? `Successfully extended audio ${params.audio_id}`
                        : `Successfully submitted ${subaction} music generation`,
                content: cappedResponse,
            });

            return {
                success: true,
                text:
                    subaction === 'extend'
                        ? `Successfully extended audio ${params.audio_id}`
                        : `Successfully submitted ${subaction} music generation`,
                data: { subaction, response: cappedResponse },
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const text = `Music generation failed: ${errorMessage}`;
            await callback?.({
                text,
                error,
            });
            return { success: false, text, error: errorMessage };
        }
    },
    examples: [
        [
            {
                name: '{{user1}}',
                content: {
                    text: 'Generate a relaxing ambient track',
                    prompt: 'A peaceful ambient soundscape with gentle waves and soft pads',
                    duration: 45,
                },
            },
            {
                name: '{{agent}}',
                content: {
                    text: "I'll generate a calming ambient piece.",
                    action: 'MUSIC_GENERATION',
                },
            },
        ],
    ],
};

export default musicGeneration;
