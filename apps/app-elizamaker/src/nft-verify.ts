import { logger } from "@elizaos/core";
import { ethers } from "ethers";
import { isAddressWhitelisted, markAddressVerified } from "./twitter-verify.js";

const ELIZA_NFT_CONTRACT_ADDRESS = "0x5Af0D9827E0c53E4799BB226655A1de152A425a5";
const ELIZA_NFT_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];
const DEFAULT_RPC_URL = "https://mainnet.base.org";

export interface NftVerificationResult {
  verified: boolean;
  balance: number;
  contractAddress: string;
  error: string | null;
  handle: string | null;
}

export async function verifyElizaHolder(
  walletAddress: string,
  options?: { rpcUrl?: string },
): Promise<NftVerificationResult> {
  const trimmedAddress = walletAddress.trim();
  if (!trimmedAddress) {
    return {
      verified: false,
      balance: 0,
      contractAddress: ELIZA_NFT_CONTRACT_ADDRESS,
      error: "Ethereum address is required.",
      handle: null,
    };
  }

  if (!ethers.isAddress(trimmedAddress)) {
    return {
      verified: false,
      balance: 0,
      contractAddress: ELIZA_NFT_CONTRACT_ADDRESS,
      error: "Invalid Ethereum address.",
      handle: null,
    };
  }

  const provider = new ethers.JsonRpcProvider(
    options?.rpcUrl ?? process.env.ELIZA_NFT_RPC_URL ?? DEFAULT_RPC_URL,
  );
  const contract = new ethers.Contract(
    ELIZA_NFT_CONTRACT_ADDRESS,
    ELIZA_NFT_ABI,
    provider,
  );

  try {
    const balance = Number(await contract.balanceOf(trimmedAddress));
    if (balance > 0) {
      return {
        verified: true,
        balance,
        contractAddress: ELIZA_NFT_CONTRACT_ADDRESS,
        error: null,
        handle: null,
      };
    }

    return {
      verified: false,
      balance,
      contractAddress: ELIZA_NFT_CONTRACT_ADDRESS,
      error: "Wallet does not hold an Eliza NFT.",
      handle: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[nft-verify] Failed to verify holder status: ${message}`);
    return {
      verified: false,
      balance: 0,
      contractAddress: ELIZA_NFT_CONTRACT_ADDRESS,
      error: message,
      handle: null,
    };
  } finally {
    provider.destroy();
  }
}

export async function verifyAndWhitelistHolder(
  walletAddress: string,
  options?: { rpcUrl?: string },
): Promise<NftVerificationResult> {
  if (isAddressWhitelisted(walletAddress)) {
    return {
      verified: true,
      balance: -1,
      contractAddress: ELIZA_NFT_CONTRACT_ADDRESS,
      error: null,
      handle: null,
    };
  }

  const result = await verifyElizaHolder(walletAddress, options);
  if (result.verified) {
    markAddressVerified(
      walletAddress,
      `nft:eliza:${ELIZA_NFT_CONTRACT_ADDRESS}`,
      `eliza-holder:${result.balance}`,
    );
  }
  return result;
}

export { ELIZA_NFT_CONTRACT_ADDRESS };
