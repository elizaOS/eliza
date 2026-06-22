// Vite view-bundle entry. Re-exports the unified spatial view component plus the
// `interact` capability handler so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads (`DefenseAgentsView`,
// `interact`). Kept separate from DefenseAgentsView.tsx so that file exports only
// React components and stays Fast-Refresh-compatible in dev.

export { DefenseAgentsView } from "../components/DefenseAgentsView.tsx";
export { interact } from "./DefenseAgentsOperatorSurface.interact";
