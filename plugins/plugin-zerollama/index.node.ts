/** Node/Bun build entrypoint — re-exports the plugin; build.ts emits it to dist/node. */
import { ollamaPlugin } from "./plugin";

export { ollamaPlugin };
export const zerollamaPlugin = ollamaPlugin;
export default ollamaPlugin;
