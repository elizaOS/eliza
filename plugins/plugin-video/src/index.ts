import { Plugin } from "@elizaos/core";
import { VideoService } from "./services/video";

const videoPlugin: Plugin = {
  name: "video",
  description: "Video processing and transcription capabilities",
  services: [VideoService],
  actions: [],
  providers: [],
  evaluators: [],
  routes: [],
};

export default videoPlugin;
