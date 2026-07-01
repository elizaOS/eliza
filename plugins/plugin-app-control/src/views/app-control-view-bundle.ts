/**
 * Vite view-bundle entry. Re-exports the single view component plus the
 * `interact` capability handler so the built bundle (dist/views/bundle.js)
 * exposes the named exports the view loader reads (`ViewManagerView`,
 * `interact`). Kept separate from ViewManagerView.tsx so that file exports only
 * React components and stays Fast-Refresh-compatible in dev.
 */
export { default, ViewManagerView } from "./ViewManagerView";
export { interact } from "./viewManagerData";
