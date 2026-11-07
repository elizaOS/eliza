/** Built-in OpenAI speech voices are not ElevenLabs voice IDs. */
const OPENAI_VOICE_ALIASES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);

export function isOpenAiVoiceAlias(voice: string): boolean {
  return OPENAI_VOICE_ALIASES.has(voice.trim().toLowerCase());
}
