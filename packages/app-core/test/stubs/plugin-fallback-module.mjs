// Fallback module for plugin packages whose published entrypoint is missing.
// Exports a minimal plugin shape so plugin registration logic can still load.
const plugin = { name: "fallback-plugin", description: "test fallback" };
export default plugin;
export const elizaPlugin = plugin;
