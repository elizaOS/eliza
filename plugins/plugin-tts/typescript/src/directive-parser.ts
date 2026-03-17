/**
 * TTS directive parser
 *
 * Parses [[tts]] directives from text:
 * - [[tts]] - Simple marker to enable TTS for this message
 * - [[tts:provider=elevenlabs]] - Specify provider
 * - [[tts:voice=alloy]] - Specify voice
 * - [[tts:text]]...[[/tts:text]] - Specify exact text to synthesize
 */

import type { TtsDirective, TtsProvider } from "./types";

// Regex patterns
const TTS_DIRECTIVE_PATTERN = /\[\[tts(?::([^\]]+))?\]\]/gi;
const TTS_TEXT_PATTERN = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
const KEY_VALUE_PATTERN = /(\w+)\s*=\s*([^\s,]+)/g;

/**
 * Check if text contains any TTS directive
 */
export function hasTtsDirective(text: string): boolean {
  return TTS_DIRECTIVE_PATTERN.test(text) || TTS_TEXT_PATTERN.test(text);
}

/**
 * Parse TTS directives from text
 */
export function parseTtsDirective(text: string): TtsDirective | null {
  if (!hasTtsDirective(text)) {
    return null;
  }

  const directive: TtsDirective = {};

  // Extract [[tts:text]]...[[/tts:text]] content
  const textMatch = text.match(TTS_TEXT_PATTERN);
  if (textMatch) {
    // Get the content between tags
    const fullMatch = textMatch[0];
    const contentStart = fullMatch.indexOf("]]") + 2;
    const contentEnd = fullMatch.lastIndexOf("[[");
    directive.text = fullMatch.slice(contentStart, contentEnd).trim();
  }

  // Parse [[tts:key=value]] directives
  TTS_DIRECTIVE_PATTERN.lastIndex = 0;
  let match;
  while ((match = TTS_DIRECTIVE_PATTERN.exec(text)) !== null) {
    const params = match[1];
    if (params) {
      let kvMatch;
      KEY_VALUE_PATTERN.lastIndex = 0;
      while ((kvMatch = KEY_VALUE_PATTERN.exec(params)) !== null) {
        const key = kvMatch[1].toLowerCase();
        const value = kvMatch[2];

        switch (key) {
          case "provider":
            directive.provider = normalizeProvider(value);
            break;
          case "voice":
            directive.voice = value;
            break;
          case "model":
            directive.model = value;
            break;
          case "speed":
            directive.speed = parseFloat(value);
            break;
        }
      }
    }
  }

  return directive;
}

/**
 * Normalize provider name
 */
function normalizeProvider(raw: string): TtsProvider | undefined {
  const normalized = raw.toLowerCase().trim();
  switch (normalized) {
    case "elevenlabs":
    case "eleven":
    case "xi":
      return "elevenlabs";
    case "openai":
    case "oai":
      return "openai";
    case "edge":
    case "microsoft":
    case "ms":
      return "edge";
    case "simple":
    case "simple-voice":
    case "sam":
      return "simple-voice";
    default:
      return undefined;
  }
}

/**
 * Parse a JSON voice directive from the first line of the reply.
 *
 * openclaw-classic format:
 *   { "voice": "abc123", "once": true }
 *   Actual reply text here...
 *
 * Supported keys: voice/voice_id/voiceId, model/model_id/modelId,
 * speed, rate, stability, similarity, style, speakerBoost, once.
 */
export function parseJsonVoiceDirective(
  text: string,
): { directive: TtsDirective; cleanedText: string } | null {
  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1) return null;

  const firstLine = text.slice(0, firstNewline).trim();
  if (!firstLine.startsWith("{") || !firstLine.endsWith("}")) return null;

  try {
    const obj = JSON.parse(firstLine) as Record<string, unknown>;

    // Must have at least one voice-related key
    const voiceKeys = [
      "voice",
      "voice_id",
      "voiceId",
      "model",
      "model_id",
      "modelId",
      "speed",
      "rate",
    ];
    const hasVoiceKey = voiceKeys.some((k) => k in obj);
    if (!hasVoiceKey) return null;

    const directive: TtsDirective = {};

    const voice = obj.voice ?? obj.voice_id ?? obj.voiceId;
    if (typeof voice === "string") directive.voice = voice;

    const model = obj.model ?? obj.model_id ?? obj.modelId;
    if (typeof model === "string") directive.model = model;

    const speed =
      typeof obj.speed === "number"
        ? obj.speed
        : typeof obj.rate === "number"
          ? obj.rate
          : undefined;
    if (speed !== undefined) directive.speed = speed;

    const cleanedText = text.slice(firstNewline + 1).trim();
    return { directive, cleanedText };
  } catch {
    return null;
  }
}

/**
 * Strip TTS directives from text
 */
export function stripTtsDirectives(text: string): string {
  let cleaned = text;

  // Remove [[tts:text]]...[[/tts:text]] blocks
  cleaned = cleaned.replace(TTS_TEXT_PATTERN, "");

  // Remove [[tts:...]] directives
  cleaned = cleaned.replace(TTS_DIRECTIVE_PATTERN, "");

  // Clean up extra whitespace
  return cleaned.replace(/\s+/g, " ").trim();
}

/**
 * Get text to synthesize from message
 * Returns directive text if specified, otherwise the full cleaned text
 */
export function getTtsText(
  text: string,
  directive: TtsDirective | null,
): string {
  if (directive?.text) {
    return directive.text;
  }
  return stripTtsDirectives(text);
}
