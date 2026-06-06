// Vite view-bundle entry. Re-exports DocumentsView so the built bundle
// (dist/views/bundle.js) exposes the named export the view loader reads.
// Kept separate from DocumentsView.tsx so that file exports only React
// components and stays Fast-Refresh-compatible in dev.
export { DocumentsView } from "./DocumentsView.tsx";
