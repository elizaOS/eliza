// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the same
// named exports the view loader reads (`CompanionView`, `CompanionTuiView`,
// `interact`). Kept separate from CompanionView.tsx so that file exports only
// React components and stays Fast-Refresh-compatible in dev.
export { CompanionTuiView, CompanionView } from "./CompanionView";
export { interact } from "./CompanionView.interact";
