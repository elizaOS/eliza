/**
 * Vite view-bundle entry for @elizaos/plugin-finances.
 *
 * The built bundle (dist/views/bundle.js) exposes a named `FinancesView`
 * export so the view loader can resolve it via the componentExport field in
 * the Plugin `views` registration. Kept separate from FinancesView.tsx so
 * that component file stays Fast-Refresh-compatible in dev.
 */

export { FinancesView } from "./FinancesView.tsx";
