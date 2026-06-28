// Vite view-bundle entry. Re-exports the unified spatial view component plus
// the `interact` capability handler so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads (`VincentView`, `interact`).
// Kept separate from VincentView.tsx so that file exports only React components
// and stays Fast-Refresh-compatible.
export { interact } from "./vincent-interact";
export { VincentView } from "./VincentView";
