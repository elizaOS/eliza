/**
 * Vite view-bundle entry for the `lifeops-live-test` view.
 *
 * The built bundle (dist/views/bundle.js) exposes a named `LifeOpsLiveTestView`
 * export so the view loader resolves it via the `componentExport` field in the
 * plugin's `views` registration. Kept separate from LifeOpsLiveTestView.tsx so
 * that component file stays Fast-Refresh-compatible in dev.
 */

export { LifeOpsLiveTestView } from "./LifeOpsLiveTestView.tsx";
