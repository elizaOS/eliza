// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the same
// named exports the view loader reads (`ClawvilleOperatorSurface`,
// `ClawvilleTuiView`, `interact`). Kept separate from ClawvilleOperatorSurface.tsx
// so that file exports only React components and stays Fast-Refresh-compatible in
// dev.
export {
  ClawvilleOperatorSurface,
  ClawvilleTuiView,
} from "./ClawvilleOperatorSurface";
export { interact } from "./ClawvilleOperatorSurface.interact";
