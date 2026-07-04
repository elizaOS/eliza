/**
 * Re-export of the overlay-app registry. The single canonical registry lives in
 * `@elizaos/shared/src/apps/overlay-app-registry.ts` so Node app-registration
 * code shares it without importing this React package.
 */
export {
  getAllOverlayApps,
  getAvailableOverlayApps,
  getOverlayApp,
  isAospAndroid,
  isOverlayApp,
  type OverlayAppAvailabilityContext,
  overlayAppToRegistryInfo,
  registerOverlayApp,
} from "@elizaos/shared";
