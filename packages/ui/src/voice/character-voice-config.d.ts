import type { VoiceConfig } from "../api/client";
import type { DefaultVoiceProviderResult } from "./voice-provider-defaults";
export declare function resolveCharacterVoiceConfigFromAppConfig(args: {
  config: Record<string, unknown>;
  uiLanguage: string;
}): {
  voiceConfig: VoiceConfig | null;
  shouldPersist: boolean;
};
export declare function applyVoiceProviderDefaults(
  config: VoiceConfig | null,
  defaults: DefaultVoiceProviderResult,
): VoiceConfig;
//# sourceMappingURL=character-voice-config.d.ts.map
