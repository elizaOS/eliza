"use client";

/** Composes login with configurable EVM and Solana wallet providers owned by the host application. */
import { ElizaError } from "@elizaos/core/errors";
import { type ReactNode, useMemo } from "react";
import type { Chain } from "viem";
import type { Config as WagmiConfig } from "wagmi";
import {
  arbitrum,
  base,
  bsc,
  gnosis,
  mainnet,
  optimism,
  polygon,
} from "wagmi/chains";
import {
  type CreateDefaultWagmiConfigOptions,
  createDefaultWagmiConfig,
  EVMWalletProvider,
  type EVMWalletProviderProps,
} from "../providers/EVMProvider.js";
import {
  SolanaWalletProvider,
  type SolanaWalletProviderProps,
} from "../providers/SolanaProvider.js";
import type { LoginFormProps } from "../types.js";
import { LoginForm } from "./LoginForm.js";

/** Default chain set for the bundled EVM wagmi config. */
const DEFAULT_EVM_CHAINS = [
  mainnet,
  base,
  polygon,
  gnosis,
  optimism,
  arbitrum,
  bsc,
] as const;

/** Default Solana JSON-RPC endpoint. Production apps should pass a private RPC
 *  (Helius, QuickNode) via `solana.endpoint`. The public mainnet-beta
 *  endpoint is rate-limited and not for production. */
const DEFAULT_SOLANA_ENDPOINT = "https://api.mainnet-beta.solana.com";

export interface LoginFormWithWalletsEvmConfig {
  /** Pre-built wagmi `Config`. Takes precedence over the rest of this object. */
  config?: WagmiConfig;
  /** Host-owned WalletConnect project ID, or NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID. */
  projectId?: string;
  /** Chains to support. Defaults to a curated EVM mainnet set. */
  chains?: readonly [Chain, ...Chain[]];
  /** App name shown in the WalletConnect connection prompt. Default: "elizaOS". */
  appName?: string;
  /** Extra RainbowKit wallet entries, such as elizaOS global-wallet connectors. */
  wallets?: CreateDefaultWagmiConfigOptions<
    readonly [Chain, ...Chain[]]
  >["wallets"];
  /** Forwarded to `<EVMWalletProvider>` (theme / modalSize / queryClient / etc). */
  providerProps?: Omit<EVMWalletProviderProps, "config" | "children">;
}

export interface LoginFormWithWalletsSolanaConfig {
  /** JSON-RPC endpoint. Default: public mainnet-beta. */
  endpoint?: string;
  /** Override default wallet adapter list. */
  wallets?: SolanaWalletProviderProps["wallets"];
  /** Auto-connect previously selected wallet on mount. Default true. */
  autoConnect?: boolean;
}

export interface LoginFormWithWalletsProps extends LoginFormProps {
  /** EVM provider configuration. */
  evm?: LoginFormWithWalletsEvmConfig;
  /** Solana provider configuration. */
  solana?: LoginFormWithWalletsSolanaConfig;
  /** Per-chain enable gates. Set `evm: false` to skip EVM wrap, `solana: false`
   *  to skip Solana wrap. By default, both wraps are applied. */
  enable?: { evm?: boolean; solana?: boolean };
}

// Bundlers (Next, Vite, esbuild, etc) inline public env vars at build
// time but ONLY when they see the bare member expression
// `process.env.NEXT_PUBLIC_X`. Webpack's DefinePlugin and Vite's `define`
// match a MemberExpression AST node; an OptionalMemberExpression
// (`process?.env?.X`) is a different node shape and is left alone.
// We therefore reference each var via plain `process.env.X` and guard
// `process` itself with `typeof` so this still works in browser-only
// runtimes that lack a `process` global.
//
// In server (Node) builds: this is just a runtime env read.
// In bundler-targeted client builds: Webpack/Vite/esbuild rewrite each
// `process.env.NEXT_PUBLIC_X` to the literal string at compile time, so
// the value is baked into the consumer's bundle.

declare const process: { env: Record<string, string | undefined> } | undefined;

function readSolanaRpcEnv(): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
}

function resolveProjectId(override: string | undefined): string {
  const projectId =
    override ??
    (typeof process === "undefined"
      ? undefined
      : process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);
  if (!projectId?.trim()) {
    throw new ElizaError(
      "Configure evm.projectId with your WalletConnect project ID or supply evm.config",
      { code: "LOGIN_WALLETCONNECT_PROJECT_REQUIRED" },
    );
  }
  return projectId.trim();
}

function resolveSolanaEndpoint(override: string | undefined): string {
  if (override) return override;
  return readSolanaRpcEnv() ?? DEFAULT_SOLANA_ENDPOINT;
}

/**
 * The simplest possible wallet-login surface, one component.
 *
 * Wraps children with `<EVMWalletProvider>` and `<SolanaWalletProvider>`
 * (each can be disabled via `enable`) and renders `<LoginForm>` with
 * the requested `showWallets` value. All other `<LoginForm>` props
 * are forwarded.
 *
 * Always mount inside a `<LoginProvider>` so the auth context is available.
 */
export function LoginFormWithWallets({
  evm,
  solana,
  enable,
  ...loginProps
}: LoginFormWithWalletsProps) {
  const evmEnabled = enable?.evm !== false;
  const solanaEnabled = enable?.solana !== false;

  const wagmiConfig = useMemo<WagmiConfig | null>(() => {
    if (!evmEnabled) return null;
    if (evm?.config) return evm.config;
    return createDefaultWagmiConfig({
      projectId: resolveProjectId(evm?.projectId),
      chains: evm?.chains ?? DEFAULT_EVM_CHAINS,
      appName: evm?.appName ?? "elizaOS",
      wallets: evm?.wallets,
    });
  }, [
    evmEnabled,
    evm?.config,
    evm?.projectId,
    evm?.chains,
    evm?.appName,
    evm?.wallets,
  ]);

  const solanaEndpoint = useMemo(
    () => (solanaEnabled ? resolveSolanaEndpoint(solana?.endpoint) : null),
    [solanaEnabled, solana?.endpoint],
  );

  // Default showWallets to true: this component exists specifically to
  // surface wallet sign-in. Consumers can still pass showWallets={false}
  // to fall back to passkey/email/oauth-only behavior, e.g. for A/B tests.
  const showWallets = loginProps.showWallets ?? {
    evm: evmEnabled,
    solana: solanaEnabled,
  };

  let tree: ReactNode = <LoginForm {...loginProps} showWallets={showWallets} />;

  if (solanaEnabled && solanaEndpoint) {
    tree = (
      <SolanaWalletProvider
        endpoint={solanaEndpoint}
        wallets={solana?.wallets}
        autoConnect={solana?.autoConnect}
      >
        {tree}
      </SolanaWalletProvider>
    );
  }

  if (evmEnabled && wagmiConfig) {
    tree = (
      <EVMWalletProvider {...(evm?.providerProps ?? {})} config={wagmiConfig}>
        {tree}
      </EVMWalletProvider>
    );
  }

  return <>{tree}</>;
}
