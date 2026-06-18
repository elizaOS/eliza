/**
 * `@elizaos/ui/spatial` — one view, three modalities.
 *
 * Author a view ONCE with the primitives below. The same React tree renders to:
 *
 *  - **GUI** — `<SpatialSurface modality="gui">{view}</SpatialSurface>` → DOM.
 *  - **XR**  — `<SpatialSurface modality="xr">{view}</SpatialSurface>` → the same
 *    DOM, spatially scaled for a headset.
 *  - **TUI** — `renderViewToLines(view, width)` (from `@elizaos/ui/spatial/tui`)
 *    → terminal lines, via the shared layout IR.
 *
 * This barrel is browser-safe: it never imports the terminal engine (which pulls
 * in `@elizaos/tui`). The terminal renderer lives at `@elizaos/ui/spatial/tui`.
 *
 * State that must work on every surface uses the `useSpatial*` hooks; plain
 * presentational components (props → primitives) need no hooks and work as-is.
 */

export {
  type SpatialAction,
  SpatialContextProvider,
  type SpatialContextValue,
  useSpatialContext,
} from "./context.ts";
// DOM (GUI/XR) host + render context.
export {
  detectDomModality,
  SpatialSurface,
  type SpatialSurfaceProps,
} from "./dom.tsx";
// React → IR evaluation + cross-modal state hooks.
export {
  createSpatialStateStore,
  type EvaluateOptions,
  evaluateToSpatialTree,
  isEvaluatingToIR,
  type SpatialStateStore,
  useSpatialMemo,
  useSpatialRef,
  useSpatialState,
} from "./evaluate.ts";
// Shared layout IR (the cross-modality contract).
export type {
  SpatialAgentMeta,
  SpatialAlign,
  SpatialBorder,
  SpatialBoxNode,
  SpatialButtonNode,
  SpatialDirection,
  SpatialDividerNode,
  SpatialFieldNode,
  SpatialImageNode,
  SpatialJustify,
  SpatialLength,
  SpatialModality,
  SpatialNode,
  SpatialPadding,
  SpatialSpacerNode,
  SpatialTextNode,
  SpatialTextStyle,
  SpatialTone,
} from "./ir.ts";
export { isContainer, resolvePadding } from "./ir.ts";
// Authoring vocabulary (the primitives + sugar).
export {
  Button,
  type ButtonProps,
  Card,
  Divider,
  type DividerProps,
  Field,
  type FieldProps,
  getSpatialKind,
  HStack,
  Image,
  type ImageProps,
  List,
  SPATIAL_KIND,
  Spacer,
  type SpacerProps,
  type SpatialKind,
  Stack,
  type StackProps,
  Text,
  type TextProps,
  VStack,
} from "./primitives.tsx";
