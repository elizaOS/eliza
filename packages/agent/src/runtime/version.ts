import { resolveElizaVersion } from "../version-resolver.ts";

// Single source of truth for the current Eliza version.
// - Embedded/bundled builds: injected define or env var.
// - Dev/npm builds: package.json or build-info fallback.
export const VERSION = resolveElizaVersion(import.meta.url);
