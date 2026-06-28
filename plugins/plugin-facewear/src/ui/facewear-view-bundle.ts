// Vite view-bundle entry. Re-exports the view components the facewear plugin
// manifest declares (see the `views` array in src/index.ts) so the built bundle
// (dist/views/bundle.js) exposes the named exports the view loader reads.
//
// The two own views collapse to one tri-modal declaration each:
//   - `FacewearView`         → the gui/xr/tui Facewear data wrapper
//   - `SmartglassesPanelView` → the gui/xr/tui Smartglasses operator panel
// Both render the single spatial source (FacewearSpatialView /
// SmartglassesSpatialView). The Smartglasses dashboard (SmartglassesView) stays
// exported because it owns the live BLE transport the operator panel mirrors.
export { FacewearView } from "../components/FacewearView.tsx";
export { SmartglassesPanelView } from "../components/SmartglassesPanelView.tsx";
export { SmartglassesView } from "./SmartglassesView.tsx";
