import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordLlmCallMock = vi.hoisted(() =>
    vi.fn(async (_runtime, _details, fn: () => Promise<unknown>) => fn())
);

vi.mock('@elizaos/core', () => ({
    parseJSONObjectFromText: (text: string) => JSON.parse(text),
    recordLlmCall: recordLlmCallMock,
}));

import { musicGeneration } from './musicGeneration';

describe('MUSIC_GENERATION', () => {
    beforeEach(() => {
        recordLlmCallMock.mockClear();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify({ id: 'song-1', status: 'pending' })))
        );
    });

    it('wraps Suno generation fetches in recordLlmCall', async () => {
        const runtime = {
            getSetting: vi.fn((key: string) => (key === 'SUNO_API_KEY' ? 'test-key' : undefined)),
        };
        const callback = vi.fn(async () => []);

        const result = await musicGeneration.handler(
            runtime as never,
            {
                content: { text: 'generate a jazz loop' },
            } as never,
            {} as never,
            {
                parameters: {
                    subaction: 'custom',
                    prompt: 'A jazz loop with brushed drums',
                    style: 'jazz',
                    bpm: 92,
                },
            },
            callback
        );

        expect(result).toMatchObject({
            success: true,
            data: { subaction: 'custom' },
        });
        expect(recordLlmCallMock).toHaveBeenCalledTimes(1);
        expect(recordLlmCallMock.mock.calls[0]?.[1]).toMatchObject({
            model: 'suno',
            purpose: 'action',
            actionType: 'suno.fetch/custom-generate',
        });
        expect(fetch).toHaveBeenCalledWith(
            'https://api.suno.ai/v1/custom-generate',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"style":"jazz"'),
            })
        );
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                text: 'Successfully submitted custom music generation',
            })
        );
    });
});
