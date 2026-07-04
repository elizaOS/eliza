// Re-export shim: the overlay-app contract now lives in `@elizaos/shared` so
// Node app-registration code references it without importing the React package.
export type { OverlayApp, OverlayAppContext } from "@elizaos/shared";
