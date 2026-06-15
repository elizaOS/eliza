// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`VincentAppView`, `VincentTuiView`,
// `interact`). Kept separate from VincentAppView.tsx so that file exports only
// React components and stays Fast-Refresh-compatible.
export { VincentAppView, VincentTuiView } from "./VincentAppView";
export { interact } from "./VincentAppView.interact";
