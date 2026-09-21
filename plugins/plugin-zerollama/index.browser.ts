/** Browser build entrypoint — re-exports the plugin; build.ts emits it to dist/browser. */
import { ollamaPlugin } from "./plugin";

export { ollamaPlugin };
export const zerollamaPlugin = ollamaPlugin;
export default ollamaPlugin;
