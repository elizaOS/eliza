import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { recordLlmCall } from '@elizaos/core';
import { sunoGenerateMusicHandler } from './actions/musicGeneration';
import { SunoProvider } from './providers/suno';

vi.mock('@elizaos/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@elizaos/core')>();
    return {
        ...actual,
        recordLlmCall: vi.fn(async (_runtime, _details, operation) => operation()),
    };
});

function runtime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
    return {
        getSetting: (key: string) => settings[key],
    } as unknown as IAgentRuntime;
}

function message(content: Record<string, unknown>): Memory {
    return { content } as Memory;
}

describe('SunoProvider', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.mocked(recordLlmCall).mockClear();
    });

    it('requires SUNO_API_KEY when constructed from runtime settings', async () => {
        await expect(SunoProvider.get(runtime(), message({ text: 'song' }))).rejects.toThrow(
            'SUNO_API_KEY is required'
        );

        await expect(
            SunoProvider.get(runtime({ SUNO_API_KEY: 'sk-test' }), message({ text: 'song' }))
        ).resolves.toBeInstanceOf(SunoProvider);
    });

    it('sends authenticated JSON requests and records request metadata', async () => {
        const fetchMock = vi.fn(async () => Response.json({ id: 'song-1', status: 'pending' }));
        vi.stubGlobal('fetch', fetchMock);
        const provider = new SunoProvider({ apiKey: 'sk-test', baseUrl: 'https://suno.test/v1' });

        await expect(
            provider.request(runtime(), '/generate', {
                method: 'POST',
                body: JSON.stringify({ prompt: 'ambient', temperature: 0.7 }),
            })
        ).resolves.toEqual({ id: 'song-1', status: 'pending' });

        expect(fetchMock).toHaveBeenCalledWith('https://suno.test/v1/generate', {
            method: 'POST',
            body: JSON.stringify({ prompt: 'ambient', temperature: 0.7 }),
            headers: {
                Authorization: 'Bearer sk-test',
                'Content-Type': 'application/json',
            },
        });
        expect(recordLlmCall).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                model: 'suno',
                userPrompt: JSON.stringify({ prompt: 'ambient', temperature: 0.7 }),
                temperature: 0.7,
                actionType: 'suno.fetch/generate',
                response: JSON.stringify({ suno_response: { id: 'song-1', status: 'pending' } }),
            }),
            expect.any(Function)
        );
    });

    it('throws a normalized error for non-ok API responses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 429, statusText: 'Too Many' })));
        const provider = new SunoProvider({ apiKey: 'sk-test', baseUrl: 'https://suno.test/v1' });

        await expect(provider.request(runtime(), '/generate')).rejects.toThrow(
            'Suno API error: Too Many'
        );
    });
});

describe('sunoGenerateMusicHandler', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('surfaces missing provider configuration through the callback', async () => {
        const callback = vi.fn();

        await expect(
            sunoGenerateMusicHandler(
                runtime(),
                message({ text: 'make a song' }),
                {} as State,
                undefined,
                callback
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Music generation unavailable: SUNO_API_KEY is required',
        });
        expect(callback).toHaveBeenCalledWith({
            text: 'Music generation unavailable: SUNO_API_KEY is required',
            error: 'Music generation unavailable: SUNO_API_KEY is required',
        });
    });

    it('infers custom generation, sends defaulted parameters, and caps oversized responses', async () => {
        const request = vi.fn(async () => ({ id: 'x'.repeat(5000), status: 'pending' }));
        vi.spyOn(SunoProvider, 'get').mockResolvedValue({ request } as unknown as SunoProvider);
        const callback = vi.fn();

        const result = await sunoGenerateMusicHandler(
            runtime({ SUNO_API_KEY: 'sk-test' }),
            message({ text: 'write a custom synthwave track', style: 'synthwave', bpm: 122 }),
            {} as State,
            { parameters: { duration: 45, topP: 0.8 } },
            callback
        );

        expect(request).toHaveBeenCalledWith(
            expect.anything(),
            '/custom-generate',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    prompt: 'write a custom synthwave track',
                    duration: 45,
                    temperature: 1,
                    top_k: 250,
                    top_p: 0.8,
                    classifier_free_guidance: 3,
                    reference_audio: undefined,
                    style: 'synthwave',
                    bpm: 122,
                    key: undefined,
                    mode: undefined,
                }),
            })
        );
        expect(result).toMatchObject({
            success: true,
            data: {
                action: 'custom_generate',
                response: { truncated: true },
            },
        });
        expect(callback).toHaveBeenCalledWith({
            text: 'Successfully submitted custom_generate music generation',
            content: expect.objectContaining({ truncated: true }),
        });
    });

    it('validates extend parameters before making a provider request', async () => {
        const request = vi.fn();
        vi.spyOn(SunoProvider, 'get').mockResolvedValue({ request } as unknown as SunoProvider);
        const callback = vi.fn();

        await expect(
            sunoGenerateMusicHandler(
                runtime({ SUNO_API_KEY: 'sk-test' }),
                message({ text: 'extend this', audio_id: 'audio-1' }),
                {} as State,
                undefined,
                callback
            )
        ).resolves.toMatchObject({
            success: false,
            error: 'Missing required parameters: audio_id and duration',
        });
        expect(request).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            text: 'Missing required parameters: audio_id and duration',
        });
    });
});
