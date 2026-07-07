/**
 * `@elizaos/ui/spatial` — modality-agnostic view authoring.
 *
 * Author a view ONCE with the primitives below. GUI is the shipped surface
 * (`<SpatialSurface modality="gui">{view}</SpatialSurface>` → DOM). The
 * `SpatialModality` contract keeps "xr" and "tui" as valid values so views stay
 * authored modality-agnostically; the terminal registry/renderer lives at
 * `@elizaos/ui/spatial/tui` (consumed by `@elizaos/tui` and used as a test
 * harness). The shipped XR renderer and TUI review surfaces were removed
 * (#15269) — reintroduce them deliberately against this contract.
 *
 * This barrel is browser-safe: it never imports the terminal engine (which pulls
 * in `@elizaos/tui`).
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
  useContinuousChatClearanceActive,
  useContinuousChatCompactClearanceActive,
  useContinuousChatSideClearanceActive,
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
  Escape,
  type EscapeProps,
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
