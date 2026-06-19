// Vite view-bundle entry. Re-exports every view component the facewear plugin
// registers (see the `views` array in src/index.ts) so the built bundle
// (dist/views/bundle.js) exposes the same named exports the view loader reads:
// `FacewearView`, `FacewearTuiView`, `SmartglassesView`, `SmartglassesTuiView`.
// Kept separate from FacewearView.tsx / SmartglassesView.tsx so those files
// export only React components and stay Fast-Refresh-compatible in dev.
export {
  FacewearTuiView,
  FacewearView,
  SmartglassesTuiView,
} from "./FacewearView.tsx";
export { SmartglassesView } from "./SmartglassesView.tsx";
