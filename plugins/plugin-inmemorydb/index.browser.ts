/** Browser build entry point; re-exports the Node entry (`./index`) since the adapter is platform-agnostic. */
import plugin from "./index";

export * from "./index";
export default plugin;
