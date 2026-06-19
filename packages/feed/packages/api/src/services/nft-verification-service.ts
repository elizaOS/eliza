import {
  base,
  baseSepolia,
  getCurrentChainId,
  getCurrentRpcUrl,
  hardhat,
  logger,
  mainnet,
  sepolia,
  ValidationError,
} from "@feed/shared";
import type { Address, PublicClient } from "viem";
import {
  type Chain,
  createPublicClient,
  http,
  isAddress,
  parseAbi,
} from "viem";
import {
  CACHE_KEYS,
  DEFAULT_TTLS,
  getCacheOrFetch,
  invalidateCache,
  invalidateCachePattern,
} from "../cache/cache-service";

const ERC721_ABI = [
  "function balanceOf(address owner) external view returns (uint256)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
] as const;

const CHAIN_CONFIG: Record<number, { chain: Chain; rpcUrl: string }> = {
  [hardhat.id]: {
    chain: hardhat,
    rpcUrl: "http://localhost:8545",
  },
  [base.id]: {
    chain: base,
    rpcUrl: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
  },
  [baseSepolia.id]: {
    chain: baseSepolia,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  },
  [mainnet.id]: {
    chain: mainnet,
    rpcUrl:
      process.env.ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com",
  },
  [sepolia.id]: {
    chain: sepolia,
    rpcUrl:
      process.env.ETHEREUM_SEPOLIA_RPC_URL ||
      "https://ethereum-sepolia-rpc.publicnode.com",
  },
};

function getChainConfig(chainId: number) {
  return (
    CHAIN_CONFIG[chainId] || {
      chain: baseSepolia,
      rpcUrl: getCurrentRpcUrl(),
    }
  );
}

export class NFTVerificationService {
  private static async getContractCodeOrThrow(
    // biome-ignore lint/suspicious/noExplicitAny: viem chain-parameterized PublicClient types are incompatible across chains
    publicClient: PublicClient<any, any>,
    contractAddress: string,
    normalizedContract: Address,
    chainId: number,
  ): Promise<`0x${string}`> {
    try {
      const contractCode = await publicClient.getCode({
        address: normalizedContract,
      });

      if (!contractCode || contractCode === "0x") {
        logger.warn(
          "No contract code found at address",
          {
            contractAddress: normalizedContract,
            chainId,
          },
          "NFTVerificationService",
        );
        throw new ValidationError(
          `No contract at ${contractAddress}`,
          ["contractAddress"],
          [{ field: "contractAddress", message: "No contract code found" }],
        );
      }

      return contractCode;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }

      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        "Contract code lookup failed",
        {
          contractAddress: normalizedContract,
          chainId,
          error: msg,
        },
        "NFTVerificationService",
      );
      throw new ValidationError(
        `No contract at ${contractAddress}`,
        ["contractAddress"],
        [{ field: "contractAddress", message: "No contract code found" }],
      );
    }
  }

  static async verifyOwnership(
    walletAddress: string,
    contractAddress: string,
    tokenId: number | null,
    chainId?: number,
  ): Promise<boolean> {
    if (!isAddress(walletAddress)) {
      throw new ValidationError(
        `Invalid wallet address: ${walletAddress}`,
        ["walletAddress"],
        [{ field: "walletAddress", message: "Invalid Ethereum address" }],
      );
    }

    if (!isAddress(contractAddress)) {
      throw new ValidationError(
        `Invalid contract address: ${contractAddress}`,
        ["contractAddress"],
        [{ field: "contractAddress", message: "Invalid Ethereum address" }],
      );
    }

    if (tokenId !== null && (tokenId < 0 || !Number.isInteger(tokenId))) {
      throw new ValidationError(
        `Invalid token ID: ${tokenId}`,
        ["tokenId"],
        [{ field: "tokenId", message: "Must be non-negative integer" }],
      );
    }

    const targetChainId = chainId ?? getCurrentChainId();
    const normalizedWallet = walletAddress.toLowerCase() as Address;
    const normalizedContract = contractAddress.toLowerCase() as Address;
    const cacheKey = `ownership:${targetChainId}:${normalizedContract}:${normalizedWallet}:${tokenId ?? "any"}`;

    return getCacheOrFetch(
      cacheKey,
      async () => {
        const { chain, rpcUrl } = getChainConfig(targetChainId);
        const publicClient = createPublicClient({
          chain,
          transport: http(rpcUrl, { timeout: 10000 }),
        });

        await NFTVerificationService.getContractCodeOrThrow(
          publicClient,
          contractAddress,
          normalizedContract,
          targetChainId,
        );

        if (tokenId === null) {
          try {
            const balance = await publicClient.readContract({
              address: normalizedContract,
              abi: parseAbi(ERC721_ABI),
              functionName: "balanceOf",
              args: [normalizedWallet],
            });
            return (balance as bigint) > 0n;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(
              "balanceOf call failed",
              {
                walletAddress: normalizedWallet,
                contractAddress: normalizedContract,
                chainId: targetChainId,
                error: msg,
              },
              "NFTVerificationService",
            );
            throw new ValidationError(
              `Not an ERC721 contract: ${msg}`,
              ["contractAddress"],
              [{ field: "contractAddress", message: "Not ERC721" }],
            );
          }
        }

        try {
          const owner = await publicClient.readContract({
            address: normalizedContract,
            abi: parseAbi(ERC721_ABI),
            functionName: "ownerOf",
            args: [BigInt(tokenId)],
          });
          return (owner as Address).toLowerCase() === normalizedWallet;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(
            "ownerOf call failed",
            {
              walletAddress: normalizedWallet,
              contractAddress: normalizedContract,
              tokenId,
              chainId: targetChainId,
              error: msg,
            },
            "NFTVerificationService",
          );
          throw new ValidationError(
            `Token ${tokenId} not found: ${msg}`,
            ["contractAddress", "tokenId"],
            [{ field: "contractAddress", message: "Token not found" }],
          );
        }
      },
      {
        namespace: CACHE_KEYS.NFT_OWNERSHIP,
        ttl: DEFAULT_TTLS.NFT_OWNERSHIP,
      },
    );
  }

  static async getUserTokenIds(
    walletAddress: string,
    contractAddress: string,
    chainId?: number,
  ): Promise<number[]> {
    if (!isAddress(walletAddress)) {
      throw new ValidationError(
        `Invalid wallet address: ${walletAddress}`,
        ["walletAddress"],
        [{ field: "walletAddress", message: "Invalid Ethereum address" }],
      );
    }

    if (!isAddress(contractAddress)) {
      throw new ValidationError(
        `Invalid contract address: ${contractAddress}`,
        ["contractAddress"],
        [{ field: "contractAddress", message: "Invalid Ethereum address" }],
      );
    }

    const targetChainId = chainId ?? getCurrentChainId();
    const normalizedWallet = walletAddress.toLowerCase() as Address;
    const normalizedContract = contractAddress.toLowerCase() as Address;
    const cacheKey = `tokens:${targetChainId}:${normalizedContract}:${normalizedWallet}`;

    return getCacheOrFetch(
      cacheKey,
      async () => {
        const { chain, rpcUrl } = getChainConfig(targetChainId);
        const publicClient = createPublicClient({
          chain,
          transport: http(rpcUrl, { timeout: 10000 }),
        });

        await NFTVerificationService.getContractCodeOrThrow(
          publicClient,
          contractAddress,
          normalizedContract,
          targetChainId,
        );

        let balance: bigint;
        try {
          balance = await publicClient.readContract({
            address: normalizedContract,
            abi: parseAbi(ERC721_ABI),
            functionName: "balanceOf",
            args: [normalizedWallet],
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(
            "balanceOf call failed for enumeration",
            {
              walletAddress: normalizedWallet,
              contractAddress: normalizedContract,
              chainId: targetChainId,
              error: msg,
            },
            "NFTVerificationService",
          );
          throw new ValidationError(
            `Not ERC721: ${msg}`,
            ["contractAddress"],
            [{ field: "contractAddress", message: "Not ERC721" }],
          );
        }

        if (balance === 0n) return [];

        const ENUMERABLE_ABI = [
          ...ERC721_ABI,
          "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
        ] as const;

        const tokenIds: number[] = [];
        for (let i = 0; i < Number(balance); i++) {
          try {
            const tokenId = await publicClient.readContract({
              address: normalizedContract,
              abi: parseAbi(ENUMERABLE_ABI),
              functionName: "tokenOfOwnerByIndex",
              args: [normalizedWallet, BigInt(i)],
            });
            tokenIds.push(Number(tokenId));
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(
              "tokenOfOwnerByIndex call failed",
              {
                walletAddress: normalizedWallet,
                contractAddress: normalizedContract,
                chainId: targetChainId,
                index: i,
                error: msg,
              },
              "NFTVerificationService",
            );
            throw new ValidationError(
              `No ERC721Enumerable support: ${msg}`,
              ["contractAddress"],
              [{ field: "contractAddress", message: "No enumeration" }],
            );
          }
        }

        return tokenIds;
      },
      {
        namespace: CACHE_KEYS.NFT_OWNERSHIP,
        ttl: DEFAULT_TTLS.NFT_OWNERSHIP,
      },
    );
  }

  static async verifyChatAccess(
    walletAddress: string | null,
    contractAddress: string,
    tokenId: number | null,
    chainId?: number,
  ): Promise<{
    canAccess: boolean;
    reason?: string;
    ownsNft: boolean;
  }> {
    if (!walletAddress?.trim()) {
      return {
        canAccess: false,
        reason: "Wallet address required",
        ownsNft: false,
      };
    }

    try {
      const ownsNft = await NFTVerificationService.verifyOwnership(
        walletAddress,
        contractAddress,
        tokenId,
        chainId,
      );

      if (!ownsNft) {
        const requirement =
          tokenId !== null ? ` token #${tokenId}` : " from this collection";
        return {
          canAccess: false,
          reason: `Must own NFT${requirement}`,
          ownsNft: false,
        };
      }

      return { canAccess: true, ownsNft: true };
    } catch (error) {
      if (error instanceof ValidationError) {
        return {
          canAccess: false,
          reason: error.message,
          ownsNft: false,
        };
      }
      throw error;
    }
  }

  static async invalidateOwnershipCache(
    walletAddress: string,
    contractAddress: string,
    chainId?: number,
  ): Promise<void> {
    const targetChainId = chainId ?? getCurrentChainId();
    const normalizedWallet = walletAddress.toLowerCase() as Address;
    const normalizedContract = contractAddress.toLowerCase() as Address;

    const ownershipPattern = `ownership:${targetChainId}:${normalizedContract}:${normalizedWallet}:*`;
    const tokensPattern = `tokens:${targetChainId}:${normalizedContract}:${normalizedWallet}`;

    await Promise.all([
      invalidateCachePattern(ownershipPattern, {
        namespace: CACHE_KEYS.NFT_OWNERSHIP,
      }),
      invalidateCache(tokensPattern, {
        namespace: CACHE_KEYS.NFT_OWNERSHIP,
      }),
    ]);

    logger.debug(
      "NFT ownership cache invalidated",
      {
        walletAddress: normalizedWallet,
        contractAddress: normalizedContract,
        chainId: targetChainId,
      },
      "NFTVerificationService",
    );
  }
}
