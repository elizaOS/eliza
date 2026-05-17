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
export declare const VAULT_TABS: readonly VaultTab[];
export interface SecretsManagerOpenOptions {
  readonly tab?: VaultTab;
  readonly focusKey?: string;
  readonly focusProfileId?: string;
}
export declare function dispatchSecretsManagerOpen(
  options?: SecretsManagerOpenOptions,
): void;
export declare function dispatchSecretsManagerClose(): void;
export declare function dispatchSecretsManagerToggle(tab?: VaultTab): void;
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
export declare function useSecretsManagerModalState(): SecretsManagerModalState;
//# sourceMappingURL=useSecretsManagerModal.d.ts.map
