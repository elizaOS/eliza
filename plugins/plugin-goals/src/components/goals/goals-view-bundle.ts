// Vite view-bundle entry. The built bundle (dist/views/bundle.js) exposes the
// named export `GoalsView` the view loader reads via __ELIZA_VIEW_EXPORT__.
// Kept separate from GoalsView.tsx so that file exports only React components
// and stays Fast-Refresh-compatible in dev.
export { GoalsView } from "./GoalsView.tsx";
