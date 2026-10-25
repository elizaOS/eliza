/**
 * First-speakable-phrase detection for streaming LLM output.
 *
 * The benchmark starts TTS as soon as a short phrase boundary is available,
 * matching voice-agent behavior where audio generation should not wait for the
 * full assistant response.
 */

const PHRASE_BOUNDARY = /[.!?,;:](?:\s|$)|\n/;

export function firstSpeakablePhrase(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const boundary = trimmed.search(PHRASE_BOUNDARY);
  if (boundary >= 0) return trimmed.slice(0, boundary + 1).trim();
  const words = trimmed.split(/\s+/);
  if (words.length >= 6) return words.slice(0, 6).join(" ");
  return trimmed;
}
