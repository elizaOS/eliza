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

import type { Component } from "@elizaos/tui";
import type { ReactNode } from "react";
import {
  createSpatialStateStore,
  type EvaluateOptions,
  evaluateToSpatialTree,
  type SpatialStateStore,
} from "../evaluate.ts";
import type { SpatialNode } from "../ir.ts";
import { render as renderEngine } from "./engine.ts";

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

  return {
    render(width: number): string[] {
      if (cache && cache.width === width) return cache.lines;
      const tree = evaluateToSpatialTree(view(), {
        store,
        requestRender: () => {
          cache = null;
          options.onChange?.();
        },
      });
      const lines = renderEngine(tree, width);
      cache = { width, lines };
      return lines;
    },
    invalidate(): void {
      cache = null;
    },
  };
}
