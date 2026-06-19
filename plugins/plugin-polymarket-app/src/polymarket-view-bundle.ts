// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`PolymarketAppView`,
// `PolymarketTuiView`, `interact`). Kept separate from PolymarketAppView.tsx so
// that file exports only React components and stays Fast-Refresh-compatible.
export { PolymarketAppView, PolymarketTuiView } from "./PolymarketAppView";
export { interact } from "./PolymarketAppView.interact";
