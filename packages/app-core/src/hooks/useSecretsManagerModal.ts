import { useCallback, useEffect, useState } from "react";

/**
 * Global open/close state for the Vault modal.
 *
 * Backed by `window.dispatchEvent` rather than a React context so any
 * code path (renderer keydown, bun-side menu accelerator dispatched
 * via `subscribeDesktopBridgeEvent`, an inline Settings launcher
 * button) can trigger open/close without context plumbing through the
 * tree.
 *
 * The dispatch contract carries an optional initial tab plus optional
 * focus targets so cross-tab jumps (e.g. Routing rule chip → Secrets
 * tab pre-expanded on a key) can be parameterized through the same
 * event.
 */

export type VaultTab = "overview" | "secrets" | "logins" | "routing";

export const VAULT_TABS: readonly VaultTab[] = [
  "overview",
  "secrets",
  "logins",
  "routing",
] as const;

const EVENT_NAME = "eliza:secrets-manager-toggle";

interface OpenIntent {
  readonly action: "open";
  readonly tab?: VaultTab;
  readonly focusKey?: string;
  readonly focusProfileId?: string;
}

interface CloseIntent {
  readonly action: "close";
}

interface ToggleIntent {
  readonly action: "toggle";
  readonly tab?: VaultTab;
}

type ToggleDetail = OpenIntent | CloseIntent | ToggleIntent;

export interface SecretsManagerOpenOptions {
  readonly tab?: VaultTab;
  readonly focusKey?: string;
  readonly focusProfileId?: string;
}

export function dispatchSecretsManagerOpen(
  options: SecretsManagerOpenOptions = {},
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ToggleDetail>(EVENT_NAME, {
      detail: { action: "open", ...options },
    }),
  );
}

export function dispatchSecretsManagerClose(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ToggleDetail>(EVENT_NAME, { detail: { action: "close" } }),
  );
}

export function dispatchSecretsManagerToggle(tab?: VaultTab): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ToggleDetail>(EVENT_NAME, {
      detail: tab ? { action: "toggle", tab } : { action: "toggle" },
    }),
  );
}

export interface SecretsManagerModalState {
  readonly isOpen: boolean;
  readonly initialTab: VaultTab | null;
  readonly focusKey: string | null;
  readonly focusProfileId: string | null;
  readonly open: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
  readonly setOpen: (next: boolean) => void;
  readonly openOnTab: (options: SecretsManagerOpenOptions) => void;
  readonly clearFocus: () => void;
}

/**
 * Subscribe to the modal's open state. Useful for the modal itself
 * (it must mount its content based on this flag) and for the inline
 * launcher row (so it can optionally show "Manage…" disabled while
 * the modal is open).
 *
 * `initialTab` / `focusKey` / `focusProfileId` carry the parameters of
 * the most recent open dispatch. The modal consumes them on mount and
 * is expected to call `clearFocus()` once the focus has been applied so
 * subsequent opens (e.g. via the keyboard shortcut) start fresh.
 */
export function useSecretsManagerModalState(): SecretsManagerModalState {
  const [isOpen, setIsOpen] = useState(false);
  const [initialTab, setInitialTab] = useState<VaultTab | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [focusProfileId, setFocusProfileId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onToggle = (event: Event) => {
      const detail = (event as CustomEvent<ToggleDetail>).detail;
      if (!detail) return;
      if (detail.action === "open") {
        setIsOpen(true);
        setInitialTab(detail.tab ?? null);
        setFocusKey(detail.focusKey ?? null);
        setFocusProfileId(detail.focusProfileId ?? null);
        return;
      }
      if (detail.action === "close") {
        setIsOpen(false);
        return;
      }
      // toggle
      setIsOpen((prev) => {
        if (!prev && detail.tab) setInitialTab(detail.tab);
        return !prev;
      });
    };
    window.addEventListener(EVENT_NAME, onToggle);
    return () => {
      window.removeEventListener(EVENT_NAME, onToggle);
    };
  }, []);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  const setOpen = useCallback((next: boolean) => setIsOpen(next), []);
  const openOnTab = useCallback((options: SecretsManagerOpenOptions) => {
    setIsOpen(true);
    setInitialTab(options.tab ?? null);
    setFocusKey(options.focusKey ?? null);
    setFocusProfileId(options.focusProfileId ?? null);
  }, []);
  const clearFocus = useCallback(() => {
    setInitialTab(null);
    setFocusKey(null);
    setFocusProfileId(null);
  }, []);
  return {
    isOpen,
    initialTab,
    focusKey,
    focusProfileId,
    open,
    close,
    toggle,
    setOpen,
    openOnTab,
    clearFocus,
  };
}
