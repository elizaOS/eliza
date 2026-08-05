/** Gates Character voice writes on a successfully loaded configuration boundary. */

import type { CharacterEditorVoiceConfig } from "./character-voice-config";

export interface CharacterVoiceConfigWriter {
  updateConfig(config: {
    messages: { tts: CharacterEditorVoiceConfig };
  }): Promise<unknown>;
}

/** Returns false without writing while startup config/auth is not ready. */
export async function persistCharacterVoiceSelection(args: {
  configReady: boolean;
  voiceConfig: CharacterEditorVoiceConfig;
  writer: CharacterVoiceConfigWriter;
}): Promise<boolean> {
  if (!args.configReady) return false;
  await args.writer.updateConfig({
    messages: {
      tts: args.voiceConfig,
    },
  });
  return true;
}
