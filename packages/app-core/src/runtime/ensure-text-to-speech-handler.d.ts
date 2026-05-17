import { type AgentRuntime } from "@elizaos/core";
export interface EdgeTtsConfig {
  plugins?: {
    entries?: {
      "edge-tts"?: {
        enabled?: boolean;
      };
    };
  };
}
export declare function isEdgeTtsDisabled(config: EdgeTtsConfig): boolean;
/**
 * `@elizaos/agent` boot calls its own `collectPluginNames`, so the app wrapper
 * that adds Edge TTS is bypassed. Register the Edge TTS model handler on the
 * live runtime so streaming / swarm voice can still resolve TEXT_TO_SPEECH.
 */
export declare function ensureTextToSpeechHandler(
  runtime: AgentRuntime,
): Promise<void>;
//# sourceMappingURL=ensure-text-to-speech-handler.d.ts.map
