// Stub module for @elizaos/plugin-* packages whose npm dist has broken
// @elizaos/core resolution. Exports a minimal valid Plugin shape so
// AgentRuntime.registerPlugin() doesn't throw.
const plugin = { name: "stub-plugin", description: "test stub" };
export default plugin;
export const elizaPlugin = plugin;
