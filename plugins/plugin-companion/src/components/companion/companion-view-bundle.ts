// Vite view-bundle entry. Re-exports the view component plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the same
// named exports the view loader reads (`CompanionView`, `interact`). Kept
// separate from CompanionView.tsx so that file exports only React components and
// stays Fast-Refresh-compatible in dev.
export { CompanionView } from "./CompanionView";
export { interact } from "./CompanionView.interact";
