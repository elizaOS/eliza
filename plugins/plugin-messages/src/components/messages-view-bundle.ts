/**
 * Vite view-bundle entry: re-exports the unified spatial view component plus the
 * `interact` capability handler so the built bundle (dist/views/bundle.js)
 * exposes the named exports the view loader reads (`MessagesView`, `interact`).
 * Kept separate from MessagesView.tsx so that file exports only React components
 * and stays Fast-Refresh-compatible in dev.
 */

export { MessagesView } from "./MessagesView.tsx";
export { interact } from "./messages-interact.ts";
