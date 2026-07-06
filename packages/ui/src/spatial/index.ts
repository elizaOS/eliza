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
// Panel → texture — draw panel content to an origin-clean 2D canvas the immersive
// renderer uploads as a textured quad (foreignObject DOM snapshots taint WebGL).
export {
  type PanelContent,
  type PanelTexel,
  type RasterizeOptions,
  rasterizePanelToCanvas,
  solidColorTexel,
  wrapText,
} from "./panel-texture.ts";
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
// WebXR runtime — make navigator.xr available everywhere (native preferred,
// polyfill fallback) + enter a real immersive XRWebGLLayer scene.
export {
  detectWebXRCapability,
  ensureWebXR,
  enterImmersiveScene,
  type ImmersivePanel,
  type ImmersiveSceneHandle,
  type ImmersiveSceneOptions,
  type WebXRCapability,
} from "./webxr-runtime.ts";
// Real 3D spatial renderer (XR modality) + its deterministic math core.
export {
  type XRDevicePose,
  type XRPanelSpec,
  type XRSceneAPI,
  type XRSceneHit,
  type XRScenePanelInfo,
  XRSpatialScene,
  type XRSpatialSceneProps,
} from "./xr-scene.tsx";
export {
  billboardOrientation,
  type Camera,
  deviceRay,
  forwardOf,
  nearestPanelHit,
  type PanelPlane,
  type PlaneHit,
  panelLocalToWorld,
  projectToScreen,
  type Quat,
  quatLookAt,
  type Ray,
  rayPlaneHit,
  screenToRay,
  type Vec3,
  type Viewport,
  vec3,
} from "./xr-scene-math.ts";
