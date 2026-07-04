/** Package entry: re-exports the Ollama plugin, its config helpers, and transport types; default export is the plugin. */
import { ollamaPlugin } from "./plugin";

export * from "./types";
export * from "./utils/config";
export { ollamaPlugin };

const defaultOllamaPlugin = ollamaPlugin;

export default defaultOllamaPlugin;
