/**
 * Vite view-bundle entry. Re-exports the unified spatial view component plus
 * the `interact` capability handler so the built bundle (dist/views/bundle.js)
 * exposes the named exports the view loader reads (`ShopifyView`, `interact`).
 * Kept separate from ShopifyView.tsx so that file exports only React components
 * and stays Fast-Refresh-compatible.
 */

export { ShopifyView } from "./ShopifyView.tsx";
export { interact } from "./shopify-interact.ts";
