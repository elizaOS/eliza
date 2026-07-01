// Vite view-bundle entry. Re-exports the unified spatial view component plus
// the `interact` capability handler so the built bundle (dist/views/bundle.js)
// exposes the named exports the view loader reads (`HyperliquidView`,
// `interact`). Kept separate from HyperliquidView.tsx so that file exports only
// React components and stays Fast-Refresh-compatible in dev.

export { HyperliquidView } from "./HyperliquidView.tsx";
export { interact } from "./hyperliquid-interact.ts";
