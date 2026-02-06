/**
 * CDP (Coinbase Developer Platform) Wallet Service
 *
 * This service provides direct on-chain payment verification using CDP.
 * Currently not actively used in the crypto payment flow (OxaPay is the primary provider).
 *
 * Maintained for potential future use cases:
 * - Direct USDC payments on Base/Base Sepolia
 * - Payment verification without third-party dependencies
 * - Custom wallet integrations
 *
 * @deprecated Consider using OxaPay service for production workloads
 */
import { logger } from "@/lib/utils/logger";
import {
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { createHash } from "crypto";
import Decimal from "decimal.js";
import { PAYMENT_EXPIRATION_MS } from "@/lib/config/crypto";

export type CdpNetwork = "base" | "base-sepolia";

interface NetworkConfig {
  chain: typeof base | typeof baseSepolia;
  chainId: number;
  usdcAddress: Address;
  rpcUrl: string;
  isTestnet: boolean;
  minimumConfirmations: number;
  tolerancePercent: number;
}

const NETWORK_CONFIGS: Record<CdpNetwork, NetworkConfig> = {
  base: {
    chain: base,
    chainId: 8453,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcUrl: "https://mainnet.base.org",
    isTestnet: false,
    minimumConfirmations: Number(process.env.CDP_BASE_MIN_CONFIRMATIONS || 10),
    tolerancePercent: 0.5,
  },
  "base-sepolia": {
    chain: baseSepolia,
    chainId: 84532,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    rpcUrl: "https://sepolia.base.org",
    isTestnet: true,
    minimumConfirmations: Number(
      process.env.CDP_BASE_SEPOLIA_MIN_CONFIRMATIONS || 3,
    ),
    tolerancePercent: 1.0,
  },
};

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

function getWalletConfig():
  | { type: "mnemonic"; value: string }
  | { type: "privateKey"; value: Hex }
  | null {
  const mnemonic = process.env.CRYPTO_WALLET_MNEMONIC;
  const privateKey = process.env.CRYPTO_WALLET_PRIVATE_KEY;

  if (mnemonic) {
    return { type: "mnemonic", value: mnemonic };
  }

  if (privateKey) {
    return { type: "privateKey", value: privateKey as Hex };
  }

  return null;
}

function deriveAddressFromMnemonic(mnemonic: string, index: number): Address {
  const account = mnemonicToAccount(mnemonic, {
    accountIndex: 0,
    addressIndex: index,
  });
  return account.address;
}

function deriveIndexFromPaymentId(paymentId: string): number {
  const hash = createHash("sha256").update(paymentId).digest();
  return hash.readUInt32BE(0) % 2147483647;
}

export function isCdpConfigured(): boolean {
  return Boolean(getWalletConfig());
}

export function getDefaultNetwork(): CdpNetwork {
  const envNetwork = process.env.CDP_NETWORK as CdpNetwork | undefined;
  if (envNetwork && NETWORK_CONFIGS[envNetwork]) return envNetwork;
  if (process.env.NODE_ENV === "production") return "base";
  return "base-sepolia";
}

class CdpWalletService {
  async createPaymentAddress(
    network: CdpNetwork = getDefaultNetwork(),
    paymentId?: string,
  ): Promise<{
    address: string;
    network: CdpNetwork;
    expiresAt: Date;
  }> {
    const walletConfig = getWalletConfig();

    if (!walletConfig) {
      throw new Error(
        "Wallet not configured. Set CRYPTO_WALLET_MNEMONIC or CRYPTO_WALLET_PRIVATE_KEY",
      );
    }

    logger.info("[CDP Wallet] Creating payment address", { network });

    let address: Address;

    if (walletConfig.type === "mnemonic") {
      const index = paymentId
        ? deriveIndexFromPaymentId(paymentId)
        : Math.floor(Math.random() * 2147483647);
      address = deriveAddressFromMnemonic(walletConfig.value, index);
    } else {
      const account = privateKeyToAccount(walletConfig.value);
      address = account.address;
    }

    const expiresAt = new Date(Date.now() + PAYMENT_EXPIRATION_MS);

    logger.info("[CDP Wallet] Payment address created", {
      address,
      network,
      expiresAt,
    });

    return {
      address,
      network,
      expiresAt,
    };
  }

  async getUsdcBalance(
    address: string,
    network: CdpNetwork = getDefaultNetwork(),
  ): Promise<{
    balance: string;
    rawBalance: bigint;
    decimals: number;
  }> {
    const networkConfig = NETWORK_CONFIGS[network];

    const publicClient = createPublicClient({
      chain: networkConfig.chain,
      transport: http(networkConfig.rpcUrl),
    });

    const [rawBalance, decimals] = await Promise.all([
      publicClient.readContract({
        address: networkConfig.usdcAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address as Address],
      }),
      publicClient.readContract({
        address: networkConfig.usdcAddress,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
    ]);

    const balance = formatUnits(rawBalance, decimals);

    return {
      balance,
      rawBalance,
      decimals,
    };
  }

  async checkForPayment(
    paymentAddress: string,
    expectedAmount: number,
    network: CdpNetwork = getDefaultNetwork(),
  ): Promise<{
    received: boolean;
    amount: string;
    transactionHash?: string;
    blockNumber?: string;
  }> {
    const networkConfig = NETWORK_CONFIGS[network];

    const publicClient = createPublicClient({
      chain: networkConfig.chain,
      transport: http(networkConfig.rpcUrl),
    });

    const { balance } = await this.getUsdcBalance(paymentAddress, network);

    const receivedAmount = new Decimal(balance);
    const expectedDecimal = new Decimal(expectedAmount);
    const toleranceMultiplier = new Decimal(1).minus(
      new Decimal(networkConfig.tolerancePercent).dividedBy(100),
    );
    const threshold = expectedDecimal.times(toleranceMultiplier);

    if (receivedAmount.greaterThanOrEqualTo(threshold)) {
      try {
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock > 10000n ? currentBlock - 10000n : 0n;

        const logs = await publicClient.getLogs({
          address: networkConfig.usdcAddress,
          event: {
            type: "event",
            name: "Transfer",
            inputs: [
              { type: "address", name: "from", indexed: true },
              { type: "address", name: "to", indexed: true },
              { type: "uint256", name: "value", indexed: false },
            ],
          },
          args: {
            to: paymentAddress as Address,
          },
          fromBlock,
          toBlock: "latest",
        });

        const latestTransfer = logs[logs.length - 1];

        return {
          received: true,
          amount: balance,
          transactionHash: latestTransfer?.transactionHash,
          blockNumber: latestTransfer?.blockNumber?.toString(),
        };
      } catch (error) {
        logger.warn("[CDP Wallet] Failed to fetch transfer logs", { error });
        return {
          received: true,
          amount: balance,
        };
      }
    }

    return {
      received: false,
      amount: balance,
    };
  }

  async verifyTransaction(
    txHash: string,
    expectedAddress: string,
    expectedAmount: number,
    network: CdpNetwork = getDefaultNetwork(),
  ): Promise<{
    verified: boolean;
    amount?: string;
    blockNumber?: string;
    confirmations?: number;
    meetsMinimumConfirmations: boolean;
  }> {
    const networkConfig = NETWORK_CONFIGS[network];

    const publicClient = createPublicClient({
      chain: networkConfig.chain,
      transport: http(networkConfig.rpcUrl),
    });

    try {
      const receipt = await publicClient.getTransactionReceipt({
        hash: txHash as `0x${string}`,
      });

      if (receipt.status !== "success") {
        return { verified: false, meetsMinimumConfirmations: false };
      }

      const logs = receipt.logs.filter(
        (log) =>
          log.address.toLowerCase() === networkConfig.usdcAddress.toLowerCase(),
      );

      for (const log of logs) {
        if (
          log.topics[0] ===
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
        ) {
          const toAddress = `0x${log.topics[2]?.slice(26)}`;
          if (toAddress.toLowerCase() === expectedAddress.toLowerCase()) {
            const amount = BigInt(log.data);
            const decimals = 6;
            const amountFormatted = formatUnits(amount, decimals);

            const receivedDecimal = new Decimal(amountFormatted);
            const expectedDecimal = new Decimal(expectedAmount);
            const toleranceMultiplier = new Decimal(1).minus(
              new Decimal(networkConfig.tolerancePercent).dividedBy(100),
            );
            const threshold = expectedDecimal.times(toleranceMultiplier);

            if (receivedDecimal.greaterThanOrEqualTo(threshold)) {
              const currentBlock = await publicClient.getBlockNumber();
              const confirmations = Number(currentBlock - receipt.blockNumber);
              const meetsMinimumConfirmations =
                confirmations >= networkConfig.minimumConfirmations;

              logger.info("[CDP Wallet] Transaction verification", {
                txHash,
                confirmations,
                minimumRequired: networkConfig.minimumConfirmations,
                meetsMinimum: meetsMinimumConfirmations,
              });

              return {
                verified: true,
                amount: amountFormatted,
                blockNumber: receipt.blockNumber.toString(),
                confirmations,
                meetsMinimumConfirmations,
              };
            }
          }
        }
      }

      return { verified: false, meetsMinimumConfirmations: false };
    } catch (error) {
      logger.error("[CDP Wallet] Transaction verification failed", {
        txHash,
        error,
      });
      return { verified: false, meetsMinimumConfirmations: false };
    }
  }

  getNetworkConfig(network: CdpNetwork): NetworkConfig {
    return NETWORK_CONFIGS[network];
  }

  getSupportedNetworks(): CdpNetwork[] {
    return Object.keys(NETWORK_CONFIGS) as CdpNetwork[];
  }
}

export const cdpWalletService = new CdpWalletService();
