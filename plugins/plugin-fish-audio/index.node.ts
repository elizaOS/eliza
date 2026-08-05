/** Node entrypoint for the Fish Audio plugin. */
import WebSocket from "ws";
import { configureFishAudioWebSocketFactory } from "./src/index";

configureFishAudioWebSocketFactory(
  (url, options) => new WebSocket(url, { headers: options.headers }),
);

export {
  default,
  fishAudioPlugin,
  handleFishAudioTextToSpeech,
} from "./src/index";
