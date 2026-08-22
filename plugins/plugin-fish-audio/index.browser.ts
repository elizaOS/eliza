/** Browser entrypoint for the Fish Audio plugin. */
import { ElizaError } from "@elizaos/core";
import { configureFishAudioWebSocketFactory } from "./src/index";

configureFishAudioWebSocketFactory(() => {
  throw new ElizaError(
    "Fish Audio TTS requires a server runtime because browsers cannot attach the Authorization header to WebSocket upgrades",
    { code: "FISH_AUDIO_BROWSER_UNSUPPORTED" },
  );
});

export type { FishAudioFailureClassification } from "./src/index";
export {
  classifyFishAudioFailure,
  default,
  fishAudioPlugin,
  handleFishAudioTextToSpeech,
} from "./src/index";
