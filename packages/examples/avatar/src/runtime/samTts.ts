/**
 * SAM TTS shim. The original implementation depended on
 * `@elizaos/plugin-robot-voice`'s SamTTSService. That plugin has been
 * removed; this stub keeps the avatar example compiling. Calling
 * `synthesizeSamWav` throws so the caller falls through to ElevenLabs.
 */

import type { AgentRuntime } from "@elizaos/core";

type SamOptions = {
  speed: number;
  pitch: number;
  throat: number;
  mouth: number;
};

export function synthesizeSamWav(
  _runtime: AgentRuntime,
  _text: string,
  _options: SamOptions,
): ArrayBuffer {
  throw new Error(
    "SAM TTS is no longer bundled. Configure ELEVENLABS_API_KEY to use ElevenLabs TTS.",
  );
}

export function splitForTts(text: string, maxChunkChars = 220): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const parts = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const out: string[] = [];
  for (const part of parts) {
    if (part.length <= maxChunkChars) {
      out.push(part);
      continue;
    }
    for (let i = 0; i < part.length; i += maxChunkChars) {
      out.push(part.slice(i, i + maxChunkChars));
    }
  }
  return out;
}
