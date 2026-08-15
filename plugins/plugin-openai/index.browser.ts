/**
 * Browser build entrypoint: installs the browser guarded transcription-URL
 * fetcher (literal-host SSRF policy, byte cap, abort timeout — no Node
 * subpaths), then re-exports the plugin from `./index` (#18702).
 */
import pluginDefault from "./index";
import { installBrowserTranscriptionUrlFetcher } from "./models/transcription-url.browser";

installBrowserTranscriptionUrlFetcher();

export * from "./index";
export default pluginDefault;
