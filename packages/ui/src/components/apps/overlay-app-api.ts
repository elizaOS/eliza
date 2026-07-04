/**
 * Re-export of the overlay-app contract types. The canonical definitions live in
 * `@elizaos/shared` so Node app-registration code can reference them without
 * importing this React package; this shim keeps the in-package import path stable.
 */
export type { OverlayApp, OverlayAppContext } from "@elizaos/shared";
