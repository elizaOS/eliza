/**
 * Type declarations for Synpress modules
 * These packages don't have official type declarations
 */

declare module "@synthetixio/synpress-cache" {
  import type { BrowserContext, Page } from "@playwright/test";

  export function defineWalletSetup(
    password: string,
    setupFn: (context: BrowserContext, walletPage: Page) => Promise<void>,
  ): unknown;
}

declare module "@synthetixio/synpress/playwright" {
  import type { BrowserContext, test as base, Page } from "@playwright/test";

  // Wallet setup function result from defineWalletSetup
  type WalletSetup = unknown;

  // MetaMask fixtures function
  export function metaMaskFixtures(
    walletSetup: WalletSetup,
    extensionIndex?: number,
  ): typeof base;

  // Network configuration for MetaMask
  export interface NetworkConfig {
    name: string;
    rpcUrl: string;
    chainId: number;
    symbol: string;
  }

  // MetaMask class for wallet interactions
  export class MetaMask {
    constructor(context: BrowserContext, walletPage: Page, password: string);
    importWallet(seedPhrase: string): Promise<void>;
    addNetwork(network: NetworkConfig): Promise<void>;
    switchNetwork(networkName: string): Promise<void>;
    connectToDapp(): Promise<void>;
    confirmTransaction(): Promise<void>;
    rejectTransaction(): Promise<void>;
    signMessage(): Promise<void>;
  }
}

declare module "@synthetixio/synpress-metamask/playwright" {
  import type { BrowserContext, test as base, Page } from "@playwright/test";

  // Wallet setup function result from defineWalletSetup
  type WalletSetup = unknown;

  // MetaMask fixtures function
  export function metaMaskFixtures(
    walletSetup: WalletSetup,
    extensionIndex?: number,
  ): typeof base;

  export interface NetworkConfig {
    name: string;
    rpcUrl: string;
    chainId: number;
    symbol: string;
  }

  export class MetaMask {
    constructor(context: BrowserContext, walletPage: Page, password: string);
    importWallet(seedPhrase: string): Promise<void>;
    addNetwork(network: NetworkConfig): Promise<void>;
    switchNetwork(networkName: string): Promise<void>;
    connectToDapp(): Promise<void>;
    confirmTransaction(): Promise<void>;
    rejectTransaction(): Promise<void>;
    signMessage(): Promise<void>;
  }
}
