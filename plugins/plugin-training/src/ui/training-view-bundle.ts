// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`FineTuningView`,
// `FineTuningTuiView`, `interact`). Importing FineTuningView also runs its
// registerDetailExtension side-effect. Kept separate from FineTuningView.tsx so
// that file exports only React components and stays Fast-Refresh-compatible.
export { FineTuningTuiView, FineTuningView } from "./FineTuningView";
export { interact } from "./FineTuningView.interact";
