/** Browser build entrypoint — re-exports the plugin; `build.ts` emits it to dist/browser (no node:* / process.env). */
import pluginDefault from "./index";

export * from "./index";
export default pluginDefault;
