/**
 * Overlay App API — contract for full-screen overlay applications.
 *
 * The canonical definitions now live in `@elizaos/shared`
 * (`contracts/app-registries`) so the Node runtime can reference them without
 * dragging the React component graph in. This module re-exports them so
 * existing `@elizaos/ui/components/apps/overlay-app-api` importers keep working.
 */

export type { OverlayApp, OverlayAppContext } from "@elizaos/shared";
