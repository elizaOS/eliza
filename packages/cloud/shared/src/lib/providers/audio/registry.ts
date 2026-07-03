import { elevenLabsAudioProvider } from "./elevenlabs-audio-generation";
import { falAudioProvider } from "./fal-audio-generation";
import { sunoAudioProvider } from "./suno-audio-generation";
import type { AudioProvider, AudioProviderId } from "./types";

const PROVIDERS = new Map<AudioProviderId, AudioProvider>();

export function registerAudioProvider(provider: AudioProvider) {
  PROVIDERS.set(provider.billingSource, provider);
}

export function getAudioProvider(billingSource: AudioProviderId): AudioProvider {
  const provider = PROVIDERS.get(billingSource);
  if (!provider) {
    throw new Error(`No audio provider registered for billing source: ${billingSource}`);
  }
  return provider;
}

export const DEFERRED_AUDIO_PROVIDERS = [
  {
    modelFamily: "fal-ai/stable-audio",
    provider: "fal",
    sourceUrl: "https://fal.ai/models/fal-ai/stable-audio",
    rationale:
      "Stable Audio is an SFX/music candidate, but no supported catalog/pricing row is wired yet.",
  },
  {
    modelFamily: "fal-ai/mmaudio-v2",
    provider: "fal",
    sourceUrl: "https://fal.ai/models/fal-ai/mmaudio-v2/text-to-audio",
    rationale:
      "MMAudio is a text/video-to-audio candidate; defer until route inputs and pricing distinguish SFX/video-audio use.",
  },
  {
    modelFamily: "elevenlabs/sound-effects",
    provider: "elevenlabs",
    sourceUrl: "https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert",
    rationale:
      "ElevenLabs sound effects needs a distinct catalog row and request shape before enabling.",
  },
] as const;

registerAudioProvider(falAudioProvider);
registerAudioProvider(elevenLabsAudioProvider);
registerAudioProvider(sunoAudioProvider);
