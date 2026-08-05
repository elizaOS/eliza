/** Browser build entry (`dist/browser`): re-exports the Ollama plugin, config helpers, and transport types. */
import { ollamaPlugin } from "./plugin";

export * from "./types";
export * from "./utils/config";
export { ollamaPlugin };

const defaultOllamaPlugin = ollamaPlugin;

export default defaultOllamaPlugin;
