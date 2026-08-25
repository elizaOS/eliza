/** Node entrypoint for the Fish Audio plugin. */

import { createFishAudioNodeWebSocketFactory } from "./node-transport";
import { configureFishAudioWebSocketFactory } from "./src/index";

configureFishAudioWebSocketFactory(createFishAudioNodeWebSocketFactory());

export { createFishAudioNodeWebSocketFactory } from "./node-transport";
export type { FishAudioFailureClassification } from "./src/index";
export {
  classifyFishAudioFailure,
  default,
  fishAudioPlugin,
  handleFishAudioTextToSpeech,
} from "./src/index";
