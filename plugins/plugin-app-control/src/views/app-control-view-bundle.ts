/**
 * Vite view-bundle entry. Re-exports the view components plus the `interact`
 * capability handler so the built bundle (dist/views/bundle.js) exposes the same
 * named exports the view loader reads (`ViewManagerView`, `ViewManagerTuiView`,
 * `interact`). Kept separate from ViewManagerView.tsx so that file exports only
 * React components and stays Fast-Refresh-compatible in dev.
 */
export {
	default,
	ViewManagerTuiView,
	ViewManagerView,
} from "./ViewManagerView";
export { interact } from "./viewManagerData";
