import type { Plugin } from "@elizaos/core";
import { VideoService } from "./services/video";

const videoPlugin: Plugin = {
  name: "video",
  description: "Video processing and transcription capabilities",
  services: [VideoService],
  actions: [],
  providers: [],
  routes: [],
  async dispose(runtime) {
    const svc = runtime.getService<VideoService>(VideoService.serviceType);
    await svc?.stop();
  },
};

export default videoPlugin;
