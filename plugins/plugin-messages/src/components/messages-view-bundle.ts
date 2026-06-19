// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the
// same named exports the view loader reads (`MessagesPluginView`,
// `MessagesTuiView`, `interact`). Kept separate from MessagesAppView.tsx so that
// file exports only React components and stays Fast-Refresh-compatible in dev.

export { interact } from "./MessagesAppView.interact.ts";
export {
  MessagesAppView,
  MessagesPluginView,
  MessagesTuiView,
} from "./MessagesAppView.tsx";
