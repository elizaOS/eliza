// Browser/UI-only barrel: the view components plus the overlay-app registration.
// Importing this (not the root index) keeps Node-only `Plugin` wiring out of
// frontend bundles. Mirrors the imagegen-app / hyperliquid-app `ui.ts` pattern.
export { SwapAppView } from "./SwapAppView.tsx";
export { type SwapSnapshot, SwapSpatialView } from "./SwapSpatialView.tsx";
export { type SwapViewProps, SwapView } from "./SwapView.tsx";
export { SWAP_APP_NAME, swapApp } from "./swap-app.ts";
export { useSwapState } from "./useSwapState.ts";
