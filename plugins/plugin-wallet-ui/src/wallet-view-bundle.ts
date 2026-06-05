// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`InventoryView`, `InventoryTuiView`,
// `interact`). Kept separate from InventoryView.tsx so that file exports only
// React components and stays Fast-Refresh-compatible.
export { InventoryTuiView, InventoryView } from "./InventoryView";
export { interact } from "./InventoryView.interact";
