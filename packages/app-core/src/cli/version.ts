import { resolveElizaVersion } from "@elizaos/agent/version-resolver";

export const CLI_VERSION = resolveElizaVersion(import.meta.url);
