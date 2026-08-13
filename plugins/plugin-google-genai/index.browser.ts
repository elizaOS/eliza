/**
 * Browser build entrypoint: installs the browser guarded image-URL fetcher
 * (literal-host SSRF policy, byte cap, abort timeout — no Node subpaths),
 * then re-exports the plugin from `./index` (#18699).
 */
import pluginDefault from "./index";
import { installBrowserImageUrlFetcher } from "./models/image-url.browser";

installBrowserImageUrlFetcher();

export * from "./index";
export default pluginDefault;
