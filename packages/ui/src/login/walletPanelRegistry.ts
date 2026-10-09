import type { ComponentType } from "react";

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
