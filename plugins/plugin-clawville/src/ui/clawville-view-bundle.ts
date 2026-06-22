// Vite view-bundle entry. Re-exports the unified spatial view component plus the
// `interact` capability handler so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads (`ClawvilleView`, `interact`).
// Kept separate from ClawvilleView.tsx so that file exports only React components
// and stays Fast-Refresh-compatible in dev.

export { ClawvilleView } from "../components/ClawvilleView.tsx";
export { interact } from "./ClawvilleOperatorSurface.interact";
