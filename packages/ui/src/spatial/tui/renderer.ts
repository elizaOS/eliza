/**
 * TUI renderer entry points.
 *
 * These take the SAME authored React view that GUI/XR render and produce
 * terminal lines, by evaluating it to the IR (`evaluate.ts`) and laying it out
 * (`engine.ts`). `createSpatialTuiComponent` adapts a view to the `@elizaos/tui`
 * `Component` interface so a unified view drops straight into the agent terminal
 * alongside the existing imperative TUI components.
 *
 * This module is Node-only (it pulls in `@elizaos/tui`); it is exposed under the
 * `@elizaos/ui/spatial/tui` subpath and is never imported by the browser barrel.
 */

import {
  type Component,
  registerTerminalView,
  type TerminalViewMountOptions,
} from "@elizaos/tui";
import type { ReactNode } from "react";
import {
  createSpatialStateStore,
  type EvaluateOptions,
  evaluateToSpatialTree,
  type SpatialStateStore,
} from "../evaluate.ts";
import type { SpatialNode } from "../ir.ts";
import { render as renderEngine, setFocusedAgentId } from "./engine.ts";

/** Lay out an already-evaluated IR node to terminal lines. */
export function renderSpatialToLines(
  node: SpatialNode,
  width: number,
): string[] {
  return renderEngine(node, width);
}

/** Evaluate an authored view to IR and lay it out to terminal lines (one frame). */
export function renderViewToLines(
  view: ReactNode,
  width: number,
  options?: EvaluateOptions,
): string[] {
  return renderEngine(evaluateToSpatialTree(view, options), width);
}

export interface SpatialTuiComponentOptions {
  /** Called when a `useSpatialState` setter fires so the host can re-render. */
  onChange?: () => void;
  /** Reuse an external store (else one is created and owned by the component). */
  store?: SpatialStateStore;
  /** Fired with the agent id when a focused control is activated (Enter). */
  onActivate?: (agentId: string) => void;
}

/**
 * Adapt a spatial view to the `@elizaos/tui` `Component` interface.
 *
 * `view` is a thunk so state changes (via `useSpatialState`) re-evaluate the
 * latest tree. Lines are cached per width until `invalidate()` or a state change.
 *
 * ```ts
 * const profile = createSpatialTuiComponent(() => <ProfileView profile={p} />, {
 *   onChange: () => tui.requestRender(),
 * });
 * tui.addChild(profile);
 * ```
 */
export function createSpatialTuiComponent(
  view: () => ReactNode,
  options: SpatialTuiComponentOptions = {},
): Component {
  const store = options.store ?? createSpatialStateStore();
  let cache: { width: number; lines: string[] } | null = null;
  // Keyboard focus: ids of activatable buttons (in document order) + handlers.
  let focusable: string[] = [];
  let handlers = new Map<string, () => void>();
  let focusedId: string | null = null;

  const invalidate = () => {
    cache = null;
  };
  const requestRender = () => {
    invalidate();
    options.onChange?.();
  };

  function evaluate(): SpatialNode {
    handlers = new Map();
    const tree = evaluateToSpatialTree(view(), {
      store,
      requestRender,
      handlers,
    });
    focusable = [...handlers.keys()];
    // Keep focus on the same control across re-renders; default to the first.
    if (focusedId === null || !focusable.includes(focusedId)) {
      focusedId = focusable[0] ?? null;
    }
    return tree;
  }

  function move(delta: number): void {
    if (focusable.length === 0) return;
    const i = focusedId ? focusable.indexOf(focusedId) : -1;
    const next = (i + delta + focusable.length) % focusable.length;
    focusedId = focusable[next];
    requestRender();
  }

  return {
    render(width: number): string[] {
      if (cache && cache.width === width) return cache.lines;
      const tree = evaluate();
      setFocusedAgentId(focusedId);
      const lines = renderEngine(tree, width);
      setFocusedAgentId(null);
      cache = { width, lines };
      return lines;
    },
    handleInput(data: string): void {
      if (focusable.length === 0 && handlers.size === 0) evaluate();
      // Tab / arrows move focus; Enter / Space activate the focused control.
      if (data === "\t" || data === "\x1b[B" || data === "\x0e") move(1);
      else if (data === "\x1b[Z" || data === "\x1b[A" || data === "\x10")
        move(-1);
      else if (data === "\r" || data === "\n" || data === " ") {
        if (focusedId) {
          handlers.get(focusedId)?.();
          options.onActivate?.(focusedId);
          requestRender();
        }
      }
    },
    invalidate,
  };
}

/**
 * View-element thunks keyed by id, recorded by {@link registerSpatialTerminalView}.
 *
 * The terminal registry holds adapted `@elizaos/tui` `Component`s, not the
 * authored React tree — exactly right for a terminal host, which never touches
 * React. But the DOM surfaces (GUI/XR) render the *same authored React element*
 * through `<SpatialSurface>`, so a host that proves tri-modal parity needs the
 * element, not the terminal adapter. This map gives it: the one authored thunk
 * each plugin registers, retrievable by id for a GUI/XR mount.
 *
 * Keyed by `Symbol.for` (like the terminal registry) so registrations survive
 * module duplication across the runtime/plugin boundary.
 */
function getViewThunkStore(): Map<string, () => ReactNode> {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("elizaos.ui.spatial-view-thunk-registry");
  const existing = globalObject[key] as
    | Map<string, () => ReactNode>
    | undefined;
  if (existing) return existing;
  const created = new Map<string, () => ReactNode>();
  globalObject[key] = created;
  return created;
}

/**
 * The authored React-element thunk for a registered spatial view, when one was
 * registered through {@link registerSpatialTerminalView}. Render its result with
 * `<SpatialSurface modality="gui"|"xr">` to mount the same view a terminal host
 * gets via `getTerminalView(id)` — the cross-modal parity handle.
 */
export function getSpatialViewThunk(id: string): (() => ReactNode) | undefined {
  return getViewThunkStore().get(id);
}

/**
 * Author a terminal-rendered view once and register it so a terminal host (the
 * agent terminal) can mount it by id. This is the single call a plugin makes to
 * make a `viewType: "tui"` view render for real in the terminal:
 *
 * ```ts
 * registerSpatialTerminalView("phone", () => <PhoneSpatialView snapshot={get()} />);
 * ```
 *
 * Returns an unregister function.
 */
export function registerSpatialTerminalView(
  id: string,
  view: () => ReactNode,
  options: SpatialTuiComponentOptions = {},
): () => void {
  // Register both the back-compatible eager component (default mount, the one
  // `getTerminalView` returns) and a factory so a host can rebuild the view per
  // mount with its own options — notably `onActivate` to dispatch a focused
  // control's activation to the runtime, which the default mount has no wiring
  // for. The host's `onChange`/`onActivate` win over the registration defaults.
  const factory = (mount?: TerminalViewMountOptions): Component =>
    createSpatialTuiComponent(view, { ...options, ...mount });
  // Record the authored React thunk so the DOM surfaces can mount the same view.
  getViewThunkStore().set(id, view);
  const unregisterTerminal = registerTerminalView(
    id,
    createSpatialTuiComponent(view, options),
    factory,
  );
  return () => {
    unregisterTerminal();
    if (getViewThunkStore().get(id) === view) getViewThunkStore().delete(id);
  };
}
