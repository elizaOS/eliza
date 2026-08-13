/**
 * Node/Bun build entrypoint: installs the Node guarded image-URL fetcher
 * (core's DNS-pinned `fetchRemoteMedia`), then re-exports the plugin from
 * `./index`. The platform split keeps `@elizaos/core/node` out of the browser
 * bundle (#18699).
 */
import pluginDefault from "./index";
import { installNodeImageUrlFetcher } from "./models/image-url.node";

installNodeImageUrlFetcher();

export * from "./index";
export default pluginDefault;
