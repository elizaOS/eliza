// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`ModelTesterAppView`,
// `ModelTesterTuiView`, `interact`). Kept separate from ModelTesterAppView.tsx so
// that file exports only React components and stays Fast-Refresh-compatible in dev.
export {
  ModelTesterAppView,
  ModelTesterTuiView,
} from "./ModelTesterAppView";
export { interact } from "./ModelTesterAppView.interact";
