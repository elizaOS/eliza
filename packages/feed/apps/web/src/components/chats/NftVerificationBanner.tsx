"use client";

import { getCurrentChainId } from "@feed/shared";

import { Check, ExternalLink, Loader2, Shield } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import type { ChatDetails } from "./types";

interface NftVerificationBannerProps {
  chatDetails: ChatDetails;
  currentUserId: string | undefined;
}

interface VerificationStatus {
  ownsNft: boolean;
  tokenIds: number[];
  nftRequired: boolean;
  reason?: string;
  contractAddress?: string;
  tokenId?: number | null;
  chainId?: number;
  loading: boolean;
}

export function NftVerificationBanner({
  chatDetails,
  currentUserId,
}: NftVerificationBannerProps) {
  const { getAccessToken } = useAuth();
  const [verificationStatus, setVerificationStatus] =
    useState<VerificationStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const nftRequirement = chatDetails.chat.nftRequirement;

  const checkVerification = useCallback(async () => {
    setChecking(true);
    const token = await getAccessToken();
    if (!token) {
      setVerificationStatus({
        ownsNft: false,
        tokenIds: [],
        nftRequired: true,
        reason: "Authentication required",
        loading: false,
      });
      setChecking(false);
      return;
    }

    const response = await fetch(
      `/api/chats/${chatDetails.chat.id}/nft-verification`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const data = response.ok ? await response.json() : null;
    setVerificationStatus({
      ownsNft: data?.ownsNft ?? false,
      tokenIds: data?.tokenIds ?? [],
      nftRequired: data?.nftRequired ?? true,
      reason: data?.reason,
      contractAddress: data?.contractAddress,
      tokenId: data?.tokenId,
      chainId: data?.chainId,
      loading: false,
    });
    setChecking(false);
  }, [chatDetails.chat.id, getAccessToken]);

  useEffect(() => {
    if (!nftRequirement || !currentUserId) {
      setVerificationStatus({
        ownsNft: true,
        tokenIds: [],
        nftRequired: false,
        loading: false,
      });
      return;
    }
    void checkVerification();
  }, [nftRequirement, currentUserId, checkVerification]);

  if (!nftRequirement) {
    return null;
  }

  const status = verificationStatus || {
    ownsNft: false,
    tokenIds: [],
    nftRequired: true,
    loading: true,
  };

  const EXPLORER_URLS: Record<number, string> = {
    8453: "https://basescan.org/token/",
    84532: "https://sepolia.basescan.org/token/",
    1: "https://etherscan.io/token/",
    11155111: "https://sepolia.etherscan.io/token/",
  };

  const explorerUrl = nftRequirement.contractAddress
    ? EXPLORER_URLS[nftRequirement.chainId || getCurrentChainId()] +
      nftRequirement.contractAddress
    : null;

  if (status.loading || checking) {
    return (
      <div className="border-border border-b bg-sidebar-accent/30 px-4 py-3">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Verifying NFT ownership...</span>
        </div>
      </div>
    );
  }

  if (status.ownsNft) {
    return (
      <div className="border-border border-b bg-green-500/10 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-700 text-sm dark:text-green-300">
            <Check className="h-4 w-4" />
            <span>
              You own the required NFT
              {status.tokenIds.length > 0 &&
                ` (Token${status.tokenIds.length > 1 ? "s" : ""}: ${status.tokenIds.join(", ")})`}
            </span>
          </div>
          {explorerUrl && (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary text-xs hover:text-primary/80"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="border-border border-b bg-yellow-500/10 px-4 py-3">
      <div className="flex items-start gap-3">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
        <div className="flex-1 space-y-2">
          <div className="text-sm text-yellow-700 dark:text-yellow-300">
            <strong>NFT Required:</strong> This group requires holding an NFT
            from{" "}
            <span className="font-mono text-xs">
              {nftRequirement.contractAddress.slice(0, 6)}...
              {nftRequirement.contractAddress.slice(-4)}
            </span>
            {nftRequirement.tokenId !== null &&
              ` (Token #${nftRequirement.tokenId})`}{" "}
            on {nftRequirement.chainName}
          </div>
          {status.reason && (
            <div className="text-xs text-yellow-600 dark:text-yellow-400">
              {status.reason}
            </div>
          )}
          <div className="flex items-center gap-2">
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1"
              >
                <Button variant="outline" size="sm" className="h-7 text-xs">
                  View on Explorer
                  <ExternalLink className="ml-1 h-3 w-3" />
                </Button>
              </a>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void checkVerification()}
              disabled={checking}
              className="h-7 text-xs"
            >
              {checking ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Checking...
                </>
              ) : (
                "Verify Again"
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
