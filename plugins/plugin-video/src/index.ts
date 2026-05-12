import type { Plugin } from "@elizaos/core";
import { VideoService } from "./services/video";

const videoPlugin: Plugin = {
  name: "video",
  description: "Video processing and transcription capabilities",
  services: [VideoService],
  actions: [],
  providers: [],
  routes: [],
};

export default videoPlugin;
