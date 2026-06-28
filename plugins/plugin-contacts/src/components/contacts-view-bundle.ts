// Vite view-bundle entry. Re-exports the unified spatial view component plus
// the `interact` capability handler so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads (`ContactsView`, `interact`).
// Kept separate from ContactsView.tsx so that file exports only React
// components and stays Fast-Refresh-compatible in dev.

export { interact } from "./ContactsAppView.interact.ts";
export { ContactsView } from "./ContactsView.tsx";
