// Vite view-bundle entry. Re-exports the view components so the built bundle
// (dist/views/bundle.js) exposes the named exports the shell view loader reads.
// `ImageGenView` is the unified spatial componentExport (GUI + XR + TUI all draw
// from the single ImageGenSpatialView source); `ImageGenAppView` is retained for
// the legacy overlay-app loader. Kept separate from the .tsx files so those keep
// exporting only React components and stay Fast-Refresh-compatible in dev.

export { ImageGenAppView } from "./ImageGenAppView.tsx";
export { ImageGenView } from "./ImageGenView.tsx";
