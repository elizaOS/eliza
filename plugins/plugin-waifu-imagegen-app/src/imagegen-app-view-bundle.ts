// Vite view-bundle entry. Re-exports the view component so the built bundle
// (dist/views/bundle.js) exposes the named export the shell view loader reads
// (`ImageGenAppView`). Kept separate from ImageGenAppView.tsx so that file
// exports only React components and stays Fast-Refresh-compatible in dev.

export { ImageGenAppView } from "./ImageGenAppView.tsx";
