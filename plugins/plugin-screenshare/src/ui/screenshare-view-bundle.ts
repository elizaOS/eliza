// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`ScreenshareOperatorSurface`,
// `ScreenshareTuiView`, `interact`). Kept separate from
// ScreenshareOperatorSurface.tsx so that file exports only React components and
// stays Fast-Refresh-compatible.
export {
  ScreenshareOperatorSurface,
  ScreenshareTuiView,
} from "./ScreenshareOperatorSurface";
export { interact } from "./ScreenshareOperatorSurface.interact";
