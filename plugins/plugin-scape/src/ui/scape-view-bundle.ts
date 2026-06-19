// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`ScapeOperatorSurface`,
// `ScapeTuiView`, `interact`). Kept separate from ScapeOperatorSurface.tsx so
// that file exports only React components and stays Fast-Refresh-compatible.
export {
  ScapeOperatorSurface,
  ScapeTuiView,
} from "./ScapeOperatorSurface";
export { interact } from "./ScapeOperatorSurface.interact";
