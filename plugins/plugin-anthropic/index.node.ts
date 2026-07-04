/** Node/Bun build entrypoint — re-exports the plugin; `build.ts` emits it to dist/node. */
import pluginDefault from "./index";

export * from "./index";
export default pluginDefault;
