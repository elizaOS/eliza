// Vite view-bundle entry. Re-exports the HealthView component so the built
// bundle (dist/views/bundle.js) exposes the named export the view loader reads.
// Kept separate from HealthView.tsx so that file exports only React components
// and stays Fast-Refresh-compatible in dev.
export { HealthView } from "./HealthView.tsx";
