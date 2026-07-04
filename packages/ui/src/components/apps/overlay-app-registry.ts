/**
 * Overlay App Registry — simple registry for full-screen overlay apps.
 *
 * The registry state and functions now live in `@elizaos/shared`
 * (`contracts/app-registries`) so the Node runtime can query the registry
 * without dragging the React component graph in. This module re-exports them
 * so existing browser importers keep working unchanged.
 */

export type { OverlayAppAvailabilityContext } from "@elizaos/shared";
export {
  getAllOverlayApps,
  getAvailableOverlayApps,
  getOverlayApp,
  isAospAndroid,
  isOverlayApp,
  overlayAppToRegistryInfo,
  registerOverlayApp,
} from "@elizaos/shared";
