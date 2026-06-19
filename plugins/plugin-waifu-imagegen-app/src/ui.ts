// Browser/UI-only barrel: the view component plus its overlay-app registration.
// Importing this (not the root index) keeps Node-only `Plugin` wiring out of
// frontend bundles. Mirrors the hyperliquid-app `ui.ts` pattern.
export { ImageGenAppView } from "./ImageGenAppView.tsx";
export { IMAGEGEN_APP_NAME, imageGenApp } from "./imagegen-app.ts";
export { useImageGenState } from "./useImageGenState.ts";
