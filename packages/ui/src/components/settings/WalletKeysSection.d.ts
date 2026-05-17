/**
 * Wallet keys panel for Settings -> Wallet & RPC.
 *
 * Single source of truth: `/api/secrets/inventory?category=wallet`.
 * Reveal / delete go through the same `/api/secrets/inventory/:key`
 * endpoints the Vault tab uses, so toggling a value here shows up
 * immediately in Settings -> Vault and vice versa.
 *
 * Scope: lists wallet-category vault entries (EVM_PRIVATE_KEY,
 * SOLANA_PRIVATE_KEY, per-agent `agent.<id>.wallet.<chain>`) with a
 * reveal-on-demand value display and an "Add wallet key" form.
 *
 * Per-agent address derivation is read from the entry's reveal payload
 * (the per-agent storage shape is JSON with `{address, privateKey}`),
 * so the panel doesn't need to bundle a key-derivation library on the
 * client.
 */
export declare function WalletKeysSection(): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=WalletKeysSection.d.ts.map