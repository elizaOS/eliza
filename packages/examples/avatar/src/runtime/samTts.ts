import type { AgentRuntime } from "@elizaos/core";
import { SamTTSService } from "@elizaos/plugin-simple-voice";

export type SamOptions = {
  speed: number;
  pitch: number;
  throat: number;
  mouth: number;
};

/**
 * Sanitize text for SAM TTS by replacing or removing characters it can't handle.
 * SAM only supports basic ASCII characters.
 */
function sanitizeForSam(text: string): string {
  return text
    // Replace em/en dashes with regular hyphen
    .replace(/[—–]/g, "-")
    // Replace smart quotes with regular quotes
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    // Replace ellipsis with three dots
    .replace(/…/g, "...")
    // Replace other common Unicode punctuation
    .replace(/[•·]/g, "-")
    .replace(/[«»]/g, '"')
    // Remove any remaining non-ASCII characters
    .replace(/[^\x00-\x7F]/g, "")
    // Collapse multiple spaces
    .replace(/\s+/g, " ")
    .trim();
}

export function synthesizeSamWav(runtime: AgentRuntime, text: string, options: SamOptions): ArrayBuffer {
  const service = runtime.getService("SAM_TTS") as SamTTSService | null;
  if (!service) {
    throw new Error("SAM_TTS service is not available (plugin-simple-voice not loaded?)");
  }
  const sanitized = sanitizeForSam(text);
  const audio = service.generateAudio(sanitized, options);
  const wav = service.createWAVBuffer(audio);
  // Ensure return is a plain ArrayBuffer (not SharedArrayBuffer)
  const out = new Uint8Array(wav.byteLength);
  out.set(wav);
  return out.buffer;
}

export function splitForTts(text: string, maxChunkChars = 220): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Basic sentence-ish splitting with a hard cap.
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
    // If a sentence is huge, chunk it.
    for (let i = 0; i < part.length; i += maxChunkChars) {
      out.push(part.slice(i, i + maxChunkChars));
    }
  }
  return out;
}

