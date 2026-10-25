/**
 * Binding that lets the active view take over the one floating chat composer —
 * override its placeholder and receive live draft text. Module-level store
 * shared via globalThis + useSyncExternalStore.
 */
import * as React from "react";

/**
 * View → chat binding. Lets the currently-active view take over the one floating
 * chat composer: override its placeholder, and receive the live draft text as the
 * user types (so the view can act as a search/filter target without its own input
 * box). The Help view uses this to make the chat its search bar.
 *
 * Module-level store shared via globalThis (survives HMR + reachable from the
 * composer outside the view's React subtree) + useSyncExternalStore.
 */

export interface ViewChatBinding {
  /** Override the chat composer placeholder while this binding is active. */
  placeholder?: string;
  /**
   * Receive the live composer draft as the user types. Lets the active view
   * filter/respond to what's being typed without sending to the agent.
   */
  onQuery?: (text: string) => void;
  /**
   * Claim a SEND from the floating composer. Return `true` to consume it — the
   * active view routed the text to its own target (e.g. the cockpit drives the
   * focused coding agent / room instead of the host agent), so the composer
   * clears and does NOT fall through to `controller.send`. Return
   * `false`/`undefined` to let the host agent handle it (driver mode).
   */
  onSubmit?: (text: string) => boolean;
}

interface BindingStore {
  current: ViewChatBinding | null;
  listeners: Set<() => void>;
}

function store(): BindingStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  const k = Symbol.for("elizaos.ui.view-chat-binding");
  const existing = g[k] as BindingStore | undefined;
  if (existing) return existing;
  const created: BindingStore = { current: null, listeners: new Set() };
  g[k] = created;
  return created;
}

export function setViewChatBinding(binding: ViewChatBinding | null): void {
  const s = store();
  s.current = binding;
  for (const l of s.listeners) l();
}

/** Read the active binding imperatively (for tests / non-React callers). */
export function getViewChatBinding(): ViewChatBinding | null {
  return store().current;
}

export function useViewChatBinding(): ViewChatBinding | null {
  const s = store();
  return React.useSyncExternalStore(
    (l) => {
      s.listeners.add(l);
      return () => s.listeners.delete(l);
    },
    () => s.current,
    () => s.current,
  );
}

/**
 * Register a view's chat binding for the lifetime of the calling component.
 * Pass a stable `onQuery` (e.g. a useState setter) — the binding re-registers
 * when `placeholder`/`onQuery` identity changes, and clears on unmount.
 */
export function useRegisterViewChatBinding(
  binding: ViewChatBinding | null,
): void {
  const placeholder = binding?.placeholder;
  const onQuery = binding?.onQuery;
  const onSubmit = binding?.onSubmit;
  React.useEffect(() => {
    setViewChatBinding(
      placeholder || onQuery || onSubmit
        ? { placeholder, onQuery, onSubmit }
        : null,
    );
    return () => setViewChatBinding(null);
  }, [placeholder, onQuery, onSubmit]);
}
