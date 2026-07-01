// Vite view-bundle entry. Re-exports the unified spatial view component plus the
// `interact` capability handler so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads (`ScreenshareView`,
// `interact`). One source drives GUI, XR, and TUI. Kept separate from
// ScreenshareView.tsx so that file exports only React components and stays
// Fast-Refresh-compatible in dev.

export { ScreenshareView } from "../components/ScreenshareView";
export { interact } from "./screenshare-interact";
