// Vite view-bundle entry. Re-exports the view components so the built bundle
// (dist/views/bundle.js) exposes the named exports the shell view loader reads.
// `SwapView` is the unified spatial GUI/XR/TUI surface (the declared
// `componentExport`); `SwapAppView` is the legacy full-screen overlay form, kept
// for the overlay-app loader (swap-app.ts) and its own test. Kept separate from
// the .tsx files so those export only React components and stay
// Fast-Refresh-compatible in dev.

export { SwapAppView } from "./SwapAppView.tsx";
export { SwapView } from "./SwapView.tsx";
