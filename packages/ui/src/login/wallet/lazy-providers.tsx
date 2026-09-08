/** Defers wallet adapters and cryptography until a host renders a wallet provider or requests configuration. */
import { lazy, Suspense } from "react";
import type { Config as WagmiConfig } from "wagmi";
import type { LoginFormWithWalletsProps } from "../components/LoginFormWithWallets.js";
import type {
  CreateDefaultWagmiConfigOptions,
  DefaultWagmiChains,
  EVMWalletProviderProps,
} from "../providers/EVMProvider.js";
import type { SolanaWalletProviderProps } from "../providers/SolanaProvider.js";

const EVMProvider = lazy(() =>
  import("../providers/EVMProvider.js").then((module) => ({
    default: module.EVMWalletProvider,
  })),
);
const SolanaProvider = lazy(() =>
  import("../providers/SolanaProvider.js").then((module) => ({
    default: module.SolanaWalletProvider,
  })),
);
const WalletForm = lazy(() =>
  import("../components/LoginFormWithWallets.js").then((module) => ({
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
  const provider = await import("../providers/EVMProvider.js");
  return provider.createDefaultWagmiConfig(options);
}
