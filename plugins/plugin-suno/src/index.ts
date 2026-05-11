import type { Plugin } from '@elizaos/core';
import {
    sunoGenerateMusicHandler,
    type SunoMusicSubaction,
} from './actions/musicGeneration';
import { SunoProvider, sunoStatusProvider } from './providers/suno';

export {
    SunoProvider,
    sunoGenerateMusicHandler,
    sunoStatusProvider,
    type SunoMusicSubaction,
};

export const sunoPlugin: Plugin = {
    name: 'suno',
    description:
        'Suno AI music generation backend for Eliza. Generation is dispatched through the MUSIC umbrella (action=generate|extend|custom_generate); this plugin contributes only the Suno client and status provider.',
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
