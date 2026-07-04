/** Node build entry: re-exports the plugin from index.ts as the node bundle's default. */
import pluginDefault from "./index";

export * from "./index";
export default pluginDefault;
