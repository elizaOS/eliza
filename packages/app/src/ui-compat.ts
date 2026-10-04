/**
 * `./ui-compat` subpath export — a Node-reachable UI-compat shim that lets app
 * plugins register dashboard surfaces and pull a curated slice of the UI kit
 * without dragging the React component graph into the API process at boot.
 *
 * Registration-surface contracts + registries (overlay apps, detail extensions)
 * are owned by @elizaos/core — the React-free canonical home — so this shim
 * registers app surfaces without touching the React package.
 */
// Everything below re-exports from its narrow `@elizaos/ui` subpath rather than
// the root barrel. The barrel (`@elizaos/ui`) eagerly evaluates the entire
// frontend component graph, and this shim is reachable from the Node
// `@elizaos/app` barrel (index.ts) — so importing it from the bare barrel
// dragged ~1000 React modules (and their deps) into the API process at boot.
// Subpath imports pull only the specific component. Mirrors `browser.ts`.

/**
 * `./ui-compat` subpath export — a Node-reachable UI-compat shim that lets app
 * plugins register dashboard surfaces and pull a curated slice of the UI kit
 * without dragging the React component graph into the API process at boot.
 *
 * Registration-surface contracts + registries (overlay apps, detail extensions)
 * are owned by @elizaos/core — the React-free canonical home — so this shim
 * registers app surfaces without touching the React package.
 */
// Everything below re-exports from its narrow `@elizaos/ui` subpath rather than
// the root barrel. The barrel (`@elizaos/ui`) eagerly evaluates the entire
// frontend component graph, and this shim is reachable from the Node
// `@elizaos/app` barrel (index.ts) — so importing it from the bare barrel
// dragged ~1000 React modules (and their deps) into the API process at boot.
// Subpath imports pull only the specific component. Mirrors `browser.ts`.
export type {
  AppRunSummary,
  AppSessionJsonValue,
} from "@elizaos/core/protocol";
// app-store only pulls React + an erased type (same weight as useApp), so it
// stays light enough for the Node API process — re-export the selector hooks so
// app plugins can subscribe to AppContext slices instead of the whole value.
export {
  type AppDetailExtensionProps,
  Button,
  client,
  formatDetailTimestamp,
  Input,
  type OverlayApp,
  type OverlayAppContext,
  PagePanel,
  registerDetailExtension,
  registerOverlayApp,
  Spinner,
  StatusBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  type SurfaceTone,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
  useApp,
  useAppSelector,
  useAppSelectorShallow,
} from "@elizaos/ui";
