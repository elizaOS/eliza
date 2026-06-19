// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`HyperliquidAppView`,
// `HyperliquidTuiView`, `interact`). Kept separate from HyperliquidAppView.tsx
// so that file exports only React components and stays Fast-Refresh-compatible.

export { interact } from "./HyperliquidAppView.interact.ts";
export {
  HyperliquidAppView,
  HyperliquidTuiView,
} from "./HyperliquidAppView.tsx";
