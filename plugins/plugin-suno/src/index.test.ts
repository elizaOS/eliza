import { describe, expect, it } from 'vitest';

import sunoPlugin, { SunoProvider, sunoStatusProvider } from './index';

describe('sunoPlugin', () => {
    it('exports the Suno provider and status provider', () => {
        expect(sunoPlugin.name).toBe('suno');
        expect(sunoPlugin.providers).toContain(sunoStatusProvider);
        expect(SunoProvider).toBeTypeOf('function');
    });

    it('auto-enables when SUNO_API_KEY is configured', () => {
        expect(sunoPlugin.autoEnable?.shouldEnable({ SUNO_API_KEY: 'sk-live' }, {})).toBe(true);
    });

    it('auto-enables for own-key Suno audio config', () => {
        expect(
            sunoPlugin.autoEnable?.shouldEnable(
                {},
                {
                    media: {
                        audio: {
                            enabled: true,
                            mode: 'own-key',
                            provider: 'suno',
                        },
                    },
                }
            )
        ).toBe(true);
    });

    it('stays disabled without a key or matching audio config', () => {
        expect(sunoPlugin.autoEnable?.shouldEnable({}, {})).toBe(false);
    });
});
