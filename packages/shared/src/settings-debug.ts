/**
 * Opt-in verbose logging for settings load / change / save flows.
 *
 * The canonical implementation lives in `@elizaos/core` and is published on
 * `@elizaos/core/client-public`. This module re-exports that leaf so existing
 * `@elizaos/shared` (and `@elizaos/shared/settings-debug`) importers keep
 * resolving without a second sanitizer body or the prebuilt core browser blob.
 */

export {
  isElizaSettingsDebugEnabled,
  sanitizeForSettingsDebug,
  settingsDebugCloudSummary,
} from "@elizaos/core/client-public";
