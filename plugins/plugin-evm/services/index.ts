import type { Transport } from "viem";
import { base, mainnet, optimism, arbitrum, type Chain } from "viem/chains";
import { createPublicClient, http, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Singleton service to manage EVM viem clients per chain
 */
export class EVMService {
  private static instance: EVMService | null = null;
  private initialized: boolean = false;
  private accountHex: `0x${string}` | null = null;
  private chains: Chain[] = [base];
  private publicClients: Map<number, ReturnType<typeof createPublicClient>> =
    new Map();
  private walletClients: Map<number, ReturnType<typeof createWalletClient>> =
    new Map();

  private constructor() {}

  public static getInstance(): EVMService {
    if (!EVMService.instance) {
      EVMService.instance = new EVMService();
    }
    return EVMService.instance;
  }

  public initialize(params: {
    walletPrivateKey: string;
    chainIds?: Array<Chain | string>;
    transport?: Transport;
  }): void {
    if (this.initialized && params.walletPrivateKey === this.accountHex) return;

    const { walletPrivateKey, chainIds, transport } = params;

    if (!walletPrivateKey || walletPrivateKey.trim() === "") {
      throw new Error("WALLET_PRIVATE_KEY is required for EVMService");
    }

    const normalizedPk = walletPrivateKey.startsWith("0x")
      ? (walletPrivateKey as `0x${string}`)
      : (("0x" + walletPrivateKey) as `0x${string}`);

    this.accountHex = normalizedPk;

    const availableChains: Record<string, Chain> = {
      base,
      mainnet,
      optimism,
      arbitrum,
    };

    if (chainIds && chainIds.length > 0) {
      this.chains = chainIds.map((c) => {
        if (typeof c === "string") {
          const chain = availableChains[c];
          if (!chain) throw new Error(`Unsupported chain: ${c}`);
          return chain;
        }
        return c;
      });
    } else {
      this.chains = [base];
    }

    // Create clients per chain
    this.publicClients.clear();
    this.walletClients.clear();

    const account = privateKeyToAccount(this.accountHex);
    for (const chain of this.chains) {
      const t = transport ?? http();
      const pc = createPublicClient({ chain, transport: t });
      const wc = createWalletClient({ chain, account, transport: t });
      this.publicClients.set(chain.id, pc);
      this.walletClients.set(chain.id, wc);
    }

    this.initialized = true;
  }

  public getChains(): Chain[] {
    return this.chains;
  }

  public getPublicClient(chainId?: number) {
    const id = chainId ?? this.chains[0].id;
    const client = this.publicClients.get(id);
    if (!client)
      throw new Error(`Public client for chainId ${id} not initialized`);
    return client;
  }

  public getWalletClient(chainId?: number) {
    const id = chainId ?? this.chains[0].id;
    const client = this.walletClients.get(id);
    if (!client)
      throw new Error(`Wallet client for chainId ${id} not initialized`);
    return client;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }
}

export const evmService = EVMService.getInstance();
