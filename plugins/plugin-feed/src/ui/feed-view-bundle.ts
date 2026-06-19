// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`FeedOperatorSurface`, `FeedTuiView`,
// `interact`). Kept separate from FeedOperatorSurface.tsx so that file exports
// only React components and stays Fast-Refresh-compatible in dev.
export { FeedOperatorSurface, FeedTuiView } from "./FeedOperatorSurface";
export { interact } from "./FeedOperatorSurface.interact";
