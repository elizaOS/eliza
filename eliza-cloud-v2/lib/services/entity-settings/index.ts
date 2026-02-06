/**
 * Entity Settings Service
 *
 * Provides per-user settings for multi-tenant runtime sharing.
 * Settings are prefetched at request start and injected into the request context,
 * where they take highest priority in runtime.getSetting() resolution.
 *
 * @example
 * ```typescript
 * import { entitySettingsService, runWithRequestContext, type RequestContext } from "@elizaos/core";
 *
 * // Before processing a message
 * const { settings, sources } = await entitySettingsService.prefetch(
 *   userId,
 *   agentId,
 *   organizationId
 * );
 *
 * // Wrap message processing with request context
 * await runWithRequestContext({
 *   entityId: userId as UUID,
 *   agentId: agentId as UUID,
 *   entitySettings: settings,
 *   requestStartTime: Date.now(),
 * }, async () => {
 *   // All getSetting() calls here will check entitySettings first
 *   await messageHandler.process(options);
 * });
 * ```
 */

// Main service
export {
  EntitySettingsService,
  entitySettingsService,
} from "./service";

// Cache
export {
  EntitySettingsCache,
  entitySettingsCache,
} from "./cache";

// Types
export type {
  EntitySettingValue,
  EntitySettingSource,
  PrefetchResult,
  SetEntitySettingParams,
  RevokeEntitySettingParams,
  EntitySettingMetadata,
} from "./types";

export { OAUTH_PROVIDER_TO_SETTING_KEY } from "./types";
