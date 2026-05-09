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
};

export default sunoPlugin;
