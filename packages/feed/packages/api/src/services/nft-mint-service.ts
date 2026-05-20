/**
 * NFT Mint Service
 *
 * Handles the complete mint flow for ProtoMonkeys NFTs:
 * 1. Check eligibility from nftSnapshot table
 * 2. Generate ECDSA signatures for eligible users
 * 3. Verify on-chain transactions and extract minted token IDs
 * 4. Update database with ownership records
 *
 * @module api/services/nft-mint-service
 */

import { randomBytes } from 'node:crypto';
import {
  and,
  db,
  eq,
  nftClaims,
  nftCollection,
  nftOwnership,
  nftSnapshot,
} from '@babylon/db';
import {
  hardhat,
  logger,
  mainnet,
  sepolia,
  ValidationError,
} from '@babylon/shared';
import { nanoid } from 'nanoid';
import {
  type Address,
  type Chain,
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  type Hex,
  http,
  isAddress,
  keccak256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getNftChainId } from './nft/nft-chain';

// ============================================================================
// Types
// ============================================================================

/**
 * Status of user's NFT mint eligibility
 */
export type EligibilityStatus =
  | 'not_authenticated'
  | 'not_eligible'
  | 'eligible'
  | 'already_minted';

/**
 * Result of eligibility check
 */
export interface EligibilityResult {
  eligible: boolean;
  status: EligibilityStatus;
  snapshotRank?: number;
  snapshotPoints?: number;
  snapshotTakenAt?: Date;
  hasMinted: boolean;
  mintedNft?: {
    tokenId: number;
    name: string;
    thumbnailUrl: string;
    txHash: string;
  };
  reason?: string;
}

/**
 * Result of mint preparation (signature generation)
 */
export interface PrepareResult {
  contractAddress: Hex;
  chainId: number;
  to: Hex;
  deadline: number;
  nonce: Hex;
  signature: Hex;
  encodedData: Hex;
}

/**
 * Result of mint confirmation
 */
export interface ConfirmResult {
  success: boolean;
  tokenId: number;
  nft: {
    tokenId: number;
    name: string;
    imageUrl: string;
    thumbnailUrl: string | null;
    storyTitle: string | null;
  };
}

// ============================================================================
// Configuration
// ============================================================================

const CHAIN_CONFIG: Record<number, { chain: Chain; rpcUrl: string }> = {
  [hardhat.id]: {
    chain: hardhat,
    rpcUrl: 'http://localhost:8545',
  },
  [mainnet.id]: {
    chain: mainnet,
    rpcUrl: process.env.ETH_MAINNET_RPC_URL ?? 'https://eth.llamarpc.com',
  },
  [sepolia.id]: {
    chain: sepolia,
    rpcUrl: process.env.ETH_SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org',
  },
};

/**
 * ProtoMonkeysNFT mint function ABI
 */
const PROTO_MONKEYS_MINT_ABI = [
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

/**
 * ProtoMonkeysNFT hasMinted view ABI (read-only check per wallet)
 */
const HAS_MINTED_ABI = [
  {
    name: 'hasMinted',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * ERC-721 Transfer event signature
 */
const TRANSFER_EVENT_SIGNATURE =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

/**
 * Maximum token ID in the ProtoMonkeys collection.
 */
const MAX_TOKEN_ID = 100;

/**
 * Contract deployment block for log queries.
 * Using a known deployment block avoids `fromBlock: 'earliest'` which many
 * RPC providers reject for large block ranges on mainnet.
 * Override with `NFT_CONTRACT_DEPLOY_BLOCK` env var if redeployed.
 */
function getContractDeployBlock(): bigint {
  const envBlock = process.env.NFT_CONTRACT_DEPLOY_BLOCK;
  if (envBlock) return BigInt(envBlock);
  // Default: 0n (safe for hardhat/sepolia; set env var for mainnet)
  return 0n;
}

// ============================================================================
// Helper Functions
// ============================================================================

// PrivyUserWalletsLite is imported from ./privy/user-wallets

function getChainConfig(chainId: number) {
  const config = CHAIN_CONFIG[chainId];
  if (!config) {
    throw new ValidationError(
      `Unsupported chain ID: ${chainId}`,
      ['chainId'],
      [{ field: 'chainId', message: `Chain ${chainId} not supported` }]
    );
  }
  return config;
}

function getPublicClient(chainId: number) {
  const { chain, rpcUrl } = getChainConfig(chainId);
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 30000 }),
  });
}

function getConfig() {
  const contractAddress = process.env.NFT_CONTRACT_ADDRESS as Hex | undefined;
  const chainId = getNftChainId();
  const signerPrivateKey = process.env.NFT_SIGNER_PRIVATE_KEY as
    | Hex
    | undefined;

  return { contractAddress, chainId, signerPrivateKey };
}

function validateConfig(): {
  contractAddress: Hex;
  chainId: number;
  signerPrivateKey: Hex;
} {
  const { contractAddress, chainId, signerPrivateKey } = getConfig();

  if (!contractAddress || !isAddress(contractAddress)) {
    throw new ValidationError(
      'NFT contract not configured',
      ['contractAddress'],
      [{ field: 'contractAddress', message: 'NFT_CONTRACT_ADDRESS not set' }]
    );
  }

  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new ValidationError(
      'NFT chain not configured',
      ['chainId'],
      [
        {
          field: 'chainId',
          message:
            'Chain ID not configured. Set NEXT_PUBLIC_CHAIN_ID (or CHAIN_ID) to the chain where the NFT contract is deployed.',
        },
      ]
    );
  }

  // Validate private key: must be 0x + 64 hex characters (66 total)
  const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;
  if (!signerPrivateKey || !PRIVATE_KEY_REGEX.test(signerPrivateKey)) {
    throw new ValidationError(
      'NFT signer not configured',
      ['signerPrivateKey'],
      [
        {
          field: 'signerPrivateKey',
          message: 'NFT_SIGNER_PRIVATE_KEY must be valid 66-char hex key',
        },
      ]
    );
  }

  return { contractAddress, chainId, signerPrivateKey };
}

async function resolveUserEmbeddedWalletAddress(
  _userId: string
): Promise<Address> {
  // Phase 2: Privy embedded wallets removed. NFT minting is currently disabled.
  // This path should not be reached (NFT feature flag prevents it).
  throw new ValidationError(
    'NFT minting unavailable',
    ['wallet'],
    [
      {
        field: 'wallet',
        message: 'NFT minting is not available in this version.',
      },
    ]
  );
}

/**
 * Check whether a wallet has already minted on the ProtoMonkeys contract.
 */
async function checkHasMintedOnChain(
  walletAddress: Address,
  contractAddress: Address,
  chainId: number
): Promise<boolean> {
  const client = getPublicClient(chainId);
  return client.readContract({
    address: contractAddress,
    abi: HAS_MINTED_ABI,
    functionName: 'hasMinted',
    args: [walletAddress],
  }) as Promise<boolean>;
}

/**
 * Reconcile a single user's on-chain mint into the database.
 *
 * Called when on-chain `hasMinted(wallet)` is true but the DB has `hasMinted = false`.
 * Discovers the minted tokenId via Transfer event logs from the RPC and upserts
 * NftSnapshot, NftOwnership, and NftClaims.
 *
 * @param userId     - The user's database ID
 * @param walletAddress - The Privy embedded wallet that received the NFT
 * @param contractAddress - The NFT contract address
 * @param chainId    - The chain the contract is deployed on
 */
export async function reconcileOnChainMint(
  userId: string,
  walletAddress: Address,
  contractAddress: Address,
  chainId: number
): Promise<void> {
  const client = getPublicClient(chainId);
  const normalizedWallet = walletAddress.toLowerCase() as Address;

  // Find the Transfer(from=0x0, to=wallet) event on the contract
  const logs = await client.getLogs({
    address: contractAddress,
    event: {
      type: 'event',
      name: 'Transfer',
      inputs: [
        { type: 'address', name: 'from', indexed: true },
        { type: 'address', name: 'to', indexed: true },
        { type: 'uint256', name: 'tokenId', indexed: true },
      ],
    },
    args: {
      from: '0x0000000000000000000000000000000000000000' as Address,
      to: walletAddress,
    },
    fromBlock: getContractDeployBlock(),
    toBlock: 'latest',
  });

  if (logs.length === 0) {
    logger.warn(
      'reconcileOnChainMint: no Transfer(0x0 -> wallet) found',
      { userId, walletAddress, contractAddress },
      'NFTMintService'
    );
    return;
  }

  // Use the first (should be only) mint event
  const mintLog = logs[0]!;
  const mintedTokenId = Number(mintLog.args.tokenId);

  if (mintedTokenId < 1 || mintedTokenId > MAX_TOKEN_ID) {
    logger.warn(
      'reconcileOnChainMint: tokenId out of range',
      { userId, walletAddress, mintedTokenId },
      'NFTMintService'
    );
    return;
  }

  const txHash = mintLog.transactionHash as Hex;
  const blockNumber = mintLog.blockNumber;
  const now = new Date();

  await db.transaction(async (tx) => {
    // 1. Update NftSnapshot
    await tx
      .update(nftSnapshot)
      .set({
        hasMinted: true,
        mintedTokenId,
        mintedAt: now,
        mintTxHash: txHash,
      })
      .where(
        and(eq(nftSnapshot.userId, userId), eq(nftSnapshot.hasMinted, false))
      );

    // 2. Upsert NftOwnership (replace stale record if one exists for this tokenId)
    const [existingOwnership] = await tx
      .select({ id: nftOwnership.id })
      .from(nftOwnership)
      .where(eq(nftOwnership.tokenId, mintedTokenId))
      .limit(1);

    if (existingOwnership) {
      await tx
        .update(nftOwnership)
        .set({
          ownerAddress: normalizedWallet,
          userId,
          acquiredAt: now,
          txHash,
          blockNumber,
          updatedAt: now,
        })
        .where(eq(nftOwnership.tokenId, mintedTokenId));
    } else {
      await tx.insert(nftOwnership).values({
        id: nanoid(),
        tokenId: mintedTokenId,
        ownerAddress: normalizedWallet,
        userId,
        acquiredAt: now,
        txHash,
        blockNumber,
        updatedAt: now,
      });
    }

    // 3. Upsert NftClaim (replace stale record if one exists for this tokenId)
    const [snapshotEntry] = await tx
      .select({ rank: nftSnapshot.rank, points: nftSnapshot.points })
      .from(nftSnapshot)
      .where(eq(nftSnapshot.userId, userId))
      .limit(1);

    const [existingClaim] = await tx
      .select({ id: nftClaims.id })
      .from(nftClaims)
      .where(eq(nftClaims.tokenId, mintedTokenId))
      .limit(1);

    if (existingClaim) {
      await tx
        .update(nftClaims)
        .set({
          claimerUserId: userId,
          claimerAddress: normalizedWallet,
          claimedAt: now,
          txHash,
          snapshotRank: snapshotEntry?.rank ?? null,
          snapshotPoints: snapshotEntry?.points ?? null,
        })
        .where(eq(nftClaims.tokenId, mintedTokenId));
    } else {
      await tx.insert(nftClaims).values({
        id: nanoid(),
        tokenId: mintedTokenId,
        claimerUserId: userId,
        claimerAddress: normalizedWallet,
        claimedAt: now,
        txHash,
        snapshotRank: snapshotEntry?.rank ?? null,
        snapshotPoints: snapshotEntry?.points ?? null,
      });
    }
  });

  logger.info(
    'reconcileOnChainMint: reconciled desync',
    { userId, walletAddress, tokenId: mintedTokenId, txHash },
    'NFTMintService'
  );
}

/**
 * Generate a unique nonce for minting
 */
function generateNonce(): Hex {
  return `0x${randomBytes(32).toString('hex')}` as Hex;
}

/**
 * Create the message hash for signing
 * Must match the contract's expected format
 */
function createMessageHash(
  to: Address,
  deadline: number,
  nonce: Hex,
  chainId: number,
  contractAddress: Address
): Hex {
  return keccak256(
    encodePacked(
      ['address', 'uint256', 'bytes32', 'uint256', 'address'],
      [to, BigInt(deadline), nonce, BigInt(chainId), contractAddress]
    )
  );
}

/**
 * Encode the mint function call
 */
function encodeMintCall(
  to: Address,
  deadline: number,
  nonce: Hex,
  signature: Hex
): Hex {
  return encodeFunctionData({
    abi: PROTO_MONKEYS_MINT_ABI,
    functionName: 'mint',
    args: [to, BigInt(deadline), nonce, signature],
  });
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Check if a user is eligible to mint an NFT
 *
 * @param userId - The user's database ID
 * @returns Eligibility result with status and optional minted NFT info
 */
export async function checkEligibility(
  userId: string
): Promise<EligibilityResult> {
  // Get snapshot entry for this user
  const [snapshotEntry] = await db
    .select({
      id: nftSnapshot.id,
      userId: nftSnapshot.userId,
      walletAddress: nftSnapshot.walletAddress,
      rank: nftSnapshot.rank,
      points: nftSnapshot.points,
      snapshotTakenAt: nftSnapshot.snapshotTakenAt,
      hasMinted: nftSnapshot.hasMinted,
      mintedTokenId: nftSnapshot.mintedTokenId,
      mintTxHash: nftSnapshot.mintTxHash,
    })
    .from(nftSnapshot)
    .where(eq(nftSnapshot.userId, userId))
    .limit(1);

  if (!snapshotEntry) {
    return {
      eligible: false,
      status: 'not_eligible',
      hasMinted: false,
      reason: 'not_in_top_100',
    };
  }

  // Check if already minted (per DB)
  if (snapshotEntry.hasMinted && snapshotEntry.mintedTokenId !== null) {
    const [mintedNft] = await db
      .select({
        tokenId: nftCollection.tokenId,
        name: nftCollection.name,
        thumbnailUrl: nftCollection.thumbnailUrl,
        imageUrl: nftCollection.imageUrl,
      })
      .from(nftCollection)
      .where(eq(nftCollection.tokenId, snapshotEntry.mintedTokenId))
      .limit(1);

    return {
      eligible: true,
      status: 'already_minted',
      snapshotRank: snapshotEntry.rank,
      snapshotPoints: snapshotEntry.points,
      snapshotTakenAt: snapshotEntry.snapshotTakenAt,
      hasMinted: true,
      mintedNft: mintedNft
        ? {
            tokenId: mintedNft.tokenId,
            name: mintedNft.name,
            thumbnailUrl: mintedNft.thumbnailUrl ?? mintedNft.imageUrl,
            txHash: snapshotEntry.mintTxHash ?? '',
          }
        : undefined,
    };
  }

  // On-chain verification: DB says hasMinted=false, but check on-chain to catch desyncs.
  // Only do this if the user has a Privy embedded wallet configured.
  let onChainMintConfirmed = false;
  try {
    const { contractAddress, chainId } = getConfig();
    if (contractAddress && isAddress(contractAddress)) {
      // Phase 2: Privy embedded wallets removed. On-chain verification disabled.
      const hasEmbeddedWallet = false;

      if (hasEmbeddedWallet) {
        const embeddedWallet = await resolveUserEmbeddedWalletAddress(userId);
        const hasMintedOnChain = await checkHasMintedOnChain(
          embeddedWallet,
          contractAddress as Address,
          chainId
        );

        if (hasMintedOnChain) {
          // We now know for certain the user minted on-chain.
          // Even if reconciliation fails below, we must return 'already_minted'.
          onChainMintConfirmed = true;

          logger.warn(
            'checkEligibility: on-chain hasMinted=true but DB false — reconciling',
            { userId, embeddedWallet, contractAddress },
            'NFTMintService'
          );

          try {
            await reconcileOnChainMint(
              userId,
              embeddedWallet,
              contractAddress as Address,
              chainId
            );
          } catch (reconcileErr) {
            // Reconciliation failed (e.g. getLogs block-range error), but we still
            // know the user minted — don't fall through to 'eligible'.
            logger.warn(
              'checkEligibility: reconciliation failed, returning already_minted without NFT details',
              {
                userId,
                error:
                  reconcileErr instanceof Error
                    ? reconcileErr.message
                    : String(reconcileErr),
              },
              'NFTMintService'
            );
          }

          // Try to fetch reconciled data (may be stale if reconciliation failed)
          const [updated] = await db
            .select({
              mintedTokenId: nftSnapshot.mintedTokenId,
              mintTxHash: nftSnapshot.mintTxHash,
            })
            .from(nftSnapshot)
            .where(eq(nftSnapshot.userId, userId))
            .limit(1);

          let mintedNft: EligibilityResult['mintedNft'];
          if (updated?.mintedTokenId) {
            const [nftData] = await db
              .select({
                tokenId: nftCollection.tokenId,
                name: nftCollection.name,
                thumbnailUrl: nftCollection.thumbnailUrl,
                imageUrl: nftCollection.imageUrl,
              })
              .from(nftCollection)
              .where(eq(nftCollection.tokenId, updated.mintedTokenId))
              .limit(1);

            if (nftData) {
              mintedNft = {
                tokenId: nftData.tokenId,
                name: nftData.name,
                thumbnailUrl: nftData.thumbnailUrl ?? nftData.imageUrl,
                txHash: updated.mintTxHash ?? '',
              };
            }
          }

          return {
            eligible: true,
            status: 'already_minted',
            snapshotRank: snapshotEntry.rank,
            snapshotPoints: snapshotEntry.points,
            snapshotTakenAt: snapshotEntry.snapshotTakenAt,
            hasMinted: true,
            mintedNft,
          };
        }
      }
    }
  } catch (e) {
    // If we already confirmed on-chain mint, don't fall through to 'eligible'
    if (onChainMintConfirmed) {
      return {
        eligible: true,
        status: 'already_minted',
        snapshotRank: snapshotEntry.rank,
        snapshotPoints: snapshotEntry.points,
        snapshotTakenAt: snapshotEntry.snapshotTakenAt,
        hasMinted: true,
      };
    }
    // Don't block eligibility checks if on-chain verification fails
    logger.warn(
      'checkEligibility: on-chain hasMinted check failed, using DB state',
      { userId, error: e instanceof Error ? e.message : String(e) },
      'NFTMintService'
    );
  }

  return {
    eligible: true,
    status: 'eligible',
    snapshotRank: snapshotEntry.rank,
    snapshotPoints: snapshotEntry.points,
    snapshotTakenAt: snapshotEntry.snapshotTakenAt,
    hasMinted: false,
  };
}

/**
 * Prepare a mint transaction by generating a signature
 *
 * @param userId - The user's database ID
 * @returns Prepared transaction data with signature
 */
export async function prepareMint(userId: string): Promise<PrepareResult> {
  // Validate configuration
  const { contractAddress, chainId, signerPrivateKey } = validateConfig();

  // Check eligibility
  const eligibility = await checkEligibility(userId);
  if (!eligibility.eligible) {
    throw new ValidationError(
      'User not eligible to mint',
      ['userId'],
      [{ field: 'userId', message: eligibility.reason ?? 'Not eligible' }]
    );
  }
  if (eligibility.hasMinted) {
    throw new ValidationError(
      'User has already minted',
      ['userId'],
      [{ field: 'userId', message: 'Already minted' }]
    );
  }

  // Resolve user's embedded wallet address from Privy (multi-chain safe).
  // Note: the on-chain hasMinted check is handled by checkEligibility() above,
  // which will return already_minted and trigger reconciliation if needed.
  const walletAddress = await resolveUserEmbeddedWalletAddress(userId);

  // Generate nonce and deadline (1 hour from now)
  const nonce = generateNonce();
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  // Create signature
  const account = privateKeyToAccount(signerPrivateKey);
  const messageHash = createMessageHash(
    walletAddress,
    deadline,
    nonce,
    chainId,
    contractAddress
  );

  // Sign with eth_sign format (adds "\x19Ethereum Signed Message:\n32" prefix)
  const signature = await account.signMessage({
    message: { raw: messageHash },
  });

  // Encode the mint function call
  const encodedData = encodeMintCall(walletAddress, deadline, nonce, signature);

  logger.info(
    'Prepared mint transaction',
    {
      userId,
      walletAddress,
      deadline,
      chainId,
      contractAddress,
    },
    'NFTMintService'
  );

  return {
    contractAddress,
    chainId,
    to: walletAddress,
    deadline,
    nonce,
    signature,
    encodedData,
  };
}

/**
 * Confirm a mint transaction by verifying on-chain and updating database
 *
 * @param userId - The user's database ID
 * @param txHash - The transaction hash to verify
 * @param walletAddress - The wallet address that should own the NFT
 * @returns Confirmation result with minted NFT info
 */
export async function confirmMint(
  userId: string,
  txHash: Hex,
  walletAddress: Hex
): Promise<ConfirmResult> {
  // Validate inputs
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new ValidationError(
      'Invalid transaction hash',
      ['txHash'],
      [{ field: 'txHash', message: 'Must be 66 character hex string' }]
    );
  }

  if (!isAddress(walletAddress)) {
    throw new ValidationError(
      'Invalid wallet address',
      ['walletAddress'],
      [{ field: 'walletAddress', message: 'Invalid Ethereum address' }]
    );
  }

  const { contractAddress, chainId } = validateConfig();
  const normalizedWallet = walletAddress.toLowerCase() as Address;
  const normalizedContract = contractAddress.toLowerCase() as Address;

  // Verify wallet belongs to the authenticated user via Privy (do not rely on DB).
  const expectedEmbeddedWallet = await resolveUserEmbeddedWalletAddress(userId);
  if (expectedEmbeddedWallet.toLowerCase() !== normalizedWallet.toLowerCase()) {
    throw new ValidationError(
      'Wallet mismatch',
      ['walletAddress'],
      [
        {
          field: 'walletAddress',
          message: 'Wallet does not match authenticated user embedded wallet',
        },
      ]
    );
  }

  // Get transaction receipt from chain
  const client = getPublicClient(chainId);

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to get receipt';
    throw new ValidationError(
      `Transaction not found: ${message}`,
      ['txHash'],
      [{ field: 'txHash', message: 'Transaction not found on chain' }]
    );
  }

  if (receipt.status !== 'success') {
    throw new ValidationError(
      'Transaction failed',
      ['txHash'],
      [{ field: 'txHash', message: 'Transaction reverted' }]
    );
  }

  // Parse Transfer event: Transfer(from=0x0, to=walletAddress, tokenId)
  const ZERO_TOPIC =
    '0x0000000000000000000000000000000000000000000000000000000000000000';

  const mintLog = receipt.logs.find((log) => {
    const [sig, from, to, tokenId] = log.topics;
    if (log.address.toLowerCase() !== normalizedContract) return false;
    if (sig !== TRANSFER_EVENT_SIGNATURE) return false;
    if (from !== ZERO_TOPIC) return false; // Must be mint (from 0x0)
    if (!to || !tokenId) return false;
    // Extract address from topic (last 40 chars of 64 char hex)
    return `0x${to.slice(-40).toLowerCase()}` === normalizedWallet;
  });

  if (!mintLog?.topics[3]) {
    throw new ValidationError(
      'Mint event not found in transaction',
      ['txHash'],
      [{ field: 'txHash', message: 'No Transfer from 0x0 found for wallet' }]
    );
  }

  const mintedTokenId = Number(BigInt(mintLog.topics[3]));

  // Validate token ID is in valid range
  if (mintedTokenId < 1 || mintedTokenId > MAX_TOKEN_ID) {
    throw new ValidationError(
      `Invalid token ID: ${mintedTokenId}`,
      ['tokenId'],
      [{ field: 'tokenId', message: `Token ID out of range 1-${MAX_TOKEN_ID}` }]
    );
  }

  const now = new Date();

  // Update database in transaction
  const result = await db.transaction(async (tx) => {
    // Get snapshot entry
    const [snapshotEntry] = await tx
      .select({
        id: nftSnapshot.id,
        rank: nftSnapshot.rank,
        points: nftSnapshot.points,
        hasMinted: nftSnapshot.hasMinted,
      })
      .from(nftSnapshot)
      .where(eq(nftSnapshot.userId, userId))
      .limit(1);

    if (!snapshotEntry) {
      throw new ValidationError(
        'User not in snapshot',
        ['userId'],
        [{ field: 'userId', message: 'Not eligible' }]
      );
    }

    if (snapshotEntry.hasMinted) {
      throw new ValidationError(
        'Already minted',
        ['userId'],
        [{ field: 'userId', message: 'User already minted' }]
      );
    }

    // Check if this token ID is already claimed (shouldn't happen, but safety check)
    const [existingOwnership] = await tx
      .select({ id: nftOwnership.id })
      .from(nftOwnership)
      .where(eq(nftOwnership.tokenId, mintedTokenId))
      .limit(1);

    if (existingOwnership) {
      // Token already has owner in DB - this could be a transfer, update it
      await tx
        .update(nftOwnership)
        .set({
          ownerAddress: normalizedWallet,
          userId: userId,
          acquiredAt: now,
          txHash: txHash,
          blockNumber: receipt.blockNumber,
          updatedAt: now,
        })
        .where(eq(nftOwnership.tokenId, mintedTokenId));
    } else {
      // Insert new ownership record
      await tx.insert(nftOwnership).values({
        id: nanoid(),
        tokenId: mintedTokenId,
        ownerAddress: normalizedWallet,
        userId: userId,
        acquiredAt: now,
        txHash: txHash,
        blockNumber: receipt.blockNumber,
        updatedAt: now,
      });
    }

    // Insert claim record
    await tx.insert(nftClaims).values({
      id: nanoid(),
      tokenId: mintedTokenId,
      claimerUserId: userId,
      claimerAddress: normalizedWallet,
      claimedAt: now,
      txHash: txHash,
      snapshotRank: snapshotEntry.rank,
      snapshotPoints: snapshotEntry.points,
    });

    // Update snapshot
    await tx
      .update(nftSnapshot)
      .set({
        hasMinted: true,
        mintedTokenId: mintedTokenId,
        mintedAt: now,
        mintTxHash: txHash,
      })
      .where(eq(nftSnapshot.userId, userId));

    // Get NFT metadata
    const [nftData] = await tx
      .select({
        tokenId: nftCollection.tokenId,
        name: nftCollection.name,
        imageUrl: nftCollection.imageUrl,
        thumbnailUrl: nftCollection.thumbnailUrl,
        storyTitle: nftCollection.storyTitle,
      })
      .from(nftCollection)
      .where(eq(nftCollection.tokenId, mintedTokenId))
      .limit(1);

    return { snapshotEntry, nftData };
  });

  logger.info(
    'Confirmed mint transaction',
    {
      userId,
      txHash,
      tokenId: mintedTokenId,
      blockNumber: Number(receipt.blockNumber),
    },
    'NFTMintService'
  );

  return {
    success: true,
    tokenId: mintedTokenId,
    nft: {
      tokenId: mintedTokenId,
      name: result.nftData?.name ?? `ProtoMonkey #${mintedTokenId}`,
      imageUrl: result.nftData?.imageUrl ?? '',
      thumbnailUrl: result.nftData?.thumbnailUrl ?? null,
      storyTitle: result.nftData?.storyTitle ?? null,
    },
  };
}

/**
 * Get metadata for an NFT token
 *
 * @param tokenId - The token ID
 * @returns ERC-721 compatible metadata
 */
export async function getTokenMetadata(tokenId: number) {
  if (tokenId < 1 || tokenId > MAX_TOKEN_ID) {
    throw new ValidationError(
      'Invalid token ID',
      ['tokenId'],
      [{ field: 'tokenId', message: `Must be between 1 and ${MAX_TOKEN_ID}` }]
    );
  }

  const [nft] = await db
    .select({
      tokenId: nftCollection.tokenId,
      name: nftCollection.name,
      description: nftCollection.description,
      imageUrl: nftCollection.imageUrl,
      attributes: nftCollection.attributes,
      storyTitle: nftCollection.storyTitle,
      storyContent: nftCollection.storyContent,
    })
    .from(nftCollection)
    .where(eq(nftCollection.tokenId, tokenId))
    .limit(1);

  if (!nft) {
    throw new ValidationError(
      'NFT not found',
      ['tokenId'],
      [{ field: 'tokenId', message: `Token ${tokenId} not found` }]
    );
  }

  const configuredBaseUrl = process.env.NFT_METADATA_BASE_URL?.trim();
  const baseUrl =
    configuredBaseUrl && configuredBaseUrl.length > 0
      ? configuredBaseUrl
      : 'https://babylon.market';

  return {
    name: nft.name,
    description: nft.description ?? `ProtoMonkeys #${tokenId}`,
    image: nft.imageUrl,
    external_url: `${baseUrl}/nft/${tokenId}`,
    attributes: nft.attributes ?? [],
    properties: nft.storyTitle
      ? {
          story: {
            title: nft.storyTitle,
            content: nft.storyContent,
          },
        }
      : undefined,
  };
}
