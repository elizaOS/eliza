/**
 * NFT holder verification for whitelist eligibility.
 *
 * Checks on-chain Milady NFT ownership (ERC-721 balanceOf) to determine
 * whitelist eligibility. Verified addresses are stored in the same
 * whitelist.json used by twitter-verify.ts, so both paths feed the
 * same Merkle tree for on-chain whitelist proofs.
 *
 * OG Milady Maker: 0x5Af0D9827E0c53E4799BB226655A1de152A425a5 (Ethereum mainnet)
 *
 * @see twitter-verify.ts — parallel verificatio path via Twitter
 * @see drop-service.ts  — mintWithWhitelist() consumer
 */

import { logger } from "@elizaos/core";
import { ethers } from "ethers";
import { isAddressWhitelisted, markAddressVerified } from "./twitter-verify";

// ── Constants ────────────────────────────────────────────────────────────

/** OG Milady Maker contract on Ethereum mainnet. */
const MILADY_CONTRACT = "0x5Af0D9827E0c53E4799BB226655A1de152A425a5";

/** Minimal ERC-721 ABI — only what we need. */
const ERC721_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
] as const;

/** Default public Ethereum RPC endpoints (fallback chain). */
const DEFAULT_RPC_ENDPOINTS = [
  "https://cloudflare-eth.com",
  "https://eth.llamarpc.com",
  "https://rpc.ankr.com/eth",
];

/** Timeout for RPC calls (ms). */
const RPC_TIMEOUT_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────────────

export interface NftVerificationResult {
  verified: boolean;
  balance: number;
  contractAddress: string;
  error: string | null;
}

// ── Provider ─────────────────────────────────────────────────────────────

/**
 * Get an Ethereum JSON-RPC provider.
 * Prefers ETHEREUM_RPC_URL env var, falls back to public endpoints.
 */
function getProvider(): ethers.JsonRpcProvider {
  const customRpc = process.env.ETHEREUM_RPC_URL?.trim();
  const rpcUrl = customRpc || DEFAULT_RPC_ENDPOINTS[0];

  return new ethers.JsonRpcProvider(rpcUrl, 1, {
    staticNetwork: true,
  });
}

// ── Core Verification ────────────────────────────────────────────────────

/**
 * Check if a wallet address holds at least one Milady NFT.
 *
 * Makes a single `balanceOf()` call to the Milady contract on Ethereum
 * mainnet. This is a read-only view call — no gas, no signing required.
 */
export async function verifyMiladyHolder(
  walletAddress: string,
): Promise<NftVerificationResult> {
  const contractAddress =
    process.env.MILADY_NFT_CONTRACT?.trim() || MILADY_CONTRACT;

  // ── Input validation ───────────────────────────────────────────────
  if (!walletAddress || typeof walletAddress !== "string") {
    return {
      verified: false,
      balance: 0,
      contractAddress,
      error: "Wallet address is required.",
    };
  }

  if (!ethers.isAddress(walletAddress)) {
    return {
      verified: false,
      balance: 0,
      contractAddress,
      error: "Invalid Ethereum address format.",
    };
  }

  // ── On-chain balance check ─────────────────────────────────────────
  const provider = getProvider();

  try {
    const contract = new ethers.Contract(
      contractAddress,
      ERC721_BALANCE_ABI,
      provider,
    );

    const balanceBN = (await Promise.race([
      contract.balanceOf(walletAddress),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("RPC request timed out")),
          RPC_TIMEOUT_MS,
        ),
      ),
    ])) as bigint;

    const balance = Number(balanceBN);

    if (balance > 0) {
      logger.info(
        `[nft-verify] Address ${walletAddress} holds ${balance} Milady NFT(s) — verified ✓`,
      );
      return { verified: true, balance, contractAddress, error: null };
    }

    logger.info(
      `[nft-verify] Address ${walletAddress} holds 0 Milady NFTs — not eligible`,
    );
    return {
      verified: false,
      balance: 0,
      contractAddress,
      error: "Wallet does not hold any Milady NFTs.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown RPC error";
    logger.warn(`[nft-verify] Balance check failed: ${message}`);
    return {
      verified: false,
      balance: 0,
      contractAddress,
      error: `NFT verification failed: ${message}`,
    };
  } finally {
    provider.destroy();
  }
}

// ── Whitelist Integration ────────────────────────────────────────────────

/**
 * Verify NFT ownership and add to whitelist if eligible.
 *
 * This is the main entry point called by the API route. It performs the
 * on-chain check and, if successful, writes the address into whitelist.json
 * alongside any Twitter-verified addresses.
 */
export async function verifyAndWhitelistHolder(
  walletAddress: string,
): Promise<NftVerificationResult> {
  // Skip the on-chain call if already whitelisted
  if (isAddressWhitelisted(walletAddress)) {
    logger.info(
      `[nft-verify] Address ${walletAddress} already whitelisted — skipping RPC call`,
    );
    return {
      verified: true,
      balance: -1, // -1 indicates "already verified, balance not re-checked"
      contractAddress:
        process.env.MILADY_NFT_CONTRACT?.trim() || MILADY_CONTRACT,
      error: null,
    };
  }

  const result = await verifyMiladyHolder(walletAddress);

  if (result.verified) {
    markAddressVerified(
      walletAddress,
      `nft:milady:${result.contractAddress}`,
      `milady-holder:${result.balance}`,
    );
    logger.info(
      `[nft-verify] Address ${walletAddress} added to whitelist via NFT verification`,
    );
  }

  return result;
}
