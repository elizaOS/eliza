// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the same
// named exports the view loader reads (`DefenseAgentsOperatorSurface`,
// `DefenseAgentsTuiView`, `interact`). Kept separate from
// DefenseAgentsOperatorSurface.tsx so that file exports only React components and
// stays Fast-Refresh-compatible in dev.
export {
  DefenseAgentsOperatorSurface,
  DefenseAgentsTuiView,
} from "./DefenseAgentsOperatorSurface";
export { interact } from "./DefenseAgentsOperatorSurface.interact";
