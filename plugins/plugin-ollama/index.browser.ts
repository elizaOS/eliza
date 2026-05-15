import { ollamaPlugin } from "./plugin";

export * from "./types";
export * from "./utils/config";
export { ollamaPlugin };

const defaultOllamaPlugin = ollamaPlugin;

export default defaultOllamaPlugin;
