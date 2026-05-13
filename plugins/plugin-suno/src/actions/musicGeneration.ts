import type {
    ActionResult,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
} from '@elizaos/core';
import { SunoProvider } from '../providers/suno';

export type SunoMusicSubaction = 'generate' | 'custom_generate' | 'extend';

interface SunoMusicGenerationParams {
    action?: SunoMusicSubaction | string;
    subaction?: SunoMusicSubaction | string;
    operation?: SunoMusicSubaction | string;
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
}

const SUNO_ACTION_TIMEOUT_MS = 30_000;
const MAX_SUNO_RESPONSE_BYTES = 4000;

function paramsFromMessageAndOptions(
    message: Memory,
    options?: Record<string, unknown>
): SunoMusicGenerationParams {
    const content =
        message.content && typeof message.content === 'object'
            ? (message.content as Record<string, unknown>)
            : {};
    const parameters =
        options?.parameters && typeof options.parameters === 'object'
            ? (options.parameters as Record<string, unknown>)
            : {};
    return { ...content, ...options, ...parameters } as SunoMusicGenerationParams;
}

function normalizeSubaction(value: unknown): SunoMusicSubaction | null {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'generate' || normalized === 'extend') return normalized;
    if (
        normalized === 'custom_generate' ||
        normalized === 'custom-generate' ||
        normalized === 'custom'
    ) {
        return 'custom_generate';
    }
    if (normalized === 'extend_audio' || normalized === 'extend-audio') return 'extend';
    return null;
}

function inferSubaction(message: Memory, params: SunoMusicGenerationParams): SunoMusicSubaction {
    const explicit = normalizeSubaction(params.action ?? params.subaction ?? params.operation);
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
        return 'custom_generate';
    }
    return 'generate';
}

function promptFromParams(message: Memory, params: SunoMusicGenerationParams): string {
    const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
    if (prompt) return prompt;
    return (message.content?.text ?? '').trim();
}

function numberOrDefault(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function generationBody(
    params: SunoMusicGenerationParams,
    prompt: string
): Record<string, unknown> {
    return {
        prompt,
        duration: numberOrDefault(params.duration, 30),
        temperature: numberOrDefault(params.temperature, 1.0),
        top_k: numberOrDefault(params.topK, 250),
        top_p: numberOrDefault(params.topP, 0.95),
        classifier_free_guidance: numberOrDefault(params.classifier_free_guidance, 3.0),
    };
}

/**
 * Handler that performs Suno music generation, extension, or custom generation.
 *
 * Used as the implementation of the MUSIC umbrella subactions `generate`,
 * `extend`, and `custom_generate` exposed by `@elizaos/plugin-music`.
 *
 * Returns `success: false` with a clear error message when `SUNO_API_KEY` is
 * not configured or the upstream request fails — callers (including the
 * MUSIC dispatcher) should surface this to the user verbatim.
 */
export const sunoGenerateMusicHandler = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback
): Promise<ActionResult> => {
    const params = paramsFromMessageAndOptions(message, options);
    const subaction = inferSubaction(message, params);

    let provider: SunoProvider;
    try {
        provider = await SunoProvider.get(runtime, message, state);
    } catch (error) {
        const text = `Music generation unavailable: ${
            error instanceof Error ? error.message : String(error)
        }`;
        await callback?.({ text, error: text });
        return { success: false, text, error: text };
    }

    let endpoint = '/generate';
    let body: Record<string, unknown>;

    if (subaction === 'extend') {
        if (!params.audio_id || !params.duration) {
            const text = 'Missing required parameters: audio_id and duration';
            await callback?.({ text });
            return { success: false, text, error: text };
        }
        endpoint = '/extend';
        body = {
            audio_id: params.audio_id,
            duration: params.duration,
        };
    } else {
        const prompt = promptFromParams(message, params);
        if (!prompt) {
            const text = 'Missing required parameter: prompt';
            await callback?.({ text });
            return { success: false, text, error: text };
        }
        body = generationBody(params, prompt);
        if (subaction === 'custom_generate') {
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

    const text =
        subaction === 'extend'
            ? `Successfully extended audio ${params.audio_id}`
            : `Successfully submitted ${subaction} music generation`;
    await callback?.({ text, content: cappedResponse });

    return {
        success: true,
        text,
        data: { action: subaction, subaction, response: cappedResponse },
    };
};

export default sunoGenerateMusicHandler;
