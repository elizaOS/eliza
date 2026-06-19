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

import { type Component, registerTerminalView } from "@elizaos/tui";
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
  return registerTerminalView(id, createSpatialTuiComponent(view, options));
}
