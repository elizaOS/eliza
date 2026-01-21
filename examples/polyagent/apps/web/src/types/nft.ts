/**
 * NFT Types for Polyagent Top 100 Collection
 *
 * These types define the structure for NFT data throughout the application,
 * including gallery display, mint flow, and API responses.
 */

// ============================================================================
// Core NFT Types
// ============================================================================

/**
 * NFT attribute following OpenSea metadata standard
 */
export interface NftAttribute {
  trait_type: string;
  value: string | number;
}

/**
 * Basic NFT data for gallery grid display
 */
export interface NftSummary {
  tokenId: number;
  name: string;
  thumbnailUrl: string;
  imageUrl: string;
  owner: NftOwnerInfo | null;
}

/**
 * Complete NFT data for detail page
 */
export interface NftDetail {
  tokenId: number;
  name: string;
  description: string | null;
  imageUrl: string;
  thumbnailUrl: string | null;
  imageCid: string | null;
  imageResolution: string;
  metadataUri: string | null;
  story: {
    title: string | null;
    content: string | null;
  };
  attributes: NftAttribute[];
  contractAddress: string;
  chainId: number;
  currentOwner: NftOwnerInfo | null;
  originalClaim: NftClaimInfo | null;
}

/**
 * Current owner information (real-time from blockchain)
 */
export interface NftOwnerInfo {
  walletAddress: string;
  user: NftUserInfo | null;
  acquiredAt: string;
  txHash: string | null;
}

/**
 * Linked Polyagent user info
 */
export interface NftUserInfo {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
}

/**
 * Original claim information (provenance)
 */
export interface NftClaimInfo {
  claimedAt: string;
  claimerAddress: string;
  claimerUserId: string | null;
  snapshotRank: number | null;
  snapshotPoints: number | null;
  txHash: string;
}

// ============================================================================
// Eligibility & Mint Types
// ============================================================================

/**
 * User's NFT mint eligibility status
 */
export type EligibilityStatus =
  | "not_authenticated"
  | "not_eligible"
  | "eligible"
  | "already_minted";

/**
 * Eligibility check response
 */
export interface EligibilityResponse {
  eligible: boolean;
  status: EligibilityStatus;
  snapshotRank?: number;
  snapshotPoints?: number;
  snapshotTakenAt?: string;
  hasMinted: boolean;
  mintedNft?: {
    tokenId: number;
    name: string;
    thumbnailUrl: string;
    txHash: string;
  };
  currentRank?: number;
  reason?: string;
}

/**
 * Mint preparation response (contract call data with signature)
 */
export interface MintPrepareResponse {
  contractAddress: string;
  chainId: number;
  to: string;
  deadline: number;
  nonce: string;
  signature: string;
  encodedData: string;
}

/**
 * Mint confirmation request
 */
export interface MintConfirmRequest {
  txHash: string;
  walletAddress: string;
}

/**
 * Mint confirmation response
 */
export interface MintConfirmResponse {
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
// Gallery API Types
// ============================================================================

/**
 * Gallery sort options
 */
export type NftSortField = "tokenId" | "name" | "claimedAt";
export type NftSortOrder = "asc" | "desc";

/**
 * Gallery filter options
 */
export interface NftGalleryFilters {
  claimed?: boolean;
  trait?: string;
  search?: string;
}

/**
 * Gallery query parameters
 */
export interface NftGalleryQuery {
  page?: number;
  limit?: number;
  sort?: NftSortField;
  order?: NftSortOrder;
  claimed?: boolean;
  trait?: string;
  search?: string;
}

/**
 * Gallery API response
 */
export interface NftGalleryResponse {
  success: boolean;
  data: {
    nfts: NftSummary[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
    stats: {
      totalNfts: number;
      claimedCount: number;
      unclaimedCount: number;
    };
    filters: {
      traits: Array<{
        traitType: string;
        values: string[];
      }>;
    };
  };
}

/**
 * Single NFT API response
 */
export interface NftDetailResponse {
  success: boolean;
  data: NftDetail;
}

// ============================================================================
// Mint Flow UI Types
// ============================================================================

/**
 * Mint flow state machine
 */
export type MintFlowState =
  | "idle"
  | "checking_eligibility"
  | "eligible"
  | "preparing"
  | "awaiting_signature"
  | "minting"
  | "confirming"
  | "revealing"
  | "complete"
  | "error";

/**
 * Mint flow context
 */
export interface MintFlowContext {
  state: MintFlowState;
  eligibility: EligibilityResponse | null;
  txHash: string | null;
  mintedNft: MintConfirmResponse["nft"] | null;
  error: string | null;
}

// ============================================================================
// Component Props Types
// ============================================================================

/**
 * NFT Card component props
 */
export interface NftCardProps {
  nft: NftSummary;
  onClick?: () => void;
  isSelected?: boolean;
}

/**
 * NFT Grid component props
 */
export interface NftGridProps {
  nfts: NftSummary[];
  isLoading?: boolean;
  onNftClick?: (tokenId: number) => void;
}

/**
 * Mint Banner component props
 */
export interface MintBannerProps {
  onMintClick?: () => void;
}

/**
 * Reveal Modal component props
 */
export interface RevealModalProps {
  isOpen: boolean;
  nft: MintConfirmResponse["nft"] | null;
  onClose: () => void;
}
