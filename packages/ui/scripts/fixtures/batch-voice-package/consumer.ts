import { ElizaError, sanitizeSpeechText } from "@elizaos/core/speech";
import {
  BatchVoiceConversation,
  type BatchVoicePorts,
} from "@elizaos/ui/voice/batch-conversation";
import {
  buildVoiceTurnSignal,
  type VoiceTurnSignal,
} from "@elizaos/voice/turn";

export function createConversation(ports: BatchVoicePorts<Blob>) {
  const signal: VoiceTurnSignal = buildVoiceTurnSignal("Hello.", {});
  const text: string = sanitizeSpeechText("Hello.");
  const error: Error = new ElizaError(text, { code: "CONSUMER_CHECK" });
  return { conversation: new BatchVoiceConversation(ports), signal, error };
}
