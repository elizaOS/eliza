// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the same
// named exports the view loader reads (`ContactsAppView`, `ContactsTuiView`,
// `interact`). Kept separate from ContactsAppView.tsx so that file exports only
// React components and stays Fast-Refresh-compatible in dev.
export { ContactsAppView, ContactsTuiView } from "./ContactsAppView";
export { interact } from "./ContactsAppView.interact";
