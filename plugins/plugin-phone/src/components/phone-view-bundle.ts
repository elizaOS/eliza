// Vite view-bundle entry. Re-exports the unified spatial view component plus
// the `interact` capability handler so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads (`PhoneView`, `interact`).
// Kept separate from PhoneView.tsx so that file exports only React components
// and stays Fast-Refresh-compatible in dev.

export { PhoneView } from "./PhoneView.tsx";
export { interact } from "./phone-interact.ts";
