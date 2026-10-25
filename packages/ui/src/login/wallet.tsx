/** Defers wallet adapters and cryptography until a host renders a wallet provider or requests configuration. */
import { lazy, Suspense } from "react";
import type { Config as WagmiConfig } from "wagmi";
import type {
  CreateDefaultWagmiConfigOptions,
  DefaultWagmiChains,
  EVMWalletProviderProps,
} from "./EVMProvider.js";
import type { LoginFormWithWalletsProps } from "./LoginFormWithWallets.js";
import type { SolanaWalletProviderProps } from "./SolanaProvider.js";

const EVMProvider = lazy(() =>
  import("./EVMProvider.js").then((module) => ({
    default: module.EVMWalletProvider,
  })),
);
const SolanaProvider = lazy(() =>
  import("./SolanaProvider.js").then((module) => ({
    default: module.SolanaWalletProvider,
  })),
);
const WalletForm = lazy(() =>
  import("./LoginFormWithWallets.js").then((module) => ({
    default: module.LoginFormWithWallets,
  })),
);
const loading = <span role="status">Loading wallets…</span>;

export function EVMWalletProvider(props: EVMWalletProviderProps) {
  return (
    <Suspense fallback={loading}>
      <EVMProvider {...props} />
    </Suspense>
  );
}

export function SolanaWalletProvider(props: SolanaWalletProviderProps) {
  return (
    <Suspense fallback={loading}>
      <SolanaProvider {...props} />
    </Suspense>
  );
}

export function LoginFormWithWallets(props: LoginFormWithWalletsProps) {
  return (
    <Suspense fallback={loading}>
      <WalletForm {...props} />
    </Suspense>
  );
}

/** Loads the EVM adapters and creates configuration using the host's WalletConnect project. */
export async function createDefaultWagmiConfig<
  TChains extends DefaultWagmiChains,
>(options: CreateDefaultWagmiConfigOptions<TChains>): Promise<WagmiConfig> {
  const provider = await import("./EVMProvider.js");
  return provider.createDefaultWagmiConfig(options);
}

import {
  registerEvmWalletPanel,
  registerSolanaWalletPanel,
} from "./walletPanelRegistry.js";

// Register lazy panels when the public wallet entry loads.
registerEvmWalletPanel({
  load: () =>
    import("./WalletLogin.EVM.js") as Promise<{
      default: import("react").ComponentType<unknown>;
    }>,
});
registerSolanaWalletPanel({
  load: () =>
    import("./WalletLogin.Solana.js") as Promise<{
      default: import("react").ComponentType<unknown>;
    }>,
});
