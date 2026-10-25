/**
 * Resolves the running Eliza version once at import and exposes it as the
 * VERSION constant consumed across the agent package.
 */
import { resolveElizaVersion } from "../version-resolver.ts";

// Single source of truth for the current Eliza version.
// - Embedded/bundled builds: injected define or env var.
// - Dev/npm builds: package.json or build-info fallback.
export const VERSION = resolveElizaVersion(import.meta.url);
