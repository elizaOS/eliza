/**
 * Payout Status Service
 *
 * Provides system-wide status checks for the payout infrastructure.
 * Used to inform users and admins about payout availability.
 */

import { type Address, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ELIZA_DECIMALS, EVM_CHAINS } from "@/lib/config/token-constants";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { logger } from "@/lib/utils/logger";
import { ELIZA_TOKEN_ADDRESSES, type SupportedNetwork } from "./eliza-token-price";

// ============================================================================
// TYPES
// ============================================================================

export interface NetworkStatus {
  network: SupportedNetwork;
  configured: boolean;
  walletAddress: string | null;
  balance: number;
  hasBalance: boolean;
  status: "operational" | "low_balance" | "no_balance" | "not_configured";
  message: string;
}

export interface PayoutSystemStatus {
  operational: boolean;
  networks: NetworkStatus[];
  warnings: string[];
  lastChecked: Date;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

// Token decimals + EVM chains imported from @/lib/config/token-constants

// Thresholds for warnings
const LOW_BALANCE_THRESHOLD = 100; // Tokens

// ============================================================================
// SERVICE
// ============================================================================

class PayoutStatusService {
  private cachedStatus: PayoutSystemStatus | null = null;
  private cacheExpiry: Date | null = null;
  private readonly CACHE_TTL_MS = 60 * 1000; // 1 minute cache

  /**
   * Get the current payout system status
   */
  async getStatus(forceRefresh = false): Promise<PayoutSystemStatus> {
    // Return cached if valid
    if (!forceRefresh && this.cachedStatus && this.cacheExpiry && new Date() < this.cacheExpiry) {
      return this.cachedStatus;
    }

    const networks: NetworkStatus[] = [];
    const warnings: string[] = [];
    const env = getCloudAwareEnv();
    const skipLiveBalanceChecks = this.shouldSkipLiveBalanceChecks(env);

    // Check EVM networks (support both naming conventions)
    const evmPrivateKey = env.EVM_PAYOUT_PRIVATE_KEY || env.EVM_PRIVATE_KEY;
    const evmConfigured = Boolean(evmPrivateKey || env.EVM_PAYOUT_WALLET_ADDRESS);
    const evmWalletAddress = skipLiveBalanceChecks
      ? (env.EVM_PAYOUT_WALLET_ADDRESS ?? (evmPrivateKey ? "configured" : null))
      : evmPrivateKey
        ? this.getEvmWalletAddress(evmPrivateKey)
        : null;

    for (const network of ["ethereum", "base", "bnb"] as const) {
      const status = skipLiveBalanceChecks
        ? this.buildSkippedBalanceStatus(network, evmConfigured, evmWalletAddress)
        : await this.checkEvmNetwork(network, evmWalletAddress);
      networks.push(status);

      if (status.status !== "operational") {
        warnings.push(`${network}: ${status.message}`);
      }
    }

    // Check Solana
    const solanaPrivateKey = env.SOLANA_PAYOUT_PRIVATE_KEY;
    const solanaConfigured = Boolean(solanaPrivateKey || env.SOLANA_PAYOUT_WALLET_ADDRESS);
    const solanaWalletAddress = skipLiveBalanceChecks
      ? (env.SOLANA_PAYOUT_WALLET_ADDRESS ?? (solanaPrivateKey ? "configured" : null))
      : solanaPrivateKey
        ? this.getSolanaWalletAddress(solanaPrivateKey)
        : null;

    const solanaStatus = skipLiveBalanceChecks
      ? this.buildSkippedBalanceStatus("solana", solanaConfigured, solanaWalletAddress)
      : await this.checkSolanaNetwork(solanaWalletAddress);
    networks.push(solanaStatus);

    if (solanaStatus.status !== "operational") {
      warnings.push(`solana: ${solanaStatus.message}`);
    }

    // Determine overall operational status
    const operationalNetworks = networks.filter((n) => n.status === "operational");
    const operational = operationalNetworks.length > 0;

    // Add general warnings
    if (!operational) {
      warnings.unshift(
        "⚠️ No payout networks currently available. Token redemption is temporarily disabled.",
      );
    } else if (operationalNetworks.length < networks.length) {
      warnings.unshift(
        `⚠️ Some payout networks are unavailable. Available: ${operationalNetworks.map((n) => n.network).join(", ")}`,
      );
    }

    const status: PayoutSystemStatus = {
      operational,
      networks,
      warnings,
      lastChecked: new Date(),
    };

    // Cache the result
    this.cachedStatus = status;
    this.cacheExpiry = new Date(Date.now() + this.CACHE_TTL_MS);

    return status;
  }

  /**
   * Check if a specific network is available for payouts
   */
  async isNetworkAvailable(network: SupportedNetwork): Promise<{
    available: boolean;
    message: string;
  }> {
    const status = await this.getStatus();
    const networkStatus = status.networks.find((n) => n.network === network);

    if (!networkStatus) {
      return {
        available: false,
        message: `Unknown network: ${network}`,
      };
    }

    return {
      available: networkStatus.status === "operational" || networkStatus.status === "low_balance",
      message: networkStatus.message,
    };
  }

  /**
   * Get user-friendly message for payout unavailability
   */
  getUserMessage(network?: SupportedNetwork): string | null {
    const env = getCloudAwareEnv();
    const evmConfigured = !!(env.EVM_PAYOUT_PRIVATE_KEY || env.EVM_PRIVATE_KEY);
    const solanaConfigured = !!env.SOLANA_PAYOUT_PRIVATE_KEY;

    if (!evmConfigured && !solanaConfigured) {
      return "Token redemption is temporarily unavailable. We're setting up our payout infrastructure. Please check back soon!";
    }

    if (network) {
      if (network === "solana" && !solanaConfigured) {
        return "Solana payouts are not currently available. Please try a different network (Ethereum, Base, or BNB).";
      }
      if (network !== "solana" && !evmConfigured) {
        return "EVM payouts are not currently available. Please try Solana instead.";
      }
    }

    return null;
  }

  // ========================================
  // Private methods
  // ========================================

  private shouldSkipLiveBalanceChecks(env: NodeJS.ProcessEnv): boolean {
    return (
      env.PAYOUT_STATUS_SKIP_LIVE_BALANCE === "1" || env.SKIP_PAYOUT_BALANCE_CHECKS === "1"
    );
  }

  private buildSkippedBalanceStatus(
    network: SupportedNetwork,
    configured: boolean,
    walletAddress: string | null,
  ): NetworkStatus {
    if (!configured) {
      return {
        network,
        configured: false,
        walletAddress: null,
        balance: 0,
        hasBalance: false,
        status: "not_configured",
        message:
          network === "solana"
            ? "Solana payout wallet not configured"
            : "EVM payout wallet not configured",
      };
    }

    return {
      network,
      configured: true,
      walletAddress: walletAddress ? this.maskAddress(walletAddress) : null,
      balance: 0,
      hasBalance: false,
      status: "no_balance",
      message: "Live payout balance check skipped",
    };
  }

  private getEvmWalletAddress(privateKey: string): string | null {
    const key = privateKey.startsWith("0x")
      ? (privateKey as `0x${string}`)
      : (`0x${privateKey}` as `0x${string}`);
    const account = privateKeyToAccount(key);
    return account.address;
  }

  private getSolanaWalletAddress(privateKey: string): string | null {
    // Solana private key is base58 encoded
    const { Keypair } = require("@solana/web3.js");
    const bs58 = require("bs58");
    const decoded = bs58.decode(privateKey);
    const keypair = Keypair.fromSecretKey(decoded);
    return keypair.publicKey.toBase58();
  }

  private async checkEvmNetwork(
    network: "ethereum" | "base" | "bnb",
    walletAddress: string | null,
  ): Promise<NetworkStatus> {
    if (!walletAddress) {
      return {
        network,
        configured: false,
        walletAddress: null,
        balance: 0,
        hasBalance: false,
        status: "not_configured",
        message: "EVM payout wallet not configured",
      };
    }

    const chain = EVM_CHAINS[network];
    const tokenAddress = ELIZA_TOKEN_ADDRESSES[network] as Address;
    const decimals = ELIZA_DECIMALS[network];

    const publicClient = createPublicClient({
      chain,
      transport: http(),
    });

    const ERC20_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

    let balance = 0;
    let error: string | null = null;

    const rawBalance = await publicClient
      .readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletAddress as Address],
      })
      .catch((err) => {
        error = err.message;
        return BigInt(0);
      });

    balance = Number(rawBalance) / 10 ** decimals;

    if (error) {
      logger.warn(`[PayoutStatus] Failed to check ${network} balance`, {
        error,
      });
      return {
        network,
        configured: true,
        walletAddress: this.maskAddress(walletAddress),
        balance: 0,
        hasBalance: false,
        status: "not_configured",
        message: `Failed to check balance: ${error}`,
      };
    }

    if (balance === 0) {
      return {
        network,
        configured: true,
        walletAddress: this.maskAddress(walletAddress),
        balance,
        hasBalance: false,
        status: "no_balance",
        message: "Payout wallet has no elizaOS tokens",
      };
    }

    if (balance < LOW_BALANCE_THRESHOLD) {
      return {
        network,
        configured: true,
        walletAddress: this.maskAddress(walletAddress),
        balance,
        hasBalance: true,
        status: "low_balance",
        message: `Low balance: ${balance.toFixed(2)} tokens (threshold: ${LOW_BALANCE_THRESHOLD})`,
      };
    }

    return {
      network,
      configured: true,
      walletAddress: this.maskAddress(walletAddress),
      balance,
      hasBalance: true,
      status: "operational",
      message: `Operational with ${balance.toFixed(2)} tokens available`,
    };
  }

  private async checkSolanaNetwork(walletAddress: string | null): Promise<NetworkStatus> {
    if (!walletAddress) {
      return {
        network: "solana",
        configured: false,
        walletAddress: null,
        balance: 0,
        hasBalance: false,
        status: "not_configured",
        message: "Solana payout wallet not configured",
      };
    }

    const env = getCloudAwareEnv();
    const solanaRpc = env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const { Connection, PublicKey } =
      require("@solana/web3.js") as typeof import("@solana/web3.js");
    const { getAssociatedTokenAddress, getAccount } =
      require("@solana/spl-token") as typeof import("@solana/spl-token");
    const connection = new Connection(solanaRpc, "confirmed");
    const mintAddress = new PublicKey(ELIZA_TOKEN_ADDRESSES.solana);
    const walletPubkey = new PublicKey(walletAddress);

    const ata = await getAssociatedTokenAddress(mintAddress, walletPubkey);

    let balance = 0;
    const account = await getAccount(connection, ata).catch(() => null);

    if (!account) {
      return {
        network: "solana",
        configured: true,
        walletAddress: this.maskAddress(walletAddress),
        balance: 0,
        hasBalance: false,
        status: "no_balance",
        message: "Payout wallet token account not found or has no tokens",
      };
    }

    balance = Number(account.amount) / 10 ** ELIZA_DECIMALS.solana;

    if (balance === 0) {
      return {
        network: "solana",
        configured: true,
        walletAddress: this.maskAddress(walletAddress),
        balance,
        hasBalance: false,
        status: "no_balance",
        message: "Payout wallet has no elizaOS tokens",
      };
    }

    if (balance < LOW_BALANCE_THRESHOLD) {
      return {
        network: "solana",
        configured: true,
        walletAddress: this.maskAddress(walletAddress),
        balance,
        hasBalance: true,
        status: "low_balance",
        message: `Low balance: ${balance.toFixed(2)} tokens (threshold: ${LOW_BALANCE_THRESHOLD})`,
      };
    }

    return {
      network: "solana",
      configured: true,
      walletAddress: this.maskAddress(walletAddress),
      balance,
      hasBalance: true,
      status: "operational",
      message: `Operational with ${balance.toFixed(2)} tokens available`,
    };
  }

  private maskAddress(address: string): string {
    if (address.length < 12) return "****";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}

// Export singleton
export const payoutStatusService = new PayoutStatusService();
