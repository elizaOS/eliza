// Vite view-bundle entry. Re-exports the unified spatial view component plus
// the `interact` capability handler so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads (`StewardView`, `interact`).
// Kept separate from StewardView.tsx so that file exports only React components
// and stays Fast-Refresh-compatible in dev.
export { StewardView } from "./StewardView";
export { interact } from "./StewardView.interact";
