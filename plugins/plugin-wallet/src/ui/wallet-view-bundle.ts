// Vite view-bundle entry. Re-exports the unified spatial view components plus
// the `interact` capability handler so the built bundle exposes the named
// exports the view loader reads. Kept separate from the React component files
// so they remain Fast-Refresh-compatible in dev.
export { CryptoTerminalView } from "./CryptoTerminalView";
export { InventoryView } from "./InventoryView";
export { interact } from "./InventoryView.interact";
