/**
 * elizaOS CLI - Public API
 */

export { create, info, upgrade, version } from "./commands/index.js";
export { loadManifest } from "./manifest.js";
export type { TemplateDefinition, TemplatesManifest } from "./types.js";
