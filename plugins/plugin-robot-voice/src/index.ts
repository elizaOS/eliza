import type { Plugin } from "@elizaos/core";
import { sayAloudAction } from "./actions/sayAloud";
import { SamTTSService } from "./services/SamTTSService";

export { SamTTSService };

export const robotVoicePlugin: Plugin = {
  name: "@elizaos/plugin-robot-voice",
  description: "Retro text-to-speech using SAM Speech Synthesizer with hardware bridge integration",
  actions: [sayAloudAction],
  services: [SamTTSService],
};

export default robotVoicePlugin;
