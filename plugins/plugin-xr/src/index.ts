import type { Plugin } from "@elizaos/core";
import { xrQueryVisionAction } from "./actions/xr-query-vision.ts";
import { xrContextProvider } from "./providers/xr-context.ts";
import { xrConnectRoute } from "./routes/xr-connect.ts";
import { xrSimulatorRoute } from "./routes/xr-simulator-route.ts";
import { xrStatusRoute } from "./routes/xr-status.ts";
import { XRSessionService } from "./services/xr-session-service.ts";

export type * from "./protocol.ts";
export { AudioPipeline } from "./services/audio-pipeline.ts";
export { VisionPipeline } from "./services/vision-pipeline.ts";
export {
  XR_SERVICE_TYPE,
  XR_WS_PORT_DEFAULT,
  XRSessionService,
} from "./services/xr-session-service.ts";

export const xrPlugin: Plugin = {
  name: "@elizaos/plugin-xr",
  description:
    "Streams audio and camera video from XR headsets (Quest 3, XReal) to the agent and delivers voice responses back.",

  services: [XRSessionService],
  actions: [xrQueryVisionAction],
  providers: [xrContextProvider],
  routes: [xrStatusRoute, xrConnectRoute, xrSimulatorRoute],

  config: {
    XR_WS_PORT: 31338,
  },
};

export default xrPlugin;
