/**
 * Resolves the elizaOS CLI version at load time from package metadata and
 * exports it as CLI_VERSION for `--version` output and diagnostics.
 */
import { resolveElizaVersion } from "@elizaos/agent";

export const CLI_VERSION = resolveElizaVersion(import.meta.url);
