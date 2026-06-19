// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`HyperscapeOperatorSurface`,
// `HyperscapeTuiView`, `interact`). Kept separate from
// HyperscapeOperatorSurface.tsx so that file exports only React components and
// stays Fast-Refresh-compatible in dev.

export { interact } from "./HyperscapeOperatorSurface.interact.ts";
export {
  HyperscapeOperatorSurface,
  HyperscapeTuiView,
} from "./HyperscapeOperatorSurface.tsx";
