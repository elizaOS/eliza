// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`ShopifyAppView`, `ShopifyTuiView`,
// `interact`). Kept separate from ShopifyAppView.tsx so that file exports only
// React components and stays Fast-Refresh-compatible.
export { ShopifyAppView, ShopifyTuiView } from "./ShopifyAppView";
export { interact } from "./ShopifyAppView.interact";
