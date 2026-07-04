// Re-export shim: the overlay-app registry now lives in `@elizaos/shared` so
// Node app-registration code shares one canonical registry without importing
// the React package. See `@elizaos/shared/src/apps/overlay-app-registry.ts`.
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
