// Vite view-bundle entry. Re-exports the BirdclawView component so the built
// bundle (dist/views/bundle.js) exposes the named export the view loader
// reads. Kept separate from BirdclawView.tsx so that file exports only React
// components and stays Fast-Refresh-compatible in dev.
export { BirdclawView } from "./BirdclawView.tsx";
