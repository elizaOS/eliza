/**
 * Terminal view registry.
 *
 * A process-global registry of named {@link Component} instances that a host
 * (the agent terminal) can mount by id. Plugins register a renderable terminal
 * view here — typically a spatial view adapted via
 * `@elizaos/ui/spatial/tui`'s `createSpatialTuiComponent` — so the terminal can
 * render the view's real content inline instead of only navigating a GUI shell.
 *
 * The registry holds the `@elizaos/tui` `Component` interface (not React), so a
 * terminal host depends only on this package — never on the heavier UI library
 * the spatial views are authored with.
 *
 * Keyed by `Symbol.for` so registrations survive module duplication across the
 * runtime/plugin boundary.
 */

import type { Component } from "./core/types.js";

/**
 * Per-mount options a host can pass when building a terminal view from its
 * factory. `onActivate` fires with the activated control's agent id so the host
 * can dispatch a view-scoped action to the runtime. Kept as `unknown`-free,
 * minimal structural options so this package never depends on the spatial
 * renderer's full `SpatialTuiComponentOptions`.
 */
export interface TerminalViewMountOptions {
  onActivate?: (agentId: string) => void;
}

/** Builds a fresh terminal view `Component` for a given mount. */
export type TerminalViewFactory = (
  options?: TerminalViewMountOptions,
) => Component;

interface TerminalViewRegistryStore {
  views: Map<string, Component>;
  factories: Map<string, TerminalViewFactory>;
}

function registryKey(): symbol {
  return Symbol.for("elizaos.tui.terminal-view-registry");
}

function getStore(): TerminalViewRegistryStore {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const key = registryKey();
  const existing = globalObject[key] as TerminalViewRegistryStore | undefined;
  if (existing) return existing;
  const created: TerminalViewRegistryStore = {
    views: new Map(),
    factories: new Map(),
  };
  globalObject[key] = created;
  return created;
}

/**
 * Register a terminal view under a stable id. Returns an unregister function.
 * Re-registering the same id replaces the prior component.
 *
 * When `factory` is supplied a host can rebuild the view per mount with its own
 * options (e.g. `onActivate`); the eager `component` stays the back-compatible
 * default mount and the cached source of `getTerminalView`.
 */
export function registerTerminalView(
  id: string,
  component: Component,
  factory?: TerminalViewFactory,
): () => void {
  const store = getStore();
  store.views.set(id, component);
  if (factory) store.factories.set(id, factory);
  return () => {
    if (store.views.get(id) === component) store.views.delete(id);
    if (factory && store.factories.get(id) === factory)
      store.factories.delete(id);
  };
}

/** Look up a registered terminal view by id. */
export function getTerminalView(id: string): Component | undefined {
  return getStore().views.get(id);
}

/**
 * Look up the factory for a registered terminal view, when one was supplied.
 * A host calls this to build a fresh component with per-mount options
 * (`onActivate`) instead of the cached default component.
 */
export function getTerminalViewFactory(
  id: string,
): TerminalViewFactory | undefined {
  return getStore().factories.get(id);
}

/** True when a terminal view is registered for `id`. */
export function hasTerminalView(id: string): boolean {
  return getStore().views.has(id);
}

/** List the ids of all registered terminal views. */
export function listTerminalViewIds(): string[] {
  return [...getStore().views.keys()];
}
