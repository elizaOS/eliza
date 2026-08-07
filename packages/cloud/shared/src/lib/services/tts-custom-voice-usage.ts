/** Persists custom-voice usage only from the detached TTS accounting task. */

import { userVoicesRepository } from "../../db/repositories/user-voices";
import { logger } from "../utils/logger";

export async function recordCustomVoiceUsage(params: {
  elevenLabsVoiceId: string;
  organizationId: string;
}): Promise<{ userVoiceId: string | null; voiceName: string | null }> {
  const voice = await userVoicesRepository.findByElevenLabsVoiceId(params.elevenLabsVoiceId);
  if (voice?.organizationId !== params.organizationId) {
    return { userVoiceId: null, voiceName: null };
  }

  await userVoicesRepository.incrementUsageCount(voice.id).catch((error) => {
    // error-policy:J7 usage enrichment cannot suppress the canonical billing
    // and usage record for audio that was already delivered.
    logger.warn("[Voice TTS] Failed to increment custom voice usage", {
      voiceId: voice.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return { userVoiceId: voice.id, voiceName: voice.name };
}
