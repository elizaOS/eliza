/** Browser build entrypoint: re-exports the plugin from `./index` unchanged. */
import pluginDefault from "./index";

export * from "./index";
export default pluginDefault;
