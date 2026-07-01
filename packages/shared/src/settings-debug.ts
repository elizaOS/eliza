/**
 * Opt-in verbose logging for settings load / change / save flows.
 *
 * The canonical implementation lives in `@elizaos/core`. This module re-exports
 * it so existing `@elizaos/shared` (and `@elizaos/shared/settings-debug`)
 * importers keep resolving without maintaining a duplicate copy.
 */

export {
  isElizaSettingsDebugEnabled,
  sanitizeForSettingsDebug,
  settingsDebugCloudSummary,
} from "@elizaos/core";
