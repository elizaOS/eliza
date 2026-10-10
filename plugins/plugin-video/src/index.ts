import type { HttpPlugin as Plugin } from "@elizaos/host/protocol";
import {
  creatorUploadAction,
  discoverMediaAction,
  readVideoTranscriptAction,
} from "./actions";
import {
  mediaStatusAction,
  queueCreatorSummaryAction,
  queueMediaAction,
} from "./jobs";
import { VideoService } from "./services/video";

const videoPlugin: Plugin = {
  name: "video",
  description: "Video processing and transcription capabilities",
  services: [VideoService],
  actions: [
    discoverMediaAction,
    creatorUploadAction,
    readVideoTranscriptAction,
    queueMediaAction,
    queueCreatorSummaryAction,
    mediaStatusAction,
  ],
  providers: [],
  routes: [],
  async dispose(runtime) {
    const svc = runtime.getService<VideoService>(VideoService.serviceType);
    await svc?.stop();
  },
};
export default videoPlugin;

export {
  creatorUploadAction,
  discoverMediaAction,
  readVideoTranscriptAction,
} from "./actions";
export {
  mediaStatusAction,
  queueCreatorSummaryAction,
  queueMediaAction,
} from "./jobs";
export { discoverVideos, findCreatorUpload } from "./services/discovery";
