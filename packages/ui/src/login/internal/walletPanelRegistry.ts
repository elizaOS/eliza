/**
 * Wallet panel registry.
 *
 * Why this exists:
 *   `<LoginForm>` lives in the root entry (`@elizaos/ui`), but the EVM and
 *   Solana wallet panels statically import optional peer deps (`wagmi`,
 *   `@rainbow-me/rainbowkit`, `@solana/wallet-adapter-*`). If `<LoginForm>`
 *   even lazily references the panel modules by relative path, bundlers like
 *   Vite/Rollup/Webpack walk those paths and pull the peer deps into the
 *   root bundle's dep graph. Apps that don't install those peers fail at
 *   build time even when `showWallets` is left false.
 *
 * The fix is a simple registry. The root entry only imports types. Importing
 * `@elizaos/ui` triggers registration as a side effect (see
 * `src/wallet.ts`). Bundlers that don't see the import never traverse the
 * panel files. Apps that opt into wallets get the registration for free.
 *
 * SSR safety: registry state lives on a module-scoped object. Since panels
 * are React components used only during render after `<LoginProvider>`
 * mounts, registration timing is fine: the import happens at module load,
 * the LoginForm component reads at render.
 */

import type { ComponentType } from "react";

// Mirror of the LoginForm types/WalletLogin.tsx panel contract. Kept here
// to avoid pulling WalletLogin.tsx (which dynamic-imports the panels) into
// the root bundle.
export interface WalletPanelLoader {
  /** Loader returning the React panel component. Identity is stable; safe to
   *  use as a useEffect dep. */
  load: () => Promise<{ default: ComponentType<unknown> }>;
}

interface Registry {
  evm?: WalletPanelLoader;
  solana?: WalletPanelLoader;
}

const registry: Registry = {};

/** Register the EVM wallet panel loader. Called as a side effect from
 *  `@elizaos/ui`. */
export function registerEvmWalletPanel(loader: WalletPanelLoader): void {
  registry.evm = loader;
}

/** Register the Solana wallet panel loader. Called as a side effect from
 *  `@elizaos/ui`. */
export function registerSolanaWalletPanel(loader: WalletPanelLoader): void {
  registry.solana = loader;
}

/** Read the currently-registered EVM panel loader. Returns undefined when
 *  the consumer has not imported `@elizaos/ui`. */
export function getEvmWalletPanel(): WalletPanelLoader | undefined {
  return registry.evm;
}

/** Read the currently-registered Solana panel loader. Returns undefined when
 *  the consumer has not imported `@elizaos/ui`. */
export function getSolanaWalletPanel(): WalletPanelLoader | undefined {
  return registry.solana;
}

/** Test helper. Not exported from public entry. */
export function _resetWalletPanelRegistry(): void {
  registry.evm = undefined;
  registry.solana = undefined;
}
