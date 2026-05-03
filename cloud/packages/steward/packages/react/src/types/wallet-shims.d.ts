// Ambient shims for optional wallet peer dependencies.
// These declarations intentionally mirror just the surface area @stwd/react
// touches; when a consumer installs the real packages their types shadow these.
// Keeping the shims loose avoids locking us to a specific minor version.

declare module "wagmi" {
  export type Config = unknown;
  export interface WagmiProviderProps {
    config: Config;
    reconnectOnMount?: boolean;
    children?: import("react").ReactNode;
  }
  export const WagmiProvider: import("react").FC<WagmiProviderProps>;
  export function useAccount(): {
    address?: `0x${string}`;
    isConnected: boolean;
    connector?: { name?: string };
    chain?: { id: number; name: string };
  };
  export function useSignMessage(): {
    signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>;
  };
  export function useDisconnect(): { disconnect: () => void };
}

declare module "viem" {
  export type Address = `0x${string}`;
}

declare module "@rainbow-me/rainbowkit" {
  import type { FC, ReactNode } from "react";
  export interface Theme {}
  export function darkTheme(options?: Record<string, unknown>): Theme;
  export function lightTheme(options?: Record<string, unknown>): Theme;
  export interface RainbowKitProviderProps {
    theme?: Theme | null;
    modalSize?: "compact" | "wide";
    initialChain?: number;
    children?: ReactNode;
  }
  export const RainbowKitProvider: FC<RainbowKitProviderProps>;
  export interface ConnectButtonProps {
    label?: string;
    accountStatus?: "full" | "avatar" | "address";
    chainStatus?: "full" | "icon" | "name" | "none";
    showBalance?: boolean;
  }
  export const ConnectButton: FC<ConnectButtonProps>;
}

declare module "@rainbow-me/rainbowkit/styles.css" {
  const content: string;
  export default content;
}

declare module "@solana/wallet-adapter-react" {
  import type { FC, ReactNode } from "react";

  export interface PublicKeyLike {
    toBase58(): string;
    toBytes(): Uint8Array;
  }

  export interface WalletLike {
    adapter: {
      name: string;
      publicKey: PublicKeyLike | null;
      signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
    };
  }

  export function useWallet(): {
    publicKey: PublicKeyLike | null;
    connected: boolean;
    connecting: boolean;
    disconnect: () => Promise<void>;
    wallet: WalletLike | null;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  };

  export function useConnection(): { connection: unknown };

  export interface ConnectionProviderProps {
    endpoint: string;
    config?: Record<string, unknown>;
    children?: ReactNode;
  }
  export const ConnectionProvider: FC<ConnectionProviderProps>;

  export interface WalletProviderProps {
    wallets: unknown[];
    autoConnect?: boolean;
    children?: ReactNode;
  }
  export const WalletProvider: FC<WalletProviderProps>;
}

declare module "@solana/wallet-adapter-react-ui" {
  import type { FC, ReactNode } from "react";
  export const WalletMultiButton: FC<{ className?: string }>;
  export const WalletModalProvider: FC<{ children?: ReactNode }>;
}

declare module "@solana/wallet-adapter-react-ui/styles.css" {
  const content: string;
  export default content;
}

declare module "@solana/wallet-adapter-wallets" {
  export class PhantomWalletAdapter {}
  export class SolflareWalletAdapter {}
}

declare module "@solana/web3.js" {
  export class PublicKey {
    constructor(value: string | Uint8Array | number[]);
    toBase58(): string;
    toBytes(): Uint8Array;
  }
}

declare module "bs58" {
  const bs58: {
    encode: (input: Uint8Array) => string;
    decode: (input: string) => Uint8Array;
  };
  export default bs58;
}

declare module "@tanstack/react-query" {
  import type { FC, ReactNode } from "react";
  export class QueryClient {
    constructor(opts?: Record<string, unknown>);
  }
  export interface QueryClientProviderProps {
    client: QueryClient;
    children?: ReactNode;
  }
  export const QueryClientProvider: FC<QueryClientProviderProps>;
}
