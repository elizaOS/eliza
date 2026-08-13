/**
 * Node build entrypoint: installs the Node guarded transcription-URL fetcher
 * (core's DNS-pinned `fetchRemoteMedia`), then re-exports the plugin from
 * `./index`. The platform split keeps `@elizaos/core/node` out of the browser
 * bundle (#18702).
 */
import pluginDefault from "./index";
import { installNodeTranscriptionUrlFetcher } from "./models/transcription-url.node";

installNodeTranscriptionUrlFetcher();

export * from "./index";
export default pluginDefault;
