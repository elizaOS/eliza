/** Unit tests asserting Suno subaction routing is i18n-safe: enum/params only, never text keywords. */
import { describe, expect, it } from 'vitest';
import { inferSubaction } from './musicGeneration';

/**
 * #10471 — the Suno subaction must come from the planner-emitted enum or the
 * structured params, never from English keywords in the user text. The old
 * `/\b(extend|lengthen|longer)\b/` / `/\b(custom|style|bpm)\b/` regexes silently
 * failed for every non-English request.
 */
describe('suno inferSubaction is i18n-safe (#10471)', () => {
    it('routes by the explicit subaction enum (+ aliases)', () => {
        expect(inferSubaction({ action: 'extend' })).toBe('extend');
        expect(inferSubaction({ action: 'custom-generate' })).toBe('custom_generate');
        expect(inferSubaction({ subaction: 'generate' })).toBe('generate');
    });

    it('routes by structured params, not text', () => {
        expect(inferSubaction({ audio_id: 'abc' })).toBe('extend');
        expect(inferSubaction({ style: 'lofi' })).toBe('custom_generate');
        expect(inferSubaction({ bpm: 120 })).toBe('custom_generate');
    });

    it('defaults to generate without inferring from natural-language text', () => {
        // The params carry no structured signal; the result is `generate` in any
        // language. The old English regexes would have mis-fired on the text.
        expect(inferSubaction({})).toBe('generate');
        expect(inferSubaction({ prompt: 'haz una canción más larga' })).toBe('generate');
    });
});
