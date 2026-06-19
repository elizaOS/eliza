// Browser/UI-only barrel: the view component plus its overlay-app registration.
// Importing this (not the root index) keeps Node-only `Plugin` wiring out of
// frontend bundles. Mirrors the imagegen-app / hyperliquid-app `ui.ts` pattern.
export { SwapAppView } from "./SwapAppView.tsx";
export { SWAP_APP_NAME, swapApp } from "./swap-app.ts";
export { useSwapState } from "./useSwapState.ts";
