/**
 * Browser shim for `use-sync-external-store/shim`: React 18+ ships
 * `useSyncExternalStore` natively, so this re-exports it directly instead of
 * bundling the standalone polyfill.
 */
export { useSyncExternalStore } from "react";
