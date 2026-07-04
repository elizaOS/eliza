/**
 * Public entry point for the OpenRouter provider plugin: re-exports the plugin
 * object (both named and default), the plugin-local types, and the `utils/config`
 * setting helpers. Consumers add `@elizaos/plugin-openrouter` to a character's
 * plugin list; `plugin.ts` holds the actual model registrations.
 */
import openrouterPluginImpl from "./plugin";

const openrouterPlugin = openrouterPluginImpl;

export * from "./types";
export * from "./utils/config";
export { openrouterPlugin, openrouterPlugin as default };
