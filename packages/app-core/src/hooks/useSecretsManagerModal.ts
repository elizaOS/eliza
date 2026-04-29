import { useCallback, useEffect, useState } from "react";

/**
 * Global open/close state for the Secrets Manager modal.
 *
 * Backed by `window.dispatchEvent` rather than a React context so any
 * code path (renderer keydown, bun-side menu accelerator dispatched
 * via `subscribeDesktopBridgeEvent`, an inline Settings launcher
 * button) can trigger open/close without context plumbing through the
 * tree.
 */

const EVENT_NAME = "milady:secrets-manager-toggle";
let currentOpen = false;
const listeners = new Set<() => void>();

interface ToggleDetail {
  readonly action: "open" | "close" | "toggle";
}

export function dispatchSecretsManagerOpen(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ToggleDetail>(EVENT_NAME, { detail: { action: "open" } }),
  );
}

export function dispatchSecretsManagerClose(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ToggleDetail>(EVENT_NAME, { detail: { action: "close" } }),
  );
}

export function dispatchSecretsManagerToggle(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ToggleDetail>(EVENT_NAME, { detail: { action: "toggle" } }),
  );
}

function setGlobalOpen(next: boolean | ((prev: boolean) => boolean)): void {
  const resolved = typeof next === "function" ? next(currentOpen) : next;
  if (resolved === currentOpen) return;
  currentOpen = resolved;
  for (const listener of listeners) listener();
}

/**
 * Subscribe to the modal's open state. Useful for the modal itself
 * (it must mount its content based on this flag) and for the inline
 * launcher row (so it can optionally show "Manage…" disabled while
 * the modal is open).
 */
export function useSecretsManagerModalState(): {
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
  readonly setOpen: (next: boolean) => void;
} {
  const [isOpen, setIsOpen] = useState(currentOpen);

  useEffect(() => {
    const sync = () => setIsOpen(currentOpen);
    listeners.add(sync);
    if (typeof window === "undefined") {
      return () => {
        listeners.delete(sync);
      };
    }
    const onToggle = (event: Event) => {
      const detail = (event as CustomEvent<ToggleDetail>).detail;
      if (!detail) return;
      if (detail.action === "open") setGlobalOpen(true);
      else if (detail.action === "close") setGlobalOpen(false);
      else setGlobalOpen((prev) => !prev);
    };
    window.addEventListener(EVENT_NAME, onToggle);
    return () => {
      listeners.delete(sync);
      window.removeEventListener(EVENT_NAME, onToggle);
    };
  }, []);

  const open = useCallback(() => setGlobalOpen(true), []);
  const close = useCallback(() => setGlobalOpen(false), []);
  const toggle = useCallback(() => setGlobalOpen((prev) => !prev), []);
  const setOpen = useCallback((next: boolean) => setGlobalOpen(next), []);
  return { isOpen, open, close, toggle, setOpen };
}
