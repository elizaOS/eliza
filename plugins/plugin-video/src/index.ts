import { VideoService } from "./services/video";
import { type HttpPlugin as Plugin } from "@elizaos/shared";
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
