// Vite view-bundle entry. Re-exports the FocusView component so the built
// bundle (dist/views/bundle.js) exposes the same named export the view loader
// reads (`FocusView`). Kept separate from FocusView.tsx so that file exports
// only React components and stays Fast-Refresh-compatible in dev.
export { FocusView } from "./FocusView.tsx";
