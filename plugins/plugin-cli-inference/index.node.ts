/** Node entry point: re-exports the full plugin (the real CLI/SDK handlers). */
import pluginDefault from "./index";

export * from "./index";
export default pluginDefault;
