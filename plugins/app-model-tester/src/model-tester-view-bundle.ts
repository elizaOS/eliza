// Vite view-bundle entry. Re-exports the unified spatial data wrapper plus the
// `interact` capability handler so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads (`ModelTesterView`,
// `interact`). Kept separate from ModelTesterView.tsx so that file exports only
// React components and stays Fast-Refresh-compatible in dev.
export { interact } from "./ModelTesterAppView.interact";
export { ModelTesterView } from "./ModelTesterView";
