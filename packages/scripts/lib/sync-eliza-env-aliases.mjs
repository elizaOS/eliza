// Shares script lib sync eliza env aliases helpers across repo automation entrypoints.
import { syncElizaEnvAliases as syncSharedElizaEnvAliases } from "@elizaos/shared/utils/env";

/**
 * Mirror branded app env vars into ELIZA_* so shared elizaOS packages only
 * need to resolve one canonical namespace internally.
 */
export function syncElizaEnvAliases(options = {}) {
  syncSharedElizaEnvAliases(options);
}
