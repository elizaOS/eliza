/**
 * Vault inventory panel — shows every secret stored, grouped by category,
 * with reveal / edit / delete and per-key profile management.
 *
 * Endpoints driven:
 *   GET    /api/secrets/inventory                       (load list)
 *   GET    /api/secrets/inventory/:key                  (reveal, on demand)
 *   PUT    /api/secrets/inventory/:key                  (add or replace)
 *   DELETE /api/secrets/inventory/:key                  (drop)
 *   GET    /api/secrets/inventory/:key/profiles         (profile list)
 *   POST   /api/secrets/inventory/:key/profiles         (add)
 *   PATCH  /api/secrets/inventory/:key/profiles/:id     (update)
 *   DELETE /api/secrets/inventory/:key/profiles/:id     (drop)
 *   PUT    /api/secrets/inventory/:key/active-profile   (switch active)
 *   POST   /api/secrets/inventory/migrate-to-profiles   (opt-in promotion)
 *
 * Routing rules live in a sibling tab (`RoutingTab`); the per-key
 * "Routing rules for this profile →" affordance hands control back to
 * the Vault modal via `onJumpToRouting`.
 *
 * Hard rule: revealed values never persist in component state past the
 * 10-second auto-hide window.
 */
import type { VaultEntryMeta } from "./vault-tabs/types";
export interface VaultInventoryPanelProps {
    /**
     * Pre-fetched entries owned by the parent tab. When provided, the
     * panel skips its internal load and delegates the refresh callback
     * upward via `onChanged`.
     */
    entries?: VaultEntryMeta[];
    /**
     * When the parent owns the data, this callback is invoked after every
     * mutation so the modal can re-fetch and propagate the new list to
     * sibling tabs.
     */
    onChanged?: () => void;
    /**
     * Cross-tab jump handler. When a row's "Routing rules for this
     * profile →" button is clicked, the panel calls this with the row's
     * key so the Vault modal can switch to the Routing tab pre-filtered.
     */
    onJumpToRouting?: (key: string) => void;
    /**
     * Optional row to focus when the panel mounts. Used by cross-tab
     * jumps from the Routing tab. The panel scrolls the row into view
     * and expands its profile panel, then clears the focus via
     * `onFocusApplied`.
     */
    focusKey?: string | null;
    /** Optional profile id to highlight inside the focused row. */
    focusProfileId?: string | null;
    /**
     * Called after the panel has applied the focus so the parent can
     * reset its focus state. Without this the panel would re-apply on
     * every parent re-render.
     */
    onFocusApplied?: () => void;
}
export declare function VaultInventoryPanel(props?: VaultInventoryPanelProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=VaultInventoryPanel.d.ts.map