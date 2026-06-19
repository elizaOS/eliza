// Vite view-bundle entry. Re-exports the view components plus the `interact`
// capability handler so the built bundle (dist/views/bundle.js) exposes the same
// named exports the view loader reads (`TwoThousandFourScapeOperatorSurface`,
// `TwoThousandFourScapeTuiView`, `interact`). Kept separate from
// TwoThousandFourScapeOperatorSurface.tsx so that file exports only React
// components and stays Fast-Refresh-compatible in dev.
export {
  TwoThousandFourScapeOperatorSurface,
  TwoThousandFourScapeTuiView,
} from "./TwoThousandFourScapeOperatorSurface";
export { interact } from "./TwoThousandFourScapeOperatorSurface.interact";
