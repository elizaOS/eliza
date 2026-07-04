/**
 * Library surface for tooling that wants to call CLI commands and manifest
 * helpers without invoking the Commander binary.
 */

export {
  create,
  info,
  registerPluginsCommand,
  submitPluginToRegistry,
  upgrade,
  version,
} from "./commands/index.js";
export { loadManifest } from "./manifest.js";
export type { TemplateDefinition, TemplatesManifest } from "./types.js";
