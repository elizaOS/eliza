import type { Plugin } from '@elizaos/core';
import musicGeneration from './actions/musicGeneration';
import { SunoProvider, sunoStatusProvider } from './providers/suno';

export {
    SunoProvider,
    musicGeneration as MusicGeneration,
    musicGeneration as GenerateMusic,
    musicGeneration as CustomGenerateMusic,
    musicGeneration as ExtendAudio,
    sunoStatusProvider,
};

export const sunoPlugin: Plugin = {
    name: 'suno',
    description: 'Suno AI Music Generation Plugin for Eliza',
    actions: [musicGeneration],
    providers: [sunoStatusProvider],
    // Self-declared auto-enable: activate when SUNO_API_KEY is set OR when
    // media.audio is configured to use the suno provider with own-key mode.
    autoEnable: {
        shouldEnable: (env, config) => {
            const key = env.SUNO_API_KEY;
            if (typeof key === 'string' && key.trim() !== '') return true;
            const media = config?.media as Record<string, unknown> | undefined;
            const audio = media?.audio as
                | { enabled?: unknown; mode?: unknown; provider?: unknown }
                | undefined;
            return Boolean(
                audio &&
                    audio.enabled !== false &&
                    audio.mode === 'own-key' &&
                    audio.provider === 'suno'
            );
        },
    },
};

export default sunoPlugin;
