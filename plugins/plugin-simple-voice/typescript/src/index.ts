import type { Plugin } from '@elizaos/core';
import { sayAloudAction } from './actions/sayAloud';
import { SamTTSService } from './services/SamTTSService';

/**
 * Simple Voice Plugin - Retro TTS using SAM Speech Synthesizer
 *
 * Provides classic 1980s text-to-speech capabilities using the SAM synthesizer.
 * Integrates with the hardware bridge to send audio directly to user speakers.
 */
export const simpleVoicePlugin: Plugin = {
  name: '@elizaos/plugin-simple-voice',
  description: 'Retro text-to-speech using SAM Speech Synthesizer with hardware bridge integration',
  actions: [sayAloudAction],
  services: [SamTTSService],
};

export default simpleVoicePlugin;

// Re-export components
export { sayAloudAction } from './actions/sayAloud';
export { SamTTSService } from './services/SamTTSService';
export * from './types';

